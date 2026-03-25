const fs = require('fs');
const os = require('os');
const path = require('path');
const { BrowserWindow } = require('electron');
const { runIndexing } = require('../../lib/indexer');
const { processPendingVisualJobs, processPendingFaceJobs, processPendingEmbeddingJobs } = require('../../lib/indexer/index-service');
const { getMediaRoots, walkMediaFiles, getMediaFileRecord } = require('../../lib/indexer/scanner');
const { buildEvents } = require('../../lib/indexer/cluster');
const { getActiveMediaItems, replaceEvents, deleteMediaItemsByPaths } = require('../../lib/indexer/repository');

function broadcast(channel, payload) {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  });
}

function getBackgroundYieldMs() {
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  const hasFocusedWindow = windows.some((win) => win.isFocused() && !win.isMinimized());
  return hasFocusedWindow ? 60 : 0;
}

function getQueueRuntimeOptions(politeBackground = true, beforeBatch = null) {
  if (!politeBackground) {
    return {
      yieldMs: 0,
      beforeBatch: null,
    };
  }

  return {
    yieldMs: getBackgroundYieldMs(),
    beforeBatch,
  };
}

async function withReducedPriority(task) {
  const hasPriorityApi = typeof os.getPriority === 'function' && typeof os.setPriority === 'function';
  if (!hasPriorityApi) {
    return task();
  }

  let previousPriority = null;
  try {
    previousPriority = os.getPriority(process.pid);
    os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch (_) {}

  try {
    return await task();
  } finally {
    if (previousPriority != null) {
      try {
        os.setPriority(process.pid, previousPriority);
      } catch (_) {}
    }
  }
}

function createLibraryRefreshManager({ app, db, setLatestRunStats }) {
  let watchers = [];
  let refreshInFlight = null;
  let queuedReason = null;
  let watchDebounceTimer = null;
  let libraryDirty = false;
  const pendingDeletedPaths = new Set();
  const pendingChangedPaths = new Set();
  let visualQueueInFlight = null;
  let faceQueueInFlight = null;
  let embeddingQueueInFlight = null;
  let lastUserInteractionAt = 0;

  function noteUserInteraction() {
    lastUserInteractionAt = Date.now();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isWindowInteractive() {
    const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
    return windows.some((win) => win.isFocused() && !win.isMinimized() && win.isVisible());
  }

  async function waitForVisualQueueWindow() {
    while (isWindowInteractive()) {
      await sleep(800);
    }
  }

  async function waitForInteractionIdle() {
    while (isWindowInteractive() && Date.now() - lastUserInteractionAt < 1500) {
      await sleep(300);
    }
  }

  async function runRefresh(reason = 'manual') {
    try {
      libraryDirty = false;
      const isInitialLibraryBuild = getActiveMediaItems(db).length === 0;
      const { latestRun, pendingVisualJobs, pendingFaceJobs, pendingEmbeddingJobs } = await runIndexing(db, app, {
        deferVisualIndexing: true,
        deferFaceIndexing: true,
        deferSemanticEmbedding: true,
      });
      setLatestRunStats(latestRun);
      console.log(`[Indexer] Timings ms: scan=${latestRun.timingsMs.scan} process=${latestRun.timingsMs.process} rebuild=${latestRun.timingsMs.rebuild} total=${latestRun.timingsMs.total} batch=${latestRun.batchSize} toProcess=${latestRun.toProcessCount}`);
      broadcast('library-refresh-complete', { reason, latestRun, libraryDirty });
      if (pendingVisualJobs.length > 0) {
        startVisualQueue(pendingVisualJobs, pendingFaceJobs, pendingEmbeddingJobs, {
          politeBackground: !isInitialLibraryBuild,
        });
      } else if (pendingFaceJobs.length > 0) {
        startFaceQueue(pendingFaceJobs, pendingEmbeddingJobs, {
          politeBackground: !isInitialLibraryBuild,
        });
      } else if (pendingEmbeddingJobs.length > 0) {
        startEmbeddingQueue(pendingEmbeddingJobs, {
          politeBackground: !isInitialLibraryBuild,
        });
      }
      return latestRun;
    } catch (error) {
      broadcast('library-refresh-error', {
        reason,
        message: error.message || 'Unknown refresh error',
      });
      throw error;
    }
  }

  async function requestRefresh(reason = 'manual') {
    if (refreshInFlight) {
      queuedReason = queuedReason || reason;
      return refreshInFlight;
    }

    refreshInFlight = runRefresh(reason)
      .finally(async () => {
        refreshInFlight = null;
        if (queuedReason) {
          const nextReason = queuedReason;
          queuedReason = null;
          await requestRefresh(nextReason);
        }
      });

    return refreshInFlight;
  }

  async function runIncrementalRefresh(filePaths, reason = 'watch') {
    const { includeVideos } = getMediaRoots(db, app);
    const scannedFiles = Array.from(new Set((filePaths || []).filter(Boolean)))
      .map((filePath) => getMediaFileRecord(filePath, { includeVideos }))
      .filter(Boolean);

    if (scannedFiles.length === 0) {
      return {
        latestRun: {
          scannedCount: 0,
          toProcessCount: 0,
          refreshed: 0,
          eventsCount: 0,
          roots: getMediaRoots(db, app).roots,
          batchSize: 0,
          timingsMs: { scan: 0, process: 0, rebuild: 0, total: 0 },
        },
      };
    }

    libraryDirty = false;
    const result = await runIndexing(db, app, {
      deferVisualIndexing: true,
      deferFaceIndexing: true,
      deferSemanticEmbedding: true,
      scannedFiles,
      skipMarkMissing: true,
    });

    setLatestRunStats(result.latestRun);
    console.log(`[Indexer] Incremental timings ms: scan=${result.latestRun.timingsMs.scan} process=${result.latestRun.timingsMs.process} rebuild=${result.latestRun.timingsMs.rebuild} total=${result.latestRun.timingsMs.total} toProcess=${result.latestRun.toProcessCount}`);
    broadcast('library-refresh-complete', {
      reason,
      latestRun: result.latestRun,
      libraryDirty,
      incremental: true,
    });

    if (result.pendingVisualJobs.length > 0) {
      startVisualQueue(result.pendingVisualJobs, result.pendingFaceJobs, result.pendingEmbeddingJobs, {
        politeBackground: true,
      });
    } else if (result.pendingFaceJobs.length > 0) {
      startFaceQueue(result.pendingFaceJobs, result.pendingEmbeddingJobs, {
        politeBackground: true,
      });
    } else if (result.pendingEmbeddingJobs.length > 0) {
      startEmbeddingQueue(result.pendingEmbeddingJobs, {
        politeBackground: true,
      });
    }

    return result;
  }

  async function requestIncrementalRefresh(filePaths, reason = 'watch') {
    const normalizedPaths = Array.from(new Set((filePaths || []).filter(Boolean)));
    if (normalizedPaths.length === 0) return { latestRun: null };

    if (refreshInFlight) {
      normalizedPaths.forEach((filePath) => pendingChangedPaths.add(filePath));
      queuedReason = queuedReason || reason;
      return refreshInFlight;
    }

    refreshInFlight = runIncrementalRefresh(normalizedPaths, reason)
      .finally(async () => {
        refreshInFlight = null;
        if (pendingDeletedPaths.size > 0) {
          const nextDeletedPaths = Array.from(pendingDeletedPaths);
          pendingDeletedPaths.clear();
          await requestDeleteRefresh(nextDeletedPaths);
          return;
        }
        if (pendingChangedPaths.size > 0) {
          const nextChangedPaths = Array.from(pendingChangedPaths);
          pendingChangedPaths.clear();
          const nextReason = queuedReason || 'watch';
          queuedReason = null;
          await requestIncrementalRefresh(nextChangedPaths, nextReason);
          return;
        }
        if (queuedReason) {
          const nextReason = queuedReason;
          queuedReason = null;
          await requestRefresh(nextReason);
        }
      });

    return refreshInFlight;
  }

  async function requestDeleteRefresh(paths) {
    const normalizedPaths = Array.from(new Set((paths || []).filter(Boolean)));
    if (normalizedPaths.length === 0) return { deletedCount: 0 };

    if (refreshInFlight) {
      normalizedPaths.forEach((filePath) => pendingDeletedPaths.add(filePath));
      queuedReason = queuedReason || 'delete';
      return refreshInFlight;
    }

    refreshInFlight = (async () => {
      const result = deleteMediaItemsByPaths(db, normalizedPaths);
      if (result.deletedCount > 0) {
        const activeRecords = getActiveMediaItems(db);
        const events = buildEvents(activeRecords);
        replaceEvents(db, events);
      }
      libraryDirty = pendingChangedPaths.size > 0;
      broadcast('library-refresh-complete', {
        reason: 'delete',
        deletedCount: result.deletedCount,
        libraryDirty,
      });
      return result;
    })().finally(async () => {
      refreshInFlight = null;
      if (pendingDeletedPaths.size > 0) {
        const nextPaths = Array.from(pendingDeletedPaths);
        pendingDeletedPaths.clear();
        await requestDeleteRefresh(nextPaths);
        return;
      }
      if (pendingChangedPaths.size > 0) {
        const nextChangedPaths = Array.from(pendingChangedPaths);
        pendingChangedPaths.clear();
        const nextReason = queuedReason && queuedReason !== 'delete' ? queuedReason : 'watch';
        queuedReason = null;
        await requestIncrementalRefresh(nextChangedPaths, nextReason);
        return;
      }
      queuedReason = null;
    });

    return refreshInFlight;
  }

  async function startVisualQueue(jobs, existingFaceJobs = [], pendingEmbeddingJobs = [], options = {}) {
    if (visualQueueInFlight) return visualQueueInFlight;
    visualQueueInFlight = (async () => {
      const runtime = getQueueRuntimeOptions(options.politeBackground !== false, waitForVisualQueueWindow);
      broadcast('visual-indexing-started', { total: jobs.length });
      const result = await withReducedPriority(() => processPendingVisualJobs(db, jobs, Object.assign({
        onProgress: (data) => {
          broadcast('visual-indexing-progress', data);
        },
      }, runtime.beforeBatch ? { beforeBatch: waitForVisualQueueWindow } : {}, {
        yieldMs: runtime.yieldMs,
      })));
      console.log(`[VisualIndex] Completed ${result.total} jobs in ${result.durationMs}ms`);
      broadcast('visual-indexing-complete', result);
      const combinedFaceJobs = [...(existingFaceJobs || []), ...(result.pendingFaceJobs || [])];
      if (combinedFaceJobs.length > 0) {
        await startFaceQueue(combinedFaceJobs, pendingEmbeddingJobs, options);
      } else if (pendingEmbeddingJobs.length > 0) {
        await startEmbeddingQueue(pendingEmbeddingJobs, options);
      }
    })().finally(() => {
      visualQueueInFlight = null;
    });
    return visualQueueInFlight;
  }

  async function startFaceQueue(jobs, pendingEmbeddingJobs = [], options = {}) {
    if (faceQueueInFlight) return faceQueueInFlight;
    faceQueueInFlight = (async () => {
      const runtime = getQueueRuntimeOptions(options.politeBackground !== false, waitForInteractionIdle);
      broadcast('face-indexing-started', { total: jobs.length });
      const result = await withReducedPriority(() => processPendingFaceJobs(db, jobs, Object.assign({
        onProgress: (data) => {
          broadcast('face-indexing-progress', data);
        },
      }, runtime.beforeBatch ? { beforeBatch: waitForInteractionIdle } : {}, {
        yieldMs: runtime.yieldMs,
      })));
      console.log(`[FaceIndex] Completed ${result.total} jobs in ${result.durationMs}ms`);
      broadcast('face-indexing-complete', result);
      if (pendingEmbeddingJobs.length > 0) {
        await startEmbeddingQueue(pendingEmbeddingJobs, options);
      }
    })().finally(() => {
      faceQueueInFlight = null;
    });
    return faceQueueInFlight;
  }

  async function startEmbeddingQueue(jobs, options = {}) {
    if (embeddingQueueInFlight) return embeddingQueueInFlight;
    embeddingQueueInFlight = (async () => {
      const runtime = getQueueRuntimeOptions(options.politeBackground !== false, waitForInteractionIdle);
      broadcast('semantic-indexing-started', { total: jobs.length });
      const result = await withReducedPriority(() => processPendingEmbeddingJobs(db, jobs, Object.assign({
        onProgress: (data) => {
          broadcast('semantic-indexing-progress', data);
        },
      }, runtime.beforeBatch ? { beforeBatch: waitForInteractionIdle } : {}, {
        yieldMs: runtime.yieldMs,
      })));
      console.log(`[SemanticIndex] Completed ${result.total} jobs in ${result.durationMs}ms`);
      broadcast('semantic-indexing-complete', result);
    })().finally(() => {
      embeddingQueueInFlight = null;
    });
    return embeddingQueueInFlight;
  }

  function clearWatchers() {
    watchers.forEach((watcher) => {
      try { watcher.close(); } catch (_) {}
    });
    watchers = [];
  }

  function scheduleWatcherRefresh() {
    if (watchDebounceTimer) clearTimeout(watchDebounceTimer);
    watchDebounceTimer = setTimeout(() => {
      const deletedPaths = Array.from(pendingDeletedPaths).filter((filePath) => !fs.existsSync(filePath));
      pendingDeletedPaths.clear();

      if (deletedPaths.length > 0) {
        requestDeleteRefresh(deletedPaths).catch((error) => {
          console.error('[LibraryRefresh] Delete-triggered refresh failed:', error);
        });
      }

      const changedPaths = Array.from(pendingChangedPaths).filter((filePath) => fs.existsSync(filePath));
      pendingChangedPaths.clear();
      if (changedPaths.length > 0) {
        requestIncrementalRefresh(changedPaths, 'watch').catch((error) => {
          libraryDirty = true;
          broadcast('library-change-detected', { reason: 'watch', libraryDirty });
          console.error('[LibraryRefresh] Incremental add/change refresh failed:', error);
        });
      }
    }, 1000);
  }

  function startWatching() {
    clearWatchers();

    const { roots } = getMediaRoots(db, app);
    roots.forEach((root) => {
      if (!root || !fs.existsSync(root)) return;
      try {
        const watcher = fs.watch(root, { recursive: true }, (_eventType, filename) => {
          if (!filename) return;
          const fullPath = path.join(root, filename.toString());
          if (fs.existsSync(fullPath)) {
            pendingChangedPaths.add(fullPath);
          } else {
            pendingDeletedPaths.add(fullPath);
          }
          scheduleWatcherRefresh();
        });
        watchers.push(watcher);
      } catch (error) {
        console.error(`[LibraryRefresh] Failed to watch ${root}:`, error.message);
      }
    });
  }

  function restartWatching() {
    startWatching();
  }

  async function checkForStartupChanges() {
    if (refreshInFlight || visualQueueInFlight || faceQueueInFlight || embeddingQueueInFlight) return { changed: false };

    const { roots, includeVideos } = getMediaRoots(db, app);
    const scanned = roots.flatMap((root) => walkMediaFiles(root, { includeVideos }));
    const scannedMap = new Map(scanned.map((file) => [file.path, file]));
    const indexedRows = db.prepare(`
      SELECT path, mtime_ms, size
      FROM media_items
      WHERE is_missing = 0
    `).all();

    let changed = false;
    const changedPaths = [];
    const deletedPaths = [];

    for (const row of indexedRows) {
      const scannedFile = scannedMap.get(row.path);
      if (!scannedFile) {
        changed = true;
        deletedPaths.push(row.path);
        continue;
      }
      if (scannedFile.mtimeMs !== row.mtime_ms || scannedFile.size !== row.size) {
        changed = true;
        changedPaths.push(row.path);
      }
      scannedMap.delete(row.path);
    }

    if (scannedMap.size > 0) {
      changed = true;
      changedPaths.push(...Array.from(scannedMap.keys()));
    }

    if (changed) {
      if (deletedPaths.length > 0) {
        await requestDeleteRefresh(deletedPaths);
      }
      if (changedPaths.length > 0) {
        await requestIncrementalRefresh(changedPaths, 'startup-scan');
      }
    }

    return {
      changed,
      addedOrChangedCount: changedPaths.length,
    };
  }

  function dispose() {
    if (watchDebounceTimer) clearTimeout(watchDebounceTimer);
    clearWatchers();
  }

  return {
    requestRefresh,
    requestIncrementalRefresh,
    noteUserInteraction,
    startWatching,
    restartWatching,
    checkForStartupChanges,
    isDirty: () => libraryDirty,
    dispose,
  };
}

module.exports = {
  createLibraryRefreshManager,
};

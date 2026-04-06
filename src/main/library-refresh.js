const fs = require('fs');
const os = require('os');
const path = require('path');
const { BrowserWindow } = require('electron');
const { runIndexing } = require('../../lib/indexer');
const { processMetadataBatches, processPendingVisualJobs, processPendingFaceJobs, applyProcessedFaceBatch, processPendingEmbeddingJobs, createStreamingFaceQueue } = require('../../lib/indexer/index-service');
const { getMediaRoots, walkMediaFilesAsync, getMediaFileRecord } = require('../../lib/indexer/scanner');
const { buildEvents } = require('../../lib/indexer/cluster');
const {
  getActiveMediaItems,
  replaceEvents,
  deleteMediaItemsByPaths,
  updateMediaEmbedding,
  updateMediaVisualAnalysis,
  purgeAnimalFalsePositivePeople,
  replacePendingIndexJobs,
  loadPendingIndexJobs,
  completeIndexJobs,
} = require('../../lib/indexer/repository');

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
  return hasFocusedWindow ? 120 : 0;
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
  } catch (_) { }

  try {
    return await task();
  } finally {
    if (previousPriority != null) {
      try {
        os.setPriority(process.pid, previousPriority);
      } catch (_) { }
    }
  }
}

function createLibraryRefreshManager({ app, db, embeddingWorker, visionFaceWorker, mediaAssetWorker, setLatestRunStats }) {
  const BENCHMARK_HISTORY_KEY = 'index_benchmark_history';
  const BENCHMARK_HISTORY_LIMIT = 20;
  let watchers = [];
  let refreshInFlight = null;
  let queuedReason = null;
  let watchDebounceTimer = null;
  let deferredVisualTimer = null;
  let suppressWatcherEventsUntil = 0;
  let libraryDirty = false;
  const pendingDeletedPaths = new Set();
  const pendingChangedPaths = new Set();
  let backgroundPipelineInFlight = false;
  let visualQueueInFlight = null;
  let faceQueueInFlight = null;
  let embeddingQueueInFlight = null;
  let lastUserInteractionAt = 0;
  let latestPipelineBenchmark = null;
  let benchmarkHistory = [];
  const canUseFaceWorker = true;

  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(BENCHMARK_HISTORY_KEY);
    benchmarkHistory = row?.value ? JSON.parse(row.value) : [];
    if (!Array.isArray(benchmarkHistory)) benchmarkHistory = [];
  } catch (_) {
    benchmarkHistory = [];
  }

  try {
    const cleanup = purgeAnimalFalsePositivePeople(db);
    if (cleanup.deletedPeople > 0) {
      console.log(`[PeopleCleanup] Removed ${cleanup.deletedPeople} likely animal false-positive identities across ${cleanup.resetMedia} media item(s)`);
    }
  } catch (error) {
    console.warn('[PeopleCleanup] Failed to purge animal false-positive identities:', error.message);
  }

  function queueCountsFromJobs(visualJobs, faceJobs, embeddingJobs) {
    return {
      visual: Array.isArray(visualJobs) ? visualJobs.length : 0,
      face: Array.isArray(faceJobs) ? faceJobs.length : 0,
      embedding: Array.isArray(embeddingJobs) ? embeddingJobs.length : 0,
    };
  }

  function persistBenchmarkSnapshot(snapshot) {
    latestPipelineBenchmark = snapshot;
    benchmarkHistory = [snapshot, ...benchmarkHistory].slice(0, BENCHMARK_HISTORY_LIMIT);
    try {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
        BENCHMARK_HISTORY_KEY,
        JSON.stringify(benchmarkHistory)
      );
    } catch (error) {
      console.warn('[Benchmark] Failed to persist benchmark snapshot:', error.message);
    }
  }

  function logBenchmarkSnapshot(snapshot) {
    const summary = [
      `reason=${snapshot.reason}`,
      `scan=${snapshot.quickInsert?.durationMs || 0}ms`,
      `metadata=${snapshot.metadata?.durationMs || 0}ms`,
      `visual=${snapshot.visual?.durationMs || 0}ms`,
      `face=${snapshot.face?.durationMs || 0}ms`,
      `embedding=${snapshot.embedding?.durationMs || 0}ms`,
      `total=${snapshot.totalDurationMs || 0}ms`,
    ].join(' ');
    console.log(`[Benchmark] ${summary}`);
  }

  function finalizeBenchmark(baseSnapshot, stageStats = {}) {
    const snapshot = {
      id: `benchmark_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      createdAtMs: Date.now(),
      ...baseSnapshot,
      ...stageStats,
    };
    snapshot.totalDurationMs =
      (snapshot.quickInsert?.durationMs || 0) +
      (snapshot.metadata?.durationMs || 0) +
      (snapshot.visual?.durationMs || 0) +
      (snapshot.face?.durationMs || 0) +
      (snapshot.embedding?.durationMs || 0);
    persistBenchmarkSnapshot(snapshot);
    logBenchmarkSnapshot(snapshot);
    return snapshot;
  }

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

  function isUserActivelyInteracting(thresholdMs = 1500) {
    return isWindowInteractive() && (Date.now() - lastUserInteractionAt) < thresholdMs;
  }

  async function waitForVisualQueueWindow() {
    while (isUserActivelyInteracting(1800)) {
      await sleep(400);
    }
  }

  async function waitForInteractionIdle() {
    while (isWindowInteractive() && Date.now() - lastUserInteractionAt < 1500) {
      await sleep(300);
    }
  }

  async function waitForAnalysisIdle() {
    while (isUserActivelyInteracting(1200)) {
      await sleep(300);
    }
  }

  function shouldDeferVisualStage(visualJobs, options = {}) {
    const count = Array.isArray(visualJobs) ? visualJobs.length : 0;
    if (count === 0) return false;
    if (options.initialLibraryBuild) return true;
    return count >= 12;
  }

  function shouldDeferEmbeddingStage(embeddingJobs, options = {}) {
    const count = Array.isArray(embeddingJobs) ? embeddingJobs.length : 0;
    if (count === 0) return false;
    if (options.initialLibraryBuild) return true;
    return count >= 16;
  }

  function filterSkippableEmbeddingJobs(embeddingJobs) {
    const jobs = Array.isArray(embeddingJobs) ? embeddingJobs.filter(Boolean) : [];
    const keptJobs = jobs.filter((job) => job.mediaType !== 'video');
    if (keptJobs.length !== jobs.length) {
      replacePendingIndexJobs(db, 'embedding', keptJobs);
    }
    return keptJobs;
  }

  function isThumbnailOnlyVisualJob(job) {
    return Boolean(job)
      && job.mediaType === 'video'
      && job.skipDetection === true;
  }

  async function runDeferredVisualResume() {
    if (refreshInFlight || visualQueueInFlight || faceQueueInFlight || embeddingQueueInFlight) {
      scheduleDeferredVisualResume(3000);
      return;
    }

    if (isUserActivelyInteracting(1800)) {
      scheduleDeferredVisualResume(2500);
      return;
    }

    const resumedVisualJobs = loadPendingIndexJobs(db, 'visual');
    const resumedEmbeddingJobs = filterSkippableEmbeddingJobs(loadPendingIndexJobs(db, 'embedding'));
    if (resumedVisualJobs.length === 0 && resumedEmbeddingJobs.length === 0) {
      return;
    }

    if (resumedVisualJobs.length > 0) {
      console.log(`[VisualIndex] Deferring deep visual analysis paid off first-use latency; resuming ${resumedVisualJobs.length} jobs in idle mode`);
    }
    if (resumedEmbeddingJobs.length > 0) {
      console.log(`[SemanticIndex] Deferring embeddings paid off first-use latency; resuming ${resumedEmbeddingJobs.length} jobs in idle mode`);
    }
    await startParallelPipeline(resumedVisualJobs, [], resumedEmbeddingJobs, {
      politeBackground: true,
      deferVisualStage: false,
      deferEmbeddingStage: false,
    });
  }

  function scheduleDeferredVisualResume(delayMs = 3000) {
    if (deferredVisualTimer) return;
    deferredVisualTimer = setTimeout(async () => {
      deferredVisualTimer = null;
      try {
        await runDeferredVisualResume();
      } catch (error) {
        console.error('[VisualIndex] Deferred visual resume failed:', error);
        scheduleDeferredVisualResume(10000);
      }
    }, delayMs);
  }

  async function runFaceQueue(jobs, runtime) {
    const pendingJobs = Array.isArray(jobs) ? jobs.filter(Boolean) : [];
    if (pendingJobs.length === 0) {
      return { total: 0, durationMs: 0 };
    }

    if (canUseFaceWorker && visionFaceWorker && typeof visionFaceWorker.processFaceJobs === 'function') {
      try {
        if (runtime.beforeBatch) {
          await runtime.beforeBatch();
        }
        const workerResult = await visionFaceWorker.processFaceJobs(pendingJobs, {
          onProgress: (data) => {
            broadcast('face-indexing-progress', data);
          },
        });
        const applyResult = await applyProcessedFaceBatch(db, workerResult.processed || [], {
          beforeBatch: runtime.beforeBatch ? waitForInteractionIdle : null,
          yieldMs: runtime.yieldMs,
        });
        return {
          total: applyResult.total || workerResult.total || pendingJobs.length,
          durationMs: (workerResult.durationMs || 0) + (applyResult.durationMs || 0),
        };
      } catch (error) {
        console.warn('[FaceIndex] Vision worker face processing failed, falling back to main process:', error.message);
      }
    }

    return processPendingFaceJobs(db, pendingJobs, Object.assign({
      onProgress: (data) => {
        broadcast('face-indexing-progress', data);
      },
    }, runtime.beforeBatch ? { beforeBatch: waitForInteractionIdle } : {}, {
      yieldMs: runtime.yieldMs,
    }));
  }

  async function runRefresh(reason = 'manual', { scannedFiles = null } = {}) {
    try {
      libraryDirty = false;
      const isInitialLibraryBuild = getActiveMediaItems(db).length === 0;

      // ---- Stage A: Quick-insert (returns in ~1-3s) ----
      const quickResult = await runIndexing(db, app, {
        reason,
        deferVisualIndexing: true,
        deferFaceIndexing: true,
        deferSemanticEmbedding: true,
        scannedFiles,
        quickInsertOnly: true,
      });
      setLatestRunStats(quickResult.latestRun);
      console.log(`[Indexer] Stage A (quick-insert): ${quickResult.latestRun.scannedCount} files, ${quickResult.latestRun.timingsMs.total}ms`);
      broadcast('library-refresh-complete', { reason, latestRun: quickResult.latestRun, libraryDirty });

      // ---- Stage B: Background metadata + parallel pipeline (fire-and-forget) ----
      const backgroundScannedFiles = quickResult.scannedFiles || scannedFiles;
      startBackgroundProcessing(backgroundScannedFiles, isInitialLibraryBuild, reason, quickResult).catch((err) => {
        console.error('[Pipeline] Background processing error:', err);
        broadcast('library-refresh-error', { reason, message: err.message || 'Background processing error' });
      });

      return quickResult.latestRun;
    } catch (error) {
      broadcast('library-refresh-error', {
        reason,
        message: error.message || 'Unknown refresh error',
      });
      throw error;
    }
  }

  async function startBackgroundProcessing(scannedFiles, isInitialLibraryBuild, reason, quickResult = null) {
    backgroundPipelineInFlight = true;
    try {
    const polite = true;
    const runtimeOpts = getQueueRuntimeOptions(polite, waitForInteractionIdle);
    const yieldMs = polite ? Math.max(runtimeOpts.yieldMs, 30) : 0;
    const cpus = require('os').cpus().length;
    const batchSize = Math.max(2, Math.min(8, Math.floor(cpus / 1.5)));
    const benchmarkBase = {
      reason,
      runType: 'background-refresh',
      politeBackground: polite,
      initialLibraryBuild: isInitialLibraryBuild,
      quickInsert: quickResult ? {
        scannedCount: quickResult.latestRun?.scannedCount || 0,
        durationMs: quickResult.latestRun?.timingsMs?.total || 0,
      } : null,
    };

    broadcast('metadata-processing-started', { total: 0 });
    const metadataResult = await withReducedPriority(() =>
      processMetadataBatches(db, app, scannedFiles, {
        batchSize,
        yieldMs,
        beforeBatch: polite ? waitForInteractionIdle : null,
        mediaAssetWorker,
        onProgress: (data) => {
          broadcast('metadata-batch-progress', data);
        },
        onRefresh: (data) => {
          broadcast('metadata-batch-ready', data);
        },
      })
    );

    console.log(`[Indexer] Stage B (metadata): ${metadataResult.latestRun.toProcessCount} files in ${metadataResult.latestRun.timingsMs.total}ms`);
    broadcast('metadata-processing-complete', metadataResult.latestRun);

    const { pendingVisualJobs, pendingFaceJobs, pendingEmbeddingJobs } = metadataResult;
    benchmarkBase.metadata = {
      scannedCount: metadataResult.latestRun?.scannedCount || 0,
      processedCount: metadataResult.latestRun?.toProcessCount || 0,
      durationMs: metadataResult.latestRun?.timingsMs?.total || 0,
      batchSize,
      queues: queueCountsFromJobs(pendingVisualJobs, pendingFaceJobs, pendingEmbeddingJobs),
    };
    replacePendingIndexJobs(db, 'visual', pendingVisualJobs);
    replacePendingIndexJobs(db, 'face', pendingFaceJobs);
    replacePendingIndexJobs(db, 'embedding', pendingEmbeddingJobs);
      const hasWork = pendingVisualJobs.length > 0 || pendingFaceJobs.length > 0 || pendingEmbeddingJobs.length > 0;
      if (hasWork) {
        const deferVisualStage = shouldDeferVisualStage(pendingVisualJobs, { initialLibraryBuild: isInitialLibraryBuild });
        const deferEmbeddingStage = shouldDeferEmbeddingStage(pendingEmbeddingJobs, { initialLibraryBuild: isInitialLibraryBuild });
        const stageStats = await startParallelPipeline(pendingVisualJobs, pendingFaceJobs, pendingEmbeddingJobs, {
          politeBackground: polite,
          deferVisualStage,
          deferEmbeddingStage,
        });
        if (deferVisualStage || deferEmbeddingStage) {
          scheduleDeferredVisualResume(isInitialLibraryBuild ? 5000 : 2500);
        }
        finalizeBenchmark(benchmarkBase, stageStats);
      } else {
        finalizeBenchmark(benchmarkBase);
      }
    } finally {
      backgroundPipelineInFlight = false;
      if (pendingDeletedPaths.size > 0) {
        const nextDeletedPaths = Array.from(pendingDeletedPaths);
        pendingDeletedPaths.clear();
        await requestDeleteRefresh(nextDeletedPaths);
      } else if (pendingChangedPaths.size > 0) {
        const nextChangedPaths = Array.from(pendingChangedPaths);
        pendingChangedPaths.clear();
        const nextReason = queuedReason || 'watch';
        queuedReason = null;
        await requestIncrementalRefresh(nextChangedPaths, nextReason);
      }
    }
  }

  async function requestRefresh(reason = 'manual', options = {}) {
    if (refreshInFlight) {
      queuedReason = queuedReason || reason;
      return refreshInFlight;
    }

    refreshInFlight = runRefresh(reason, options)
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
      reason,
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

      const hasWork = result.pendingVisualJobs.length > 0 || result.pendingFaceJobs.length > 0 || result.pendingEmbeddingJobs.length > 0;
      if (hasWork) {
        replacePendingIndexJobs(db, 'visual', result.pendingVisualJobs);
        replacePendingIndexJobs(db, 'face', result.pendingFaceJobs);
        replacePendingIndexJobs(db, 'embedding', result.pendingEmbeddingJobs);
        const deferVisualStage = shouldDeferVisualStage(result.pendingVisualJobs);
        const deferEmbeddingStage = shouldDeferEmbeddingStage(result.pendingEmbeddingJobs);
        startParallelPipeline(result.pendingVisualJobs, result.pendingFaceJobs, result.pendingEmbeddingJobs, {
          politeBackground: true,
          deferVisualStage,
          deferEmbeddingStage,
        }).catch((err) => {
          console.error('[Pipeline] Incremental pipeline error:', err);
        });
        if (deferVisualStage || deferEmbeddingStage) {
          scheduleDeferredVisualResume(2500);
        }
      }

    return result;
  }

  async function requestIncrementalRefresh(filePaths, reason = 'watch') {
    const normalizedPaths = Array.from(new Set((filePaths || []).filter(Boolean)));
    if (normalizedPaths.length === 0) return { latestRun: null };

    if (refreshInFlight || backgroundPipelineInFlight) {
      normalizedPaths.forEach((filePath) => pendingChangedPaths.add(filePath));
      queuedReason = queuedReason || reason;
      return refreshInFlight || Promise.resolve({ latestRun: null, queued: true });
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

    if (refreshInFlight || backgroundPipelineInFlight) {
      normalizedPaths.forEach((filePath) => pendingDeletedPaths.add(filePath));
      queuedReason = queuedReason || 'delete';
      return refreshInFlight || Promise.resolve({ deletedCount: 0, queued: true });
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

  async function startParallelPipeline(visualJobs, existingFaceJobs = [], embeddingJobs = [], options = {}) {
    const polite = options.politeBackground !== false;
    const deferVisualStage = options.deferVisualStage === true;
    const deferEmbeddingStage = options.deferEmbeddingStage === true;
    const allVisualJobs = Array.isArray(visualJobs) ? visualJobs.filter(Boolean) : [];
    const detectionVisualJobs = allVisualJobs.filter((job) => !isThumbnailOnlyVisualJob(job));
    const thumbnailVisualJobs = allVisualJobs.filter((job) => isThumbnailOnlyVisualJob(job));
    const visualRuntime = getQueueRuntimeOptions(polite, waitForVisualQueueWindow);
    const faceRuntime = getQueueRuntimeOptions(polite, waitForInteractionIdle);
    const embeddingRuntime = getQueueRuntimeOptions(polite, waitForAnalysisIdle);
    const pendingEmbeddingJobs = Array.isArray(embeddingJobs) ? embeddingJobs.filter(Boolean) : [];
    const stageStats = {
      visual: {
        queuedCount: allVisualJobs.length,
        durationMs: 0,
        workerMode: Boolean(visionFaceWorker && typeof visionFaceWorker.processVisualJobs === 'function'),
        deferred: deferVisualStage,
      },
      face: {
        queuedCount: Array.isArray(existingFaceJobs) ? existingFaceJobs.length : 0,
        durationMs: 0,
        workerMode: Boolean(canUseFaceWorker && visionFaceWorker && typeof visionFaceWorker.processFaceJobs === 'function'),
      },
      embedding: {
        queuedCount: pendingEmbeddingJobs.length,
        durationMs: 0,
        workerMode: Boolean(embeddingWorker && typeof embeddingWorker.processEmbeddingJobs === 'function'),
        deferred: deferEmbeddingStage,
      },
    };

    if (visionFaceWorker && typeof visionFaceWorker.processVisualJobs === 'function') {
      const pendingFaceJobs = [...existingFaceJobs];

      if (!deferVisualStage && allVisualJobs.length > 0) {
        broadcast('visual-indexing-started', { total: allVisualJobs.length });
        visualQueueInFlight = withReducedPriority(async () => {
          const visualStartedAt = Date.now();
          let detectionCurrent = 0;
          let thumbnailCurrent = 0;
          const totalVisual = allVisualJobs.length;
          const emitCombinedProgress = () => {
            const current = detectionCurrent + thumbnailCurrent;
            broadcast('visual-indexing-progress', {
              current,
              total: totalVisual,
              percentage: totalVisual > 0 ? Math.round((current / totalVisual) * 100) : 100,
            });
          };

          const runDetectionJobs = async () => {
            if (detectionVisualJobs.length === 0) {
              return { total: 0, processed: [], pendingFaceJobs: [] };
            }
            if (polite && typeof visualRuntime.beforeBatch === 'function') {
              await visualRuntime.beforeBatch();
            }
            try {
              const result = await visionFaceWorker.processVisualJobs(detectionVisualJobs, {
                onProgress: (data) => {
                  detectionCurrent = data.current || 0;
                  emitCombinedProgress();
                },
              });
              for (const item of result.processed || []) {
                if (!item || !item.mediaId) continue;
                updateMediaVisualAnalysis(db, item.mediaId, item.analysis || { tags: '', faceCount: 0 }, {
                  faceIndexComplete: !item.needsFaceIndexing,
                });
                if (item.faceJob) {
                  pendingFaceJobs.push(item.faceJob);
                }
              }
              detectionCurrent = detectionVisualJobs.length;
              emitCombinedProgress();
              return {
                total: result.total || detectionVisualJobs.length,
                processed: result.processed || [],
                pendingFaceJobs: [],
              };
            } catch (error) {
              console.warn('[VisualIndex] Vision worker failed, falling back to main process:', error.message);
              const result = await processPendingVisualJobs(db, detectionVisualJobs, Object.assign({
                onProgress: (data) => {
                  detectionCurrent = data.current || 0;
                  emitCombinedProgress();
                },
              }, visualRuntime.beforeBatch ? { beforeBatch: waitForVisualQueueWindow } : {}, {
                yieldMs: visualRuntime.yieldMs,
              }));
              detectionCurrent = detectionVisualJobs.length;
              emitCombinedProgress();
              return result;
            }
          };

          const runThumbnailJobs = async () => {
            if (thumbnailVisualJobs.length === 0) {
              return { total: 0, pendingFaceJobs: [] };
            }
            const result = await processPendingVisualJobs(db, thumbnailVisualJobs, {
              onProgress: (data) => {
                thumbnailCurrent = data.current || 0;
                emitCombinedProgress();
              },
              yieldMs: 0,
            });
            thumbnailCurrent = thumbnailVisualJobs.length;
            emitCombinedProgress();
            return result;
          };

          const [detectionResult, thumbnailResult] = await Promise.all([
            runDetectionJobs(),
            runThumbnailJobs(),
          ]);

          if (Array.isArray(detectionResult.pendingFaceJobs) && detectionResult.pendingFaceJobs.length > 0) {
            pendingFaceJobs.push(...detectionResult.pendingFaceJobs);
          }
          if (Array.isArray(thumbnailResult.pendingFaceJobs) && thumbnailResult.pendingFaceJobs.length > 0) {
            pendingFaceJobs.push(...thumbnailResult.pendingFaceJobs);
          }

          return {
            total: (detectionResult.total || 0) + (thumbnailResult.total || 0),
            durationMs: Date.now() - visualStartedAt,
          };
        })
          .then((result) => {
            console.log(`[VisualIndex] Completed ${result.total} jobs in ${result.durationMs}ms`);
            stageStats.visual.durationMs = result.durationMs || 0;
            stageStats.visual.processedCount = result.total || allVisualJobs.length;
            broadcast('visual-indexing-complete', result);
            completeIndexJobs(db, 'visual', allVisualJobs);
            if (pendingFaceJobs.length > 0) {
              replacePendingIndexJobs(db, 'face', pendingFaceJobs);
              stageStats.face.queuedCount = pendingFaceJobs.length;
            }
          })
          .finally(() => { visualQueueInFlight = null; });
        await visualQueueInFlight;
      }

      if (pendingFaceJobs.length > 0) {
        broadcast('face-indexing-started', { total: pendingFaceJobs.length });
        faceQueueInFlight = withReducedPriority(async () => {
          return runFaceQueue(pendingFaceJobs, faceRuntime);
        })
          .then((result) => {
            console.log(`[FaceIndex] Completed ${result.total} jobs in ${result.durationMs}ms`);
            stageStats.face.durationMs = result.durationMs || 0;
            stageStats.face.processedCount = result.total || pendingFaceJobs.length;
            broadcast('face-indexing-complete', result);
            completeIndexJobs(db, 'face', pendingFaceJobs);
          })
          .finally(() => { faceQueueInFlight = null; });
        await faceQueueInFlight;
      }

      if (deferEmbeddingStage || pendingEmbeddingJobs.length === 0) {
        return stageStats;
      }
    } else {
    const foregroundPromises = [];

    // --- Streaming face queue: receives jobs from both existingFaceJobs
    //     and new discoveries from the visual pipeline in real-time. ---
      const hasFaceWork = existingFaceJobs.length > 0;
    let streamingFace = null;

    if (hasFaceWork) {
      let faceStartBroadcast = false;
      streamingFace = createStreamingFaceQueue(db, Object.assign({
        onProgress: (data) => {
          if (!faceStartBroadcast) {
            faceStartBroadcast = true;
            broadcast('face-indexing-started', { total: data.total });
          }
          broadcast('face-indexing-progress', data);
        },
      }, faceRuntime.beforeBatch ? { beforeBatch: waitForInteractionIdle } : {}, {
        yieldMs: faceRuntime.yieldMs,
      }));
      if (existingFaceJobs.length > 0) {
        broadcast('face-indexing-started', { total: existingFaceJobs.length });
        faceStartBroadcast = true;
      }
      for (const job of existingFaceJobs) streamingFace.push(job);

      faceQueueInFlight = withReducedPriority(() => streamingFace.waitUntilDone())
        .then((result) => {
          console.log(`[FaceIndex] Completed ${result.total} jobs in ${result.durationMs}ms`);
          stageStats.face.durationMs = result.durationMs || 0;
          stageStats.face.processedCount = result.total || existingFaceJobs.length;
          broadcast('face-indexing-complete', result);
          completeIndexJobs(db, 'face', existingFaceJobs);
        })
        .finally(() => { faceQueueInFlight = null; });
      foregroundPromises.push(faceQueueInFlight);
    }

    // --- Visual queue: runs DETR detection, streams discovered face jobs
    //     into the streaming face queue as each batch completes. ---
    if (!deferVisualStage && allVisualJobs.length > 0) {
      broadcast('visual-indexing-started', { total: allVisualJobs.length });
      visualQueueInFlight = withReducedPriority(async () => {
        const visualStartedAt = Date.now();
        let detectionCurrent = 0;
        let thumbnailCurrent = 0;
        const totalVisual = allVisualJobs.length;
        const emitCombinedProgress = () => {
          const current = detectionCurrent + thumbnailCurrent;
          broadcast('visual-indexing-progress', {
            current,
            total: totalVisual,
            percentage: totalVisual > 0 ? Math.round((current / totalVisual) * 100) : 100,
          });
        };

        const detectionPromise = detectionVisualJobs.length > 0
          ? processPendingVisualJobs(db, detectionVisualJobs, Object.assign({
            onProgress: (data) => {
              detectionCurrent = data.current || 0;
              emitCombinedProgress();
            },
            onFaceJob: streamingFace
              ? (job) => streamingFace.push(job)
              : null,
          }, visualRuntime.beforeBatch ? { beforeBatch: waitForVisualQueueWindow } : {}, {
            yieldMs: visualRuntime.yieldMs,
          }))
          : Promise.resolve({ total: 0, pendingFaceJobs: [] });

        const thumbnailPromise = thumbnailVisualJobs.length > 0
          ? processPendingVisualJobs(db, thumbnailVisualJobs, {
            onProgress: (data) => {
              thumbnailCurrent = data.current || 0;
              emitCombinedProgress();
            },
            yieldMs: 0,
          })
          : Promise.resolve({ total: 0, pendingFaceJobs: [] });

        const [detectionResult, thumbnailResult] = await Promise.all([detectionPromise, thumbnailPromise]);
        detectionCurrent = detectionVisualJobs.length;
        thumbnailCurrent = thumbnailVisualJobs.length;
        emitCombinedProgress();
        return {
          total: (detectionResult.total || 0) + (thumbnailResult.total || 0),
          durationMs: Date.now() - visualStartedAt,
          pendingFaceJobs: [
            ...(detectionResult.pendingFaceJobs || []),
            ...(thumbnailResult.pendingFaceJobs || []),
          ],
        };
      })
        .then((result) => {
          console.log(`[VisualIndex] Completed ${result.total} jobs in ${result.durationMs}ms`);
          stageStats.visual.durationMs = result.durationMs || 0;
          stageStats.visual.processedCount = result.total || allVisualJobs.length;
          broadcast('visual-indexing-complete', result);
          completeIndexJobs(db, 'visual', allVisualJobs);
          if (streamingFace) streamingFace.markProducerDone();

          if (!streamingFace && result.pendingFaceJobs?.length > 0) {
            replacePendingIndexJobs(db, 'face', result.pendingFaceJobs);
            stageStats.face.queuedCount = result.pendingFaceJobs.length;
            return startLegacyFaceQueue(result.pendingFaceJobs, options);
          }
        })
        .finally(() => { visualQueueInFlight = null; });
      foregroundPromises.push(visualQueueInFlight);
    } else if (streamingFace) {
      streamingFace.markProducerDone();
    }

    // Keep the browse-critical visual/face work ahead of semantic embeddings on
    // low-memory machines. Embeddings can run later once the user is idle.
    await Promise.all(foregroundPromises);
    }

    if (!deferEmbeddingStage && pendingEmbeddingJobs.length > 0) {
      if (polite) {
        await waitForAnalysisIdle();
      }
      broadcast('semantic-indexing-started', { total: pendingEmbeddingJobs.length });
      embeddingQueueInFlight = withReducedPriority(async () => {
        if (embeddingWorker && typeof embeddingWorker.processEmbeddingJobs === 'function') {
          try {
            const result = await embeddingWorker.processEmbeddingJobs(pendingEmbeddingJobs, {
              onProgress: (data) => {
                broadcast('semantic-indexing-progress', data);
              },
            });

            for (const item of result.processed || []) {
              if (item?.embedding && item.mediaId) {
                updateMediaEmbedding(db, item.mediaId, Buffer.from(item.embedding, 'base64'));
              }
            }

            return {
              total: result.total || pendingEmbeddingJobs.length,
              durationMs: result.durationMs || 0,
            };
          } catch (error) {
            console.warn('[SemanticIndex] Embedding worker failed, falling back to main process:', error.message);
          }
        }

        return processPendingEmbeddingJobs(db, pendingEmbeddingJobs, Object.assign({
          onProgress: (data) => {
            broadcast('semantic-indexing-progress', data);
          },
        }, embeddingRuntime.beforeBatch ? { beforeBatch: waitForAnalysisIdle } : {}, {
          yieldMs: embeddingRuntime.yieldMs,
        }));
      })
        .then((result) => {
          console.log(`[SemanticIndex] Completed ${result.total} jobs in ${result.durationMs}ms`);
          stageStats.embedding.durationMs = result.durationMs || 0;
          stageStats.embedding.processedCount = result.total || pendingEmbeddingJobs.length;
          broadcast('semantic-indexing-complete', result);
          completeIndexJobs(db, 'embedding', pendingEmbeddingJobs);
        })
        .finally(() => { embeddingQueueInFlight = null; });
      await embeddingQueueInFlight;
    }

    if (deferEmbeddingStage && pendingEmbeddingJobs.length > 0) {
      scheduleDeferredVisualResume(2500);
    }

    return stageStats;
  }

  async function startLegacyFaceQueue(jobs, options = {}) {
    if (faceQueueInFlight) return faceQueueInFlight;
    faceQueueInFlight = (async () => {
      const runtime = getQueueRuntimeOptions(options.politeBackground !== false, waitForInteractionIdle);
      broadcast('face-indexing-started', { total: jobs.length });
      const result = await withReducedPriority(() => runFaceQueue(jobs, runtime));
      console.log(`[FaceIndex] Completed ${result.total} jobs in ${result.durationMs}ms`);
      broadcast('face-indexing-complete', result);
      completeIndexJobs(db, 'face', jobs);
    })().finally(() => {
      faceQueueInFlight = null;
    });
    return faceQueueInFlight;
  }

  function clearWatchers() {
    watchers.forEach((watcher) => {
      try { watcher.close(); } catch (_) { }
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

            const changedPaths = Array.from(pendingChangedPaths).filter((filePath) => {
        if (!fs.existsSync(filePath)) return false;
        try {
          const stat = fs.statSync(filePath);
          const existing = db.prepare('SELECT mtime_ms, size FROM media_items WHERE path = ?').get(filePath);
          if (!existing) return true;
          return (stat.mtimeMs !== existing.mtime_ms || stat.size !== existing.size);
        } catch (e) {
          return true;
        }
      });
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
    suppressWatcherEventsUntil = Date.now() + 45000;

    const { roots } = getMediaRoots(db, app);
    roots.forEach((root) => {
      if (!root || !fs.existsSync(root)) return;
      try {
        const watcher = fs.watch(root, { recursive: true }, (_eventType, filename) => {
          if (!filename) return;
          if (Date.now() < suppressWatcherEventsUntil) return;
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
    if (refreshInFlight || backgroundPipelineInFlight || visualQueueInFlight || faceQueueInFlight || embeddingQueueInFlight) {
      return { changed: false };
    }

    const { roots, includeVideos } = getMediaRoots(db, app);
    const scanResults = await Promise.all(roots.map((root) => walkMediaFilesAsync(root, { includeVideos })));
    const scanned = scanResults.flat();
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

    const pendingFaceCount = db.prepare(
      "SELECT COUNT(*) as count FROM media_items WHERE is_missing = 0 AND media_type = 'image' AND faces_indexed = 0 AND visual_indexed = 1"
    ).get().count;
    if (pendingFaceCount > 0 && !changed) {
      console.log(`[LibraryRefresh] ${pendingFaceCount} images need face re-indexing, triggering full refresh...`);
      await requestRefresh('face-reindex', { scannedFiles: scanned });
      changed = true;
    }

    if (!changed) {
      const resumedVisualJobs = loadPendingIndexJobs(db, 'visual');
      const resumedFaceJobs = loadPendingIndexJobs(db, 'face');
      const resumedEmbeddingJobs = filterSkippableEmbeddingJobs(loadPendingIndexJobs(db, 'embedding'));
      const hasPendingJobs = resumedVisualJobs.length > 0 || resumedFaceJobs.length > 0 || resumedEmbeddingJobs.length > 0;
      if (hasPendingJobs) {
        console.log(`[LibraryRefresh] Resuming pending jobs: visual=${resumedVisualJobs.length}, face=${resumedFaceJobs.length}, embedding=${resumedEmbeddingJobs.length}`);
        const deferVisualStage = shouldDeferVisualStage(resumedVisualJobs);
        const deferEmbeddingStage = shouldDeferEmbeddingStage(resumedEmbeddingJobs);
        await startParallelPipeline(resumedVisualJobs, resumedFaceJobs, resumedEmbeddingJobs, {
          politeBackground: true,
          deferVisualStage,
          deferEmbeddingStage,
        });
        if (deferVisualStage || deferEmbeddingStage) {
          scheduleDeferredVisualResume(2500);
        }
        changed = true;
      }
    }

    return {
      changed,
      addedOrChangedCount: changedPaths.length,
    };
  }

  function dispose() {
    if (watchDebounceTimer) clearTimeout(watchDebounceTimer);
    if (deferredVisualTimer) clearTimeout(deferredVisualTimer);
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
    getLatestBenchmark: () => latestPipelineBenchmark,
    getBenchmarkHistory: () => benchmarkHistory,
    dispose,
  };
}

module.exports = {
  createLibraryRefreshManager,
};

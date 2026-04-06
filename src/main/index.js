const path = require('path');
const { app, BrowserWindow } = require('electron');
const { createDb } = require('../../lib/indexer');
const { createMainWindow } = require('./window');
const { registerIpcHandlers } = require('./ipc');
const { createLibraryRefreshManager } = require('./library-refresh');
const { createEmbeddingWorkerClient } = require('./embedding-worker-client');
const { createVisionFaceWorkerClient } = require('./vision-face-worker-client');
const { createMediaAssetWorkerClient } = require('./media-asset-worker-client');

let latestRunStats = null;

function broadcastToAll(channel, payload) {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  });
}

function configureChromiumCachePaths() {
  const userDataPath = app.getPath('userData');
  app.setPath('sessionData', path.join(userDataPath, 'session-data'));
  app.setPath('userCache', path.join(userDataPath, 'cache'));
  app.commandLine.appendSwitch('disk-cache-dir', path.join(userDataPath, 'cache', 'chromium'));
  app.commandLine.appendSwitch('gpu-shader-disk-cache-size-kb', '0');
}

function startApp() {
  configureChromiumCachePaths();

  // GPU-safe mode: read the flag BEFORE app is ready (Chromium switches
  // must be appended before the first BrowserWindow is created).
  try {
    const Database = require('better-sqlite3');
    const earlyDbPath = path.join(app.getPath('userData'), 'memory-index.sqlite');
    if (require('fs').existsSync(earlyDbPath)) {
      const earlyDb = new Database(earlyDbPath, { readonly: true, fileMustExist: true });
      const row = earlyDb.prepare("SELECT value FROM settings WHERE key = 'gpu_safe_mode'").get();
      earlyDb.close();
      if (row && row.value === 'true') {
        console.log('[GPU] Safe mode enabled — disabling hardware acceleration');
        app.disableHardwareAcceleration();
      }
    }
  } catch (_) {
    // DB may not exist yet on first launch — that's fine
  }

  app.whenReady().then(() => {
    const dbPath = path.join(app.getPath('userData'), 'memory-index.sqlite');
    const db = createDb(dbPath);
    const embeddingWorker = createEmbeddingWorkerClient();
    const visionFaceWorker = createVisionFaceWorkerClient();
    const mediaAssetWorker = createMediaAssetWorkerClient();
    const refreshManager = createLibraryRefreshManager({
      app,
      db,
      embeddingWorker,
      visionFaceWorker,
      mediaAssetWorker,
      setLatestRunStats: (stats) => {
        latestRunStats = stats;
      },
    });

    registerIpcHandlers({
      app,
      db,
      refreshManager,
      getLatestRunStats: () => latestRunStats,
      setLatestRunStats: (stats) => {
        latestRunStats = stats;
      },
    });

    createMainWindow();
    setTimeout(async () => {
      try {
        if (typeof visionFaceWorker.warmVisualModels === 'function') {
          await visionFaceWorker.warmVisualModels();
        } else {
          await visionFaceWorker.warmModels();
        }
      } catch (error) {
        console.error('[Models] Vision warmup failed:', error);
        broadcastToAll('model-load-error', {
          message: error.message || 'AI models failed to load',
          hint: 'AI features (tagging, search, face recognition) are unavailable. Check your internet connection and restart the app.',
        });
      }

      try {
        await embeddingWorker.warmEmbeddingModels();
      } catch (error) {
        console.error('[Models] Embedding worker warmup failed:', error);
        broadcastToAll('model-load-error', {
          message: error.message || 'Search indexing model failed to load',
          hint: 'Visual search will warm up later. Basic browsing still works.',
        });
      }

    }, 5000);
    refreshManager.startWatching();
    setTimeout(() => {
      refreshManager.checkForStartupChanges().catch((error) => {
        console.error('[LibraryRefresh] Startup delta check failed:', error);
      });
    }, 1200);

    app.on('before-quit', () => {
      refreshManager.dispose();
      embeddingWorker.dispose();
      visionFaceWorker.dispose();
      mediaAssetWorker.dispose();
    });
  });
}

module.exports = {
  startApp,
};

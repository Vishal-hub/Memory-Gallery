const { ipcMain } = require('electron');
const { runIndexing, getEventsForRenderer, getIndexStats } = require('../../lib/indexer');
const { searchSemanticVectors } = require('../../lib/indexer/vector-search');

function registerIpcHandlers({ app, db, refreshManager, getLatestRunStats, setLatestRunStats }) {
  ipcMain.handle('read-images', async (e, config = {}) => {
    return getEventsForRenderer(db, config.groupBy || 'date');
  });

  ipcMain.handle('refresh-library', async (e, config = {}) => {
    const latestRun = await refreshManager.requestRefresh('manual');
    setLatestRunStats(latestRun);
    return getEventsForRenderer(db, config.groupBy || 'date');
  });

  ipcMain.handle('get-events', async (e, config = {}) => {
    return getEventsForRenderer(db, config.groupBy || 'date');
  });

  ipcMain.handle('search-semantic', async (e, text) => {
    return searchSemanticVectors(db, text);
  });

  ipcMain.handle('get-index-debug', async () => {
    const stats = getIndexStats(db);
    return {
      ...stats,
      latestRun: getLatestRunStats(),
      libraryDirty: refreshManager.isDirty(),
    };
  });

  ipcMain.handle('clear-cache', async () => {
    try {
      console.log('Clearing cache via SQL...');
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM event_items').run();
        db.prepare('DELETE FROM events').run();
        db.prepare('DELETE FROM media_items').run();
        db.prepare('DELETE FROM geocoding_cache').run();
        // Option: db.prepare('DELETE FROM settings').run(); 
        // We usually want to KEEP settings (folder roots) during a cache clear 
        // so the user doesn't have to re-add their folders.
      });
      tx();
      console.log('Cache cleared successfully.');
    } catch (err) {
      console.error('Failed to clear cache via SQL:', err);
    }
    app.relaunch();
    app.exit();
  });

  ipcMain.handle('get-index-roots', async () => {
    try {
      const { getMediaRoots } = require('../../lib/indexer/scanner');
      const roots = getMediaRoots(db, app);
      console.log('Returning index roots:', roots);
      return roots;
    } catch (err) {
      console.error('IPC get-index-roots error:', err);
      throw err;
    }
  });

  ipcMain.handle('set-index-roots', async (event, data) => {
    const { roots, includeVideos } = data;
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('index_roots', JSON.stringify(roots));
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('include_videos', includeVideos ? 'true' : 'false');
    refreshManager.restartWatching();
    return { success: true };
  });

  ipcMain.handle('get-people', async () => {
    const { getPeople } = require('../../lib/indexer/repository');
    return getPeople(db);
  });

  ipcMain.handle('rename-person', async (e, data) => {
    const { renamePerson } = require('../../lib/indexer/repository');
    return renamePerson(db, data.id, data.name);
  });

  ipcMain.handle('select-folder', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    });
    if (result.canceled) return null;
    return result.filePaths[0];
  });

  ipcMain.on('user-activity', () => {
    if (typeof refreshManager.noteUserInteraction === 'function') {
      refreshManager.noteUserInteraction();
    }
  });
}

module.exports = {
  registerIpcHandlers,
};

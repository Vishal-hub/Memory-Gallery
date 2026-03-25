const { app } = require('electron');
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

app.whenReady().then(() => {
  try {
    const dbPath = path.join(os.homedir(), '.memory-desktop', 'index.db');
    const db = new Database(dbPath);
    const info = db.prepare('UPDATE media_items SET ai_tags = NULL').run();
    console.log(`Cleared old AI tags for ${info.changes} images!`);
  } catch (err) {
    console.error('Failed to clear tags:', err);
  }
  app.quit();
});

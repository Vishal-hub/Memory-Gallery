const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

const dbPath = path.join(os.homedir(), '.memory-desktop', 'index.db');
const db = new Database(dbPath);

const stmt = db.prepare('SELECT path, ai_tags FROM media_items');
const rows = stmt.all();

console.log('--- AI Tags in Database ---');
rows.forEach(row => {
  console.log(`${path.basename(row.path)}: ${row.ai_tags}`);
});

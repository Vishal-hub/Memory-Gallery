const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'memory-desktop', 'db.sqlite');

try {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare('SELECT path, ai_tags, face_count FROM media_items WHERE ai_tags IS NOT NULL LIMIT 20').all();
  console.log(JSON.stringify(rows, null, 2));
} catch (err) {
  console.error(err);
}

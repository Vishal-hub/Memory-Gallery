const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function applyMigrations(db) {
  const mediaColumns = db.prepare("PRAGMA table_info('media_items')").all().map((c) => c.name);
  if (!mediaColumns.includes('latitude')) db.exec('ALTER TABLE media_items ADD COLUMN latitude REAL');
  if (!mediaColumns.includes('longitude')) db.exec('ALTER TABLE media_items ADD COLUMN longitude REAL');
  if (!mediaColumns.includes('location_source')) db.exec('ALTER TABLE media_items ADD COLUMN location_source TEXT');
  if (!mediaColumns.includes('place_name')) db.exec('ALTER TABLE media_items ADD COLUMN place_name TEXT');
  if (!mediaColumns.includes('ai_tags')) db.exec('ALTER TABLE media_items ADD COLUMN ai_tags TEXT');
  if (!mediaColumns.includes('face_count')) db.exec('ALTER TABLE media_items ADD COLUMN face_count INTEGER');
  if (!mediaColumns.includes('embedding')) db.exec('ALTER TABLE media_items ADD COLUMN embedding BLOB');
  if (!mediaColumns.includes('thumbnail_path')) db.exec('ALTER TABLE media_items ADD COLUMN thumbnail_path TEXT');
  if (!mediaColumns.includes('faces_indexed')) db.exec('ALTER TABLE media_items ADD COLUMN faces_indexed INTEGER DEFAULT 0');
  if (!mediaColumns.includes('visual_indexed')) db.exec('ALTER TABLE media_items ADD COLUMN visual_indexed INTEGER DEFAULT 0');
  if (!mediaColumns.includes('person_class')) {
    db.exec("ALTER TABLE media_items ADD COLUMN person_class TEXT NOT NULL DEFAULT 'none'");
    db.exec(`
      UPDATE media_items SET person_class = CASE
        WHEN visual_indexed = 0 THEN 'none'
        WHEN face_count >= 2 THEN 'group'
        WHEN face_count = 1 THEN 'portrait'
        WHEN ai_tags LIKE '%person%' THEN 'portrait'
        ELSE 'none'
      END
      WHERE person_class = 'none' AND visual_indexed = 1
    `);
  }

  if (!mediaColumns.includes('converted_path')) db.exec('ALTER TABLE media_items ADD COLUMN converted_path TEXT');
  if (!mediaColumns.includes('person_confidence')) db.exec('ALTER TABLE media_items ADD COLUMN person_confidence REAL DEFAULT 0');

  const personColumns = db.prepare("PRAGMA table_info('people')").all().map((c) => c.name);
  if (!personColumns.includes('is_named')) db.exec('ALTER TABLE people ADD COLUMN is_named INTEGER DEFAULT 0');
  if (!personColumns.includes('updated_at_ms')) db.exec('ALTER TABLE people ADD COLUMN updated_at_ms INTEGER');
  if (!personColumns.includes('embedding')) db.exec('ALTER TABLE people ADD COLUMN embedding BLOB');

  const eventColumns = db.prepare("PRAGMA table_info('events')").all().map((c) => c.name);
  if (!eventColumns.includes('center_lat')) db.exec('ALTER TABLE events ADD COLUMN center_lat REAL');
  if (!eventColumns.includes('center_lon')) db.exec('ALTER TABLE events ADD COLUMN center_lon REAL');
  if (!eventColumns.includes('location_count')) db.exec('ALTER TABLE events ADD COLUMN location_count INTEGER NOT NULL DEFAULT 0');
  if (!eventColumns.includes('place_name')) db.exec('ALTER TABLE events ADD COLUMN place_name TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS index_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id INTEGER NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload_json TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY (media_id) REFERENCES media_items(id) ON DELETE CASCADE
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_index_jobs_stage_status ON index_jobs(stage, status, priority DESC, id ASC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_index_jobs_media_stage ON index_jobs(media_id, stage)');

  const FACE_MODEL_VERSION = '2';
  const faceVersionRow = db.prepare("SELECT value FROM settings WHERE key = 'face_model_version'").get();
  if (!faceVersionRow || Number(faceVersionRow.value) < Number(FACE_MODEL_VERSION)) {
    console.log('[Migration] Face model upgraded (CLIP -> InsightFace MobileFaceNet). Purging old face data for re-indexing...');
    db.exec('DELETE FROM media_faces');
    db.exec('DELETE FROM people');
    db.exec('UPDATE media_items SET faces_indexed = 0, face_count = NULL');
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('face_model_version', ?)").run(FACE_MODEL_VERSION);
    console.log('[Migration] Face data purged. Faces will be re-indexed on next run.');
  }
}

function createDb(dbPath) {
  ensureDir(path.dirname(dbPath));
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS media_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      ext TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      resolved_time_ms INTEGER NOT NULL,
      resolved_source TEXT NOT NULL,
      latitude REAL,
      longitude REAL,
      location_source TEXT,
      place_name TEXT,
      ai_tags TEXT,
      face_count INTEGER,
      embedding BLOB,
      thumbnail_path TEXT,
      converted_path TEXT,
      faces_indexed INTEGER DEFAULT 0,
      visual_indexed INTEGER DEFAULT 0,
      person_class TEXT NOT NULL DEFAULT 'none',
      person_confidence REAL DEFAULT 0,
      confidence REAL NOT NULL,
      last_seen_run INTEGER NOT NULL,
      is_missing INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      start_time_ms INTEGER NOT NULL,
      end_time_ms INTEGER NOT NULL,
      item_count INTEGER NOT NULL,
      center_lat REAL,
      center_lon REAL,
      location_count INTEGER NOT NULL DEFAULT 0,
      place_name TEXT,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS event_items (
      event_id TEXT NOT NULL,
      media_id INTEGER NOT NULL,
      sort_index INTEGER NOT NULL,
      PRIMARY KEY (event_id, media_id),
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY (media_id) REFERENCES media_items(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS geocoding_cache (
      lat_lon_key TEXT PRIMARY KEY,
      place_name TEXT,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      thumbnail_path TEXT,
      embedding BLOB,
      is_named INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media_faces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id INTEGER NOT NULL,
      person_id TEXT NOT NULL,
      box_2d TEXT NOT NULL,
      embedding BLOB,
      FOREIGN KEY (media_id) REFERENCES media_items(id) ON DELETE CASCADE,
      FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_a_id TEXT NOT NULL,
      person_b_id TEXT NOT NULL,
      relationship_type TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY (person_a_id) REFERENCES people(id) ON DELETE CASCADE,
      FOREIGN KEY (person_b_id) REFERENCES people(id) ON DELETE CASCADE,
      UNIQUE(person_a_id, person_b_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS index_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id INTEGER NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload_json TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY (media_id) REFERENCES media_items(id) ON DELETE CASCADE
    );
  `);

  applyMigrations(db);
  return db;
}

module.exports = {
  createDb,
};

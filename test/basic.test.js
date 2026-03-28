const assert = require('assert');
const path = require('path');
const fs = require('fs');

let passed = 0;
let failed = 0;
let skipped = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.message}`);
  }
}

function skipTest(name, reason) {
  skipped++;
  console.log(`  ○ ${name} (skipped: ${reason})`);
}

let hasSqlite = false;
try {
  const Database = require('better-sqlite3');
  const testDb = new Database(':memory:');
  testDb.close();
  hasSqlite = true;
} catch (_) { }

let hasElectron = false;
try { require('electron'); hasElectron = true; } catch (_) { }

// ---------------------------------------------------------------------------
// Module import checks
// ---------------------------------------------------------------------------
console.log('\n— Module imports —');

if (hasSqlite) {
  test('lib/indexer exports expected functions', () => {
    const indexer = require('../lib/indexer');
    assert.strictEqual(typeof indexer.createDb, 'function');
    assert.strictEqual(typeof indexer.runIndexing, 'function');
    assert.strictEqual(typeof indexer.getEventsForRenderer, 'function');
    assert.strictEqual(typeof indexer.getIndexStats, 'function');
  });
} else {
  skipTest('lib/indexer exports expected functions', 'better-sqlite3 not available');
}

test('lib/indexer/constants exports correct values', () => {
  const c = require('../lib/indexer/constants');
  assert.ok(c.SUPPORTED_MEDIA instanceof Set);
  assert.ok(c.SUPPORTED_MEDIA.has('.jpg'));
  assert.ok(c.SUPPORTED_MEDIA.has('.jpeg'));
  assert.ok(c.SUPPORTED_MEDIA.has('.png'));
  assert.ok(c.SUPPORTED_MEDIA.has('.webp'));
  assert.ok(c.SUPPORTED_MEDIA.has('.gif'));
  assert.ok(c.SUPPORTED_MEDIA.has('.bmp'));
  assert.ok(c.SUPPORTED_MEDIA.has('.tiff'));
  assert.ok(c.SUPPORTED_MEDIA.has('.tif'));
  assert.ok(c.SUPPORTED_MEDIA.has('.svg'));
  assert.ok(c.SUPPORTED_MEDIA.has('.heic'));
  assert.ok(c.SUPPORTED_MEDIA.has('.heif'));
  assert.ok(c.SUPPORTED_MEDIA.has('.mp4'));
  assert.ok(c.VIDEO_EXTENSIONS instanceof Set);
  assert.ok(c.VIDEO_EXTENSIONS.has('.mp4'));
  assert.ok(!c.VIDEO_EXTENSIONS.has('.jpg'));
  assert.ok(c.HEIC_EXTENSIONS instanceof Set);
  assert.ok(c.HEIC_EXTENSIONS.has('.heic'));
  assert.ok(c.HEIC_EXTENSIONS.has('.heif'));
  assert.ok(!c.HEIC_EXTENSIONS.has('.jpg'));
  assert.strictEqual(c.TWO_HOURS_MS, 7200000);
  assert.strictEqual(typeof c.MAX_CLUSTER_SIZE, 'number');
  assert.strictEqual(typeof c.LOCATION_SPLIT_DISTANCE_KM, 'number');
});

test('image-converter isHeic identifies HEIC files correctly', () => {
  const { isHeic } = require('../lib/indexer/image-converter');
  assert.strictEqual(isHeic('/photos/IMG_001.heic'), true);
  assert.strictEqual(isHeic('/photos/IMG_001.HEIC'), true);
  assert.strictEqual(isHeic('/photos/IMG_001.heif'), true);
  assert.strictEqual(isHeic('/photos/IMG_001.jpg'), false);
  assert.strictEqual(isHeic('/photos/IMG_001.png'), false);
});

// ---------------------------------------------------------------------------
// Database creation
// ---------------------------------------------------------------------------
console.log('\n— Database —');

const TEST_DB_PATH = path.join(__dirname, '_test_temp.sqlite');
let createTestDb, cleanupDb;

if (hasSqlite) {
  createTestDb = () => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    const { createDb } = require('../lib/indexer/db');
    return createDb(TEST_DB_PATH);
  };
  cleanupDb = () => { try { fs.unlinkSync(TEST_DB_PATH); } catch (_) { } };

  test('createDb creates all expected tables', () => {
    const db = createTestDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
    ['media_items', 'events', 'event_items', 'geocoding_cache', 'people', 'media_faces', 'settings'].forEach(t => {
      assert.ok(tables.includes(t), `missing table: ${t}`);
    });
    db.close();
    cleanupDb();
  });

  test('createDb enables WAL mode', () => {
    const db = createTestDb();
    const mode = db.pragma('journal_mode', { simple: true });
    assert.strictEqual(mode, 'wal');
    db.close();
    cleanupDb();
  });
} else {
  createTestDb = () => null;
  cleanupDb = () => { };
  skipTest('createDb creates all expected tables', 'better-sqlite3 not available');
  skipTest('createDb enables WAL mode', 'better-sqlite3 not available');
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------
console.log('\n— Clustering —');

const { buildEvents } = require('../lib/indexer/cluster');

test('buildEvents returns empty array for empty input', () => {
  const result = buildEvents([]);
  assert.ok(Array.isArray(result));
  assert.strictEqual(result.length, 0);
});

test('buildEvents groups items within time window into one event', () => {
  const base = Date.now();
  const items = [
    { id: 1, path: '/a.jpg', resolved_time_ms: base },
    { id: 2, path: '/b.jpg', resolved_time_ms: base + 60000 },
    { id: 3, path: '/c.jpg', resolved_time_ms: base + 120000 },
  ];
  const events = buildEvents(items);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].items.length, 3);
  assert.strictEqual(events[0].startTimeMs, base);
  assert.strictEqual(events[0].endTimeMs, base + 120000);
});

test('buildEvents splits on time gap > 2 hours', () => {
  const base = Date.now();
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const items = [
    { id: 1, path: '/a.jpg', resolved_time_ms: base },
    { id: 2, path: '/b.jpg', resolved_time_ms: base + TWO_HOURS + 1 },
  ];
  const events = buildEvents(items);
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].items.length, 1);
  assert.strictEqual(events[1].items.length, 1);
});

test('buildEvents splits on large location gap', () => {
  const base = Date.now();
  const items = [
    { id: 1, path: '/a.jpg', resolved_time_ms: base, latitude: 40.7128, longitude: -74.0060 },
    { id: 2, path: '/b.jpg', resolved_time_ms: base + 1000, latitude: 48.8566, longitude: 2.3522 },
  ];
  const events = buildEvents(items);
  assert.strictEqual(events.length, 2);
});

test('buildEvents keeps nearby items in same cluster', () => {
  const base = Date.now();
  const items = [
    { id: 1, path: '/a.jpg', resolved_time_ms: base, latitude: 40.7128, longitude: -74.0060 },
    { id: 2, path: '/b.jpg', resolved_time_ms: base + 1000, latitude: 40.7130, longitude: -74.0058 },
  ];
  const events = buildEvents(items);
  assert.strictEqual(events.length, 1);
});

test('buildEvents generates stable IDs for same input', () => {
  const base = Date.now();
  const items = [
    { id: 1, path: '/a.jpg', resolved_time_ms: base },
    { id: 2, path: '/b.jpg', resolved_time_ms: base + 1000 },
  ];
  const e1 = buildEvents(items);
  const e2 = buildEvents(items);
  assert.strictEqual(e1[0].id, e2[0].id);
});

test('buildEvents computes location center', () => {
  const base = Date.now();
  const items = [
    { id: 1, path: '/a.jpg', resolved_time_ms: base, latitude: 40.0, longitude: -74.0, place_name: 'NYC' },
    { id: 2, path: '/b.jpg', resolved_time_ms: base + 1000, latitude: 40.0, longitude: -74.0, place_name: 'NYC' },
  ];
  const events = buildEvents(items);
  assert.strictEqual(typeof events[0].centerLat, 'number');
  assert.strictEqual(typeof events[0].centerLon, 'number');
  assert.ok(Math.abs(events[0].centerLat - 40.0) < 0.001);
  assert.strictEqual(events[0].placeName, 'NYC');
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------
console.log('\n— Repository —');

if (hasSqlite) {
  const {
    upsertMediaItems,
    getActiveMediaItems,
    replaceEvents,
    getEventsForRenderer,
    getIndexStats,
    getPeople,
  } = require('../lib/indexer/repository');

  test('upsertMediaItems + getActiveMediaItems round-trip', () => {
    const db = createTestDb();
    const queries = upsertMediaItems(db, [], 1);

    queries.upsert.run({
      path: '/test/photo.jpg',
      ext: '.jpg',
      mediaType: 'image',
      size: 1024,
      mtimeMs: Date.now(),
      resolvedTimeMs: Date.now(),
      resolvedSource: 'exif',
      latitude: null,
      longitude: null,
      locationSource: null,
      placeName: null,
      aiTags: null,
      faceCount: 0,
      embedding: null,
      thumbnailPath: null,
      convertedPath: null,
      facesIndexed: 0,
      visualIndexed: 0,
      personClass: 'none',
      confidence: 1.0,
      lastSeenRun: 1,
    });

    const active = getActiveMediaItems(db);
    assert.strictEqual(active.length, 1);
    assert.strictEqual(active[0].path, '/test/photo.jpg');

    db.close();
    cleanupDb();
  });

  test('replaceEvents + getEventsForRenderer round-trip', () => {
    const db = createTestDb();
    const queries = upsertMediaItems(db, [], 1);

    queries.upsert.run({
      path: '/test/a.jpg', ext: '.jpg', mediaType: 'image', size: 512,
      mtimeMs: Date.now(), resolvedTimeMs: Date.now(), resolvedSource: 'mtime',
      latitude: null, longitude: null, locationSource: null, placeName: null,
      aiTags: 'dog, park', faceCount: 0, embedding: null, thumbnailPath: null,
      convertedPath: null,
      facesIndexed: 0, visualIndexed: 1, personClass: 'none', confidence: 0.8, lastSeenRun: 1,
    });

    const active = getActiveMediaItems(db);
    const events = buildEvents(active);
    replaceEvents(db, events);

    const rendered = getEventsForRenderer(db, 'date');
    assert.strictEqual(rendered.length, 1);
    assert.strictEqual(rendered[0].items.length, 1);
    assert.strictEqual(rendered[0].items[0].aiTags, 'dog, park');

    db.close();
    cleanupDb();
  });

  test('getIndexStats returns correct counts', () => {
    const db = createTestDb();
    const queries = upsertMediaItems(db, [], 1);
    queries.upsert.run({
      path: '/x.jpg', ext: '.jpg', mediaType: 'image', size: 100,
      mtimeMs: Date.now(), resolvedTimeMs: Date.now(), resolvedSource: 'mtime',
      latitude: 10.0, longitude: 20.0, locationSource: 'exif', placeName: null,
      aiTags: null, faceCount: 0, embedding: null, thumbnailPath: null,
      convertedPath: null,
      facesIndexed: 0, visualIndexed: 0, personClass: 'none', confidence: 1.0, lastSeenRun: 1,
    });

    const stats = getIndexStats(db);
    assert.strictEqual(stats.activeMedia, 1);
    assert.strictEqual(stats.missingMedia, 0);
    assert.strictEqual(stats.geotaggedMedia, 1);

    db.close();
    cleanupDb();
  });

  test('getPeople returns empty array on fresh DB', () => {
    const db = createTestDb();
    const people = getPeople(db);
    assert.ok(Array.isArray(people));
    assert.strictEqual(people.length, 0);
    db.close();
    cleanupDb();
  });
} else {
  skipTest('upsertMediaItems + getActiveMediaItems round-trip', 'better-sqlite3 not available');
  skipTest('replaceEvents + getEventsForRenderer round-trip', 'better-sqlite3 not available');
  skipTest('getIndexStats returns correct counts', 'better-sqlite3 not available');
  skipTest('getPeople returns empty array on fresh DB', 'better-sqlite3 not available');
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------
console.log('\n— Scanner —');

const { getMediaFileRecord } = require('../lib/indexer/scanner');

test('getMediaFileRecord returns null for non-existent file', () => {
  const result = getMediaFileRecord('/definitely/not/a/real/file.jpg');
  assert.strictEqual(result, null);
});

test('getMediaFileRecord returns null for unsupported extension', () => {
  const result = getMediaFileRecord(__filename);
  assert.strictEqual(result, null);
});

// ---------------------------------------------------------------------------
// Vector search helpers
// ---------------------------------------------------------------------------
console.log('\n— Vector search —');

if (hasElectron) {
  test('vector-search module exports searchSemanticVectors', () => {
    const vs = require('../lib/indexer/vector-search');
    assert.strictEqual(typeof vs.searchSemanticVectors, 'function');
  });
} else {
  skipTest('vector-search module exports searchSemanticVectors', 'electron not available');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const total = passed + failed + skipped;
console.log(`\n${total} tests: ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
process.exit(failed > 0 ? 1 : 0); 
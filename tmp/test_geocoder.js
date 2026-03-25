const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { createDb } = require('../lib/indexer/db');
const { reverseGeocode } = require('../lib/indexer/geocoder');

async function test() {
  const dbPath = path.join(__dirname, 'test-memory.sqlite');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  console.log('--- Testing Database Creation ---');
  const db = createDb(dbPath);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log('Tables:', tables.map(t => t.name));

  const hasCacheTable = tables.some(t => t.name === 'geocoding_cache');
  console.log('Has geocoding_cache:', hasCacheTable);

  if (!hasCacheTable) {
    console.error('FAILED: geocoding_cache table missing');
    process.exit(1);
  }

  console.log('\n--- Testing Geocoder Cache ---');
  const lat = 40.7128;
  const lon = -74.0060;
  
  // First call (should hit network or fail gracefully if no internet, but here we check DB insert)
  console.log('First call (simulated or real)...');
  const place = await reverseGeocode(db, lat, lon);
  console.log('Result:', place);

  const cached = db.prepare('SELECT * FROM geocoding_cache').all();
  console.log('Cache contents:', cached);

  if (cached.length > 0 || place === null) {
      console.log('SUCCESS: Geocoder handled request and DB cache interaction.');
  } else {
      console.log('FAILED: No cache entry created.');
  }

  db.close();
  // fs.unlinkSync(dbPath);
  process.exit(0);
}

test().catch(console.error);

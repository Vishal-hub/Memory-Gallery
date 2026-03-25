const https = require('https');
const inFlightGeocodes = new Map();

function isMostlyAscii(value) {
  return typeof value === 'string' && /^[\x00-\x7F]+$/.test(value);
}

async function reverseGeocode(db, lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;

  // Round to ~100m to increase cache hits and reduce precision for privacy
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;

  // Check DB cache first
  try {
    const cached = db.prepare('SELECT place_name FROM geocoding_cache WHERE lat_lon_key = ?').get(key);
    if (cached && isMostlyAscii(cached.place_name)) return cached.place_name;
  } catch (err) {
    console.error('Error reading geocoding cache:', err);
  }

  if (inFlightGeocodes.has(key)) {
    return inFlightGeocodes.get(key);
  }

  const requestPromise = new Promise((resolve) => {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&accept-language=en`;
    
    const options = {
      headers: {
        'User-Agent': 'Memory-Desktop/1.0.0 (Electron App)'
      }
    };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const address = json.address || {};
          const locality = address.city || address.town || address.village || address.municipality || address.suburb || address.county || address.state;
          const country = address.country;
          const place = locality && country && locality !== country
            ? `${locality}, ${country}`
            : locality || country || null;
          
          if (place) {
            db.prepare('INSERT OR REPLACE INTO geocoding_cache (lat_lon_key, place_name, updated_at_ms) VALUES (?, ?, ?)')
              .run(key, place, Date.now());
          }
          
          resolve(place);
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => {
      resolve(null);
    });
  }).finally(() => {
    inFlightGeocodes.delete(key);
  });

  inFlightGeocodes.set(key, requestPromise);
  return requestPromise;
}

module.exports = {
  reverseGeocode,
};

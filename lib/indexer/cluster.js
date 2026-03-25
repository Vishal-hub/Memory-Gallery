const crypto = require('crypto');
const { TWO_HOURS_MS, MAX_CLUSTER_SIZE, LOCATION_SPLIT_DISTANCE_KM } = require('./constants');

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

function clusterLocationCenter(items) {
  const points = items.filter((it) => typeof it.latitude === 'number' && typeof it.longitude === 'number');
  if (points.length === 0) return { centerLat: null, centerLon: null, locationCount: 0, placeName: null };
  const lat = points.reduce((sum, p) => sum + p.latitude, 0) / points.length;
  const lon = points.reduce((sum, p) => sum + p.longitude, 0) / points.length;

  // Pick the most frequent place name
  const placeCounts = {};
  items.forEach((it) => {
    if (it.place_name) {
      placeCounts[it.place_name] = (placeCounts[it.place_name] || 0) + 1;
    }
  });
  const sortedPlaces = Object.entries(placeCounts).sort((a, b) => b[1] - a[1]);
  const placeName = sortedPlaces.length > 0 ? sortedPlaces[0][0] : null;

  return { centerLat: lat, centerLon: lon, locationCount: points.length, placeName };
}

function shouldSplitCluster(prev, current, currentClusterSize) {
  const timeGap = current.resolved_time_ms - prev.resolved_time_ms;
  const splitByTime = timeGap > TWO_HOURS_MS;
  const splitBySize = currentClusterSize >= MAX_CLUSTER_SIZE;

  const hasPrevLoc = typeof prev.latitude === 'number' && typeof prev.longitude === 'number';
  const hasCurrLoc = typeof current.latitude === 'number' && typeof current.longitude === 'number';
  const locationGap = (hasPrevLoc && hasCurrLoc)
    ? haversineKm(prev.latitude, prev.longitude, current.latitude, current.longitude)
    : 0;
  const splitByLocation = locationGap > LOCATION_SPLIT_DISTANCE_KM;

  return splitByTime || splitBySize || splitByLocation;
}

function toStableEventId(cluster) {
  const start = cluster[0].resolved_time_ms;
  const end = cluster[cluster.length - 1].resolved_time_ms;
  const seed = `${start}|${end}|${cluster[0].path}|${cluster[cluster.length - 1].path}|${cluster.length}`;
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16);
}

function buildEvents(mediaItems) {
  const clusters = [];
  let current = [];

  mediaItems.forEach((item, index) => {
    if (index === 0) {
      current.push(item);
      return;
    }

    const prev = mediaItems[index - 1];
    if (shouldSplitCluster(prev, item, current.length)) {
      clusters.push(current);
      current = [item];
    } else {
      current.push(item);
    }
  });

  if (current.length > 0) clusters.push(current);

  return clusters.map((cluster) => {
    const startTimeMs = cluster[0].resolved_time_ms;
    const endTimeMs = cluster[cluster.length - 1].resolved_time_ms;
    return {
      id: toStableEventId(cluster),
      startTimeMs,
      endTimeMs,
      items: cluster,
      ...clusterLocationCenter(cluster),
    };
  });
}

module.exports = {
  buildEvents,
};

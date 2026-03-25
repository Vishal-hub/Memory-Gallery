const SUPPORTED_MEDIA = new Set(['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov', '.avi']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi']);
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const MAX_CLUSTER_SIZE = 30;
const LOCATION_SPLIT_DISTANCE_KM = 80;

module.exports = {
  SUPPORTED_MEDIA,
  VIDEO_EXTENSIONS,
  TWO_HOURS_MS,
  MAX_CLUSTER_SIZE,
  LOCATION_SPLIT_DISTANCE_KM,
};

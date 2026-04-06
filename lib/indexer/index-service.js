const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { BrowserWindow } = require('electron');
const { getMediaRoots, walkMediaFilesAsync } = require('./scanner');
const { resolveMediaMetadata } = require('./metadata');
const { buildEvents } = require('./cluster');
const {
  upsertMediaItems,
  quickUpsertMediaItems,
  getActiveMediaItems,
  getUnprocessedMediaItems,
  replaceEvents,
  insertFace,
  updateMediaEmbedding,
  updateMediaVisualAnalysis,
  createPersonMatcher,
  findClosestPerson,
  createPerson,
  deleteFacesForMediaId,
  pruneOrphanPeople,
} = require('./repository');
const { reverseGeocode } = require('./geocoder');
const { detectMedia, embedVisualMedia } = require('./ai-service');
const { extractFrame } = require('./video-utils');
const { isHeic, convertHeicToJpeg, getConvertDir } = require('./image-converter');
const { writeJpegThumbnail, writeAnalysisProxy, writeFaceThumbnail } = require('./image-ops');
const PERSON_MATCH_THRESHOLD = 0.55;

const ANIMAL_TAGS = new Set([
  'dog', 'cat', 'bird', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra',
  'giraffe', 'fish', 'rabbit', 'hamster', 'turtle', 'snake', 'lizard', 'frog',
  'mouse', 'parrot', 'duck', 'goose', 'chicken', 'penguin', 'owl', 'deer',
]);

const ANIMAL_FILENAME_HINTS = [
  'dog', 'dogs', 'puppy', 'puppies', 'cat', 'cats', 'kitten', 'kittens',
  'bird', 'birds', 'horse', 'horses', 'rabbit', 'rabbits', 'hamster',
  'turtle', 'parrot', 'duck', 'ducks', 'owl', 'owls', 'deer',
];

function isAnimalOnlyImage(mediaRow) {
  if (!mediaRow) return false;
  const personClass = mediaRow.person_class || 'none';
  if (personClass !== 'none') return false;
  const tags = (mediaRow.ai_tags || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  if (tags.length === 0) return false;
  return tags.every(tag => ANIMAL_TAGS.has(tag));
}

function hasAnimalTag(mediaRow) {
  if (!mediaRow) return false;
  const tags = (mediaRow.ai_tags || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  return tags.some((tag) => ANIMAL_TAGS.has(tag));
}

function hasAnimalFilenameHint(filePath) {
  const base = path.basename(filePath || '', path.extname(filePath || '')).toLowerCase();
  if (!base) return false;
  return ANIMAL_FILENAME_HINTS.some((hint) => base.includes(hint));
}

function getStrongestAnimalLabel(labelScores = []) {
  const scores = Array.isArray(labelScores) ? labelScores : [];
  let best = null;
  for (const item of scores) {
    const label = String(item?.label || '').toLowerCase();
    if (!ANIMAL_TAGS.has(label)) continue;
    const score = Number(item?.score) || 0;
    if (!best || score > best.score) {
      best = { label, score };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// ImageContext — lazily loads and caches a nativeImage decode per file so that
// getImageDimensions, getImageProfile, thumbnail generation, analysis proxy
// creation, and face-service all share a single decode.
// ---------------------------------------------------------------------------

class ImageContext {
  constructor(filePath, decodablePath) {
    this._path = filePath;
    this._decodablePath = decodablePath || filePath;
    this._img = null;
    this._size = null;
    this._rgb = null;
  }

  _load() {
    if (this._img !== null) return this._img;
    const { nativeImage } = require('electron');
    this._img = nativeImage.createFromPath(this._decodablePath);
    if (this._img.isEmpty()) { this._img = false; }
    return this._img;
  }

  get image() {
    const img = this._load();
    return img || null;
  }

  get decodablePath() {
    return this._decodablePath;
  }

  get size() {
    if (this._size) return this._size;
    const img = this.image;
    if (!img) return null;
    this._size = img.getSize();
    return this._size;
  }

  getRgb() {
    if (this._rgb) return this._rgb;
    const img = this.image;
    if (!img) return null;
    const { width, height } = this.size;
    const bitmap = img.toBitmap();
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      rgb[i * 3] = bitmap[i * 4 + 2];
      rgb[i * 3 + 1] = bitmap[i * 4 + 1];
      rgb[i * 3 + 2] = bitmap[i * 4];
    }
    this._rgb = { rgb, width, height };
    return this._rgb;
  }

  dispose() {
    this._img = null;
    this._size = null;
    this._rgb = null;
  }
}

function shouldRefreshPlaceName(existing) {
  if (existing.latitude == null || existing.longitude == null) return false;
  if (!existing.place_name) return true;
  return /[^\x00-\x7F]/.test(existing.place_name);
}

function shouldIndexEmbeddingForFile(file) {
  return file?.mediaType !== 'video';
}

function getCpuCount() {
  return Array.isArray(os.cpus()) ? os.cpus().length : 4;
}

function getIndexBatchSize() {
  return 2;
}

function getFaceBatchSize() {
  return 1;
}

function getVisualBatchSize() {
  return 1;
}

function isThumbnailOnlyVisualJob(job) {
  return Boolean(job)
    && job.mediaType === 'video'
    && job.skipDetection === true;
}

function getImageDimensions(filePath, ctx = null) {
  try {
    if (ctx) return ctx.size;
    const { nativeImage } = require('electron');
    const image = nativeImage.createFromPath(filePath);
    if (image.isEmpty()) return null;
    return image.getSize();
  } catch (_) {
    return null;
  }
}

function getImageProfile(filePath, sampleSize = 32, ctx = null) {
  try {
    let image, width, height;
    if (ctx && ctx.image) {
      image = ctx.image;
      ({ width, height } = ctx.size);
    } else {
      const { nativeImage } = require('electron');
      image = nativeImage.createFromPath(filePath);
      if (image.isEmpty()) return null;
      ({ width, height } = image.getSize());
    }

    const resized = image.resize({ width: sampleSize, height: sampleSize, quality: 'fast' });
    const bitmap = resized.toBitmap();
    const colorBuckets = new Set();
    let edgeEnergy = 0;
    let comparisons = 0;

    function brightnessAt(offset) {
      const blue = bitmap[offset];
      const green = bitmap[offset + 1];
      const red = bitmap[offset + 2];
      return red * 0.299 + green * 0.587 + blue * 0.114;
    }

    for (let y = 0; y < sampleSize; y += 1) {
      for (let x = 0; x < sampleSize; x += 1) {
        const offset = (y * sampleSize + x) * 4;
        const blue = bitmap[offset];
        const green = bitmap[offset + 1];
        const red = bitmap[offset + 2];
        colorBuckets.add(((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4));

        const current = brightnessAt(offset);
        if (x + 1 < sampleSize) {
          edgeEnergy += Math.abs(current - brightnessAt(offset + 4));
          comparisons += 1;
        }
        if (y + 1 < sampleSize) {
          edgeEnergy += Math.abs(current - brightnessAt(offset + sampleSize * 4));
          comparisons += 1;
        }
      }
    }

    return {
      width,
      height,
      aspectRatio: width > 0 && height > 0 ? width / height : 0,
      uniqueColorBuckets: colorBuckets.size,
      averageEdgeEnergy: comparisons > 0 ? edgeEnergy / comparisons : 0,
    };
  } catch (_) {
    return null;
  }
}

function isScreenLikeAspectRatio(aspectRatio) {
  const commonAspectRatios = [
    16 / 9,
    16 / 10,
    3 / 2,
    4 / 3,
    21 / 9,
  ];
  return commonAspectRatios.some((target) => Math.abs(aspectRatio - target) < 0.03);
}

function shouldSkipVisualAnalysis(file, thumbnailPath = null, ctx = null) {
  if (!file || file.mediaType !== 'image') return false;

  const normalizedPath = file.path.replace(/\\/g, '/').toLowerCase();
  if (/(^|\/)(screenshots?|screen ?shots?|screen ?caps?)(\/|$)/i.test(normalizedPath)) {
    return true;
  }

  const baseName = path.basename(file.path).toLowerCase();
  if (/(^|[\s_(.-])screenshot([\s_).-]|$)/i.test(baseName)) {
    return true;
  }

  const dimensions = getImageDimensions(file.path, ctx);
  if (!dimensions) return false;

  if (Math.min(dimensions.width, dimensions.height) < 180) {
    return true;
  }

  const profileSource = thumbnailPath && fs.existsSync(thumbnailPath) ? thumbnailPath : file.path;
  const profileCtx = profileSource === file.path ? ctx : null;
  const profile = getImageProfile(profileSource, 32, profileCtx);
  if (!profile) return false;

  const isLikelyUiCapture =
    file.ext.toLowerCase() === '.png' &&
    Math.min(profile.width, profile.height) >= 500 &&
    isScreenLikeAspectRatio(profile.aspectRatio) &&
    profile.uniqueColorBuckets < 170 &&
    profile.averageEdgeEnergy < 18;

  if (isLikelyUiCapture) {
    return true;
  }

  return false;
}

function getThumbnailPath(thumbDir, file) {
  const seed = `${file.path}|${file.mtimeMs}|${file.size}`;
  const hash = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 20);
  return path.join(thumbDir, `thumb_${hash}.jpg`);
}

function getAnalysisProxyPath(proxyDir, file) {
  const seed = `${file.path}|${file.mtimeMs}|${file.size}`;
  const hash = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 20);
  return path.join(proxyDir, `analysis_${hash}.jpg`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureAnalysisProxy(proxyDir, file, ctx = null, precomputedProxyPath = null) {
  if (precomputedProxyPath && fs.existsSync(precomputedProxyPath)) return precomputedProxyPath;
  const proxyPath = getAnalysisProxyPath(proxyDir, file);
  if (fs.existsSync(proxyPath)) return proxyPath;

  try {
    const inputPath = ctx?.decodablePath || file.path;
    const writtenPath = await writeAnalysisProxy(inputPath, proxyPath, { maxSide: 1536, quality: 85 });
    return writtenPath || file.path;
  } catch (error) {
    console.error(`Analysis proxy generation failed for ${file.path}:`, error);
    return file.path;
  }
}

async function resolveFileMetadata(db, file, existing, { thumbDir, analysisDir, heicDir, queries, runId, mediaAssetWorker = null }) {
  let decodablePath = file.path;
  if (file.mediaType === 'image' && isHeic(file.path)) {
    try {
      decodablePath = await convertHeicToJpeg(file.path, heicDir, file.mtimeMs, file.size);
    } catch (err) {
      console.error(`[Indexer] HEIC conversion failed for ${file.path}:`, err.message);
    }
  }
  const ctx = file.mediaType === 'image' ? new ImageContext(file.path, decodablePath) : null;
  try {
    let resolved;
    let thumbnailPath = existing ? existing.thumbnail_path : null;
    let metadataRefreshed = 0;

    const canReuse = existing && existing.resolved_source && existing.resolved_source !== 'pending'
      && existing.mtime_ms === file.mtimeMs && existing.size === file.size;

    if (canReuse) {
      resolved = {
        resolvedTimeMs: existing.resolved_time_ms,
        source: existing.resolved_source,
        latitude: existing.latitude,
        longitude: existing.longitude,
        locationSource: existing.location_source,
        placeName: existing.place_name,
        aiTags: existing.ai_tags,
        faceCount: existing.face_count,
        embedding: existing.embedding,
        confidence: existing.confidence,
      };

      const missingLocation = file.mediaType === 'image' && (existing.latitude == null || existing.longitude == null);
      if (missingLocation) {
        const refreshed = await resolveMediaMetadata(file);
        resolved.latitude = refreshed.latitude;
        resolved.longitude = refreshed.longitude;
        resolved.locationSource = refreshed.locationSource;
        resolved.source = refreshed.source || resolved.source;
        resolved.resolvedTimeMs = refreshed.resolvedTimeMs || resolved.resolvedTimeMs;
        resolved.confidence = refreshed.confidence || resolved.confidence;
        if (typeof refreshed.latitude === 'number' && typeof refreshed.longitude === 'number') {
          resolved.placeName = await reverseGeocode(db, refreshed.latitude, refreshed.longitude);
        }
        metadataRefreshed += 1;
      }

      if (file.mediaType === 'image' && shouldRefreshPlaceName(existing) && typeof resolved.latitude === 'number' && typeof resolved.longitude === 'number') {
        resolved.placeName = await reverseGeocode(db, resolved.latitude, resolved.longitude);
        metadataRefreshed += 1;
      }
    } else {
      resolved = await resolveMediaMetadata(file);
      const hasGps = typeof resolved.latitude === 'number' && typeof resolved.longitude === 'number';
      if (hasGps) {
        resolved.placeName = await reverseGeocode(db, resolved.latitude, resolved.longitude);
      }
      resolved.aiTags = existing?.ai_tags || null;
      resolved.faceCount = existing?.face_count || null;
      resolved.embedding = existing?.embedding || null;
      metadataRefreshed += 1;
    }

    let precomputedAnalysisProxyPath = null;
    if (file.mediaType === 'image') {
      const thumbPath = getThumbnailPath(thumbDir, file);
      const needsThumbnail = !thumbnailPath || !fs.existsSync(thumbnailPath);
      const proxyPath = getAnalysisProxyPath(analysisDir, file);
      const needsAnalysisProxy = !fs.existsSync(proxyPath);

      if (mediaAssetWorker && (needsThumbnail || needsAnalysisProxy)) {
        try {
          const workerResult = await mediaAssetWorker.processJobs([{
            inputPath: ctx?.decodablePath || file.path,
            thumbnailPath: thumbPath,
            analysisProxyPath: proxyPath,
            generateThumbnail: needsThumbnail,
            generateAnalysisProxy: needsAnalysisProxy,
          }]);
          const processedAsset = workerResult?.processed?.[0];
          if (processedAsset?.thumbnailPath && fs.existsSync(processedAsset.thumbnailPath)) {
            thumbnailPath = processedAsset.thumbnailPath;
          }
          if (processedAsset?.analysisProxyPath && fs.existsSync(processedAsset.analysisProxyPath)) {
            precomputedAnalysisProxyPath = processedAsset.analysisProxyPath;
          }
        } catch (error) {
          console.warn(`[Indexer] Media asset worker failed for ${file.path}, falling back to main process:`, error.message);
        }
      }

      if (needsThumbnail && (!thumbnailPath || !fs.existsSync(thumbnailPath))) {
        try {
          const writtenPath = await writeJpegThumbnail(ctx?.decodablePath || file.path, thumbPath, {
            width: 256,
            quality: 80,
          });
          if (writtenPath) {
            thumbnailPath = writtenPath;
          }
        } catch (err) {
          console.error(`Thumbnail generation failed for ${file.path}:`, err);
        }
      }
    }
    const preferredThumbnailPath = (file.mediaType === 'video')
      ? getThumbnailPath(thumbDir, file)
      : thumbnailPath;

    const isChangedOrNew = !existing || !existing.resolved_source || existing.resolved_source === 'pending'
      || existing.mtime_ms !== file.mtimeMs || existing.size !== file.size;
    const needsVisualIndexing = (file.mediaType === 'image' || file.mediaType === 'video')
      && (isChangedOrNew || !existing?.visual_indexed);
    const needsFaceIndexing = file.mediaType === 'image'
      && (isChangedOrNew || !existing?.faces_indexed);
    const needsEmbedding = shouldIndexEmbeddingForFile(file)
      && (isChangedOrNew || !existing?.embedding);

    const upsertResult = queries.upsert.run({
      path: file.path,
      ext: file.ext,
      size: file.size,
      mtimeMs: file.mtimeMs,
      mediaType: file.mediaType,
      lastSeenRun: runId,
      resolvedTimeMs: resolved.resolvedTimeMs,
      resolvedSource: resolved.source,
      latitude: resolved.latitude,
      longitude: resolved.longitude,
      locationSource: resolved.locationSource,
      placeName: resolved.placeName,
      aiTags: resolved.aiTags,
      faceCount: resolved.faceCount,
      embedding: resolved.embedding || null,
      thumbnailPath,
      convertedPath: decodablePath !== file.path ? decodablePath : null,
      facesIndexed: needsFaceIndexing ? 0 : ((existing && existing.faces_indexed) ? 1 : 0),
      visualIndexed: needsVisualIndexing ? 0 : ((existing && existing.visual_indexed) ? 1 : 0),
      personClass: existing?.person_class || 'none',
      confidence: resolved.confidence,
    });

    const mediaId = existing ? existing.id : (upsertResult.lastInsertRowid || db.prepare('SELECT id FROM media_items WHERE path = ?').get(file.path)?.id);
    const hasLocation = typeof resolved.latitude === 'number' && typeof resolved.longitude === 'number';

    return {
      mediaId, decodablePath, thumbnailPath, ctx, resolved,
      needsVisualIndexing, needsFaceIndexing, needsEmbedding,
      metadataRefreshed, hasLocation, precomputedAnalysisProxyPath, preferredThumbnailPath,
    };
  } catch (err) {
    if (ctx) ctx.dispose();
    throw err;
  }
}

async function runIndexing(db, app, options = {}) {
  const {
    deferVisualIndexing = false,
    deferFaceIndexing = false,
    deferSemanticEmbedding = false,
    scannedFiles = null,
    skipMarkMissing = false,
    quickInsertOnly = false,
    reason = 'manual',
  } = options;
  const startedAt = Date.now();
  const runId = Date.now();
  const { roots, includeVideos } = getMediaRoots(db, app);
  let scanned;
  if (Array.isArray(scannedFiles)) {
    scanned = scannedFiles;
  } else {
    const scanResults = await Promise.all(roots.map((root) => walkMediaFilesAsync(root, { includeVideos })));
    scanned = scanResults.flat();
  }
  const scanCompletedAt = Date.now();

  if (quickInsertOnly) {
    const { markMissing } = quickUpsertMediaItems(db, scanned, runId);
    if (!skipMarkMissing) markMissing.run(runId);
    const activeRecords = getActiveMediaItems(db);
    const events = buildEvents(activeRecords);
    replaceEvents(db, events);
    const finishedAt = Date.now();
    console.log(`[Indexer] Quick-insert: ${scanned.length} files in ${finishedAt - startedAt}ms`);
    return {
      latestRun: {
        scannedCount: scanned.length,
        toProcessCount: 0,
        refreshed: 0,
        eventsCount: events.length,
        roots,
        batchSize: 0,
        timingsMs: {
          scan: scanCompletedAt - startedAt,
          process: 0,
          rebuild: finishedAt - scanCompletedAt,
          total: finishedAt - startedAt,
        },
      },
      scannedFiles: scanned,
      pendingVisualJobs: [],
      pendingFaceJobs: [],
      pendingEmbeddingJobs: [],
    };
  }

  const queries = upsertMediaItems(db, scanned, runId);

  const corruptedCount = db.prepare('SELECT COUNT(*) as count FROM media_items WHERE resolved_time_ms = 0').get().count;
  if (corruptedCount > 0) {
    console.log(`[Indexer] Fixing ${corruptedCount} corrupted 1970 records...`);
    db.prepare('DELETE FROM media_faces').run();
    db.prepare('DELETE FROM people').run();
    db.prepare('DELETE FROM event_items').run();
    db.prepare('DELETE FROM events').run();
    db.prepare('UPDATE media_items SET resolved_time_ms = -1, faces_indexed = 0, visual_indexed = 0 WHERE resolved_time_ms = 0').run();
  }

  let metadataRefreshed = 0;
  let geotaggedDuringRun = 0;
  let locationUnknownDuringRun = 0;

  const existingItems = db.prepare('SELECT id, path, mtime_ms, size, faces_indexed, visual_indexed, ai_tags, face_count, embedding, resolved_time_ms, resolved_source, latitude, longitude, location_source, place_name, person_class, confidence FROM media_items').all();
  const existingMap = new Map(existingItems.map((item) => [item.path, item]));
  const pendingJobRows = db.prepare(`
    SELECT media_id, stage
    FROM index_jobs
    WHERE status = 'pending'
  `).all();
  const pendingVisualIds = new Set(pendingJobRows.filter((row) => row.stage === 'visual').map((row) => row.media_id));
  const pendingFaceIds = new Set(pendingJobRows.filter((row) => row.stage === 'face').map((row) => row.media_id));
  const pendingEmbeddingIds = new Set(pendingJobRows.filter((row) => row.stage === 'embedding').map((row) => row.media_id));

  const toProcess = scanned.filter((file) => {
    const existing = existingMap.get(file.path);
    if (!existing) return true;
    if (existing.mtime_ms !== file.mtimeMs || existing.size !== file.size) return true;
    if (existing.resolved_time_ms === 0 || existing.resolved_time_ms === -1) return true;

    if (file.mediaType === 'image' || file.mediaType === 'video') {
      if (!existing.visual_indexed && !pendingVisualIds.has(existing.id)) return true;
      if (shouldIndexEmbeddingForFile(file) && !existing.embedding && !pendingEmbeddingIds.has(existing.id)) return true;
    }

    if (file.mediaType === 'image') {
      const missingLocation = existing.latitude == null || existing.longitude == null;
      if (missingLocation) return true;
      if (shouldRefreshPlaceName(existing)) return true;
      if (!existing.faces_indexed && !pendingFaceIds.has(existing.id)) return true;
    }

    queries.updateLastSeen.run(runId, file.path);
    return false;
  });

  if (toProcess.length > 0 || reason !== 'watch') {
    console.log(`[Indexer] Scanned ${scanned.length} files. ${toProcess.length} need processing.`);
  }

  const pendingVisualJobs = [];
  const pendingFaceJobs = [];
  const pendingEmbeddingJobs = [];
  const batchSize = getIndexBatchSize();
  const inlineMatcher = createPersonMatcher(db);
  const processingStartedAt = Date.now();

  const userDataPath = app.getPath('userData');
  const thumbDir = path.join(userDataPath, 'thumbnails');
  const analysisDir = path.join(userDataPath, 'analysis-cache');
  const heicDir = getConvertDir(app);
  if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });
  if (!fs.existsSync(analysisDir)) fs.mkdirSync(analysisDir, { recursive: true });

  for (let index = 0; index < toProcess.length; index += batchSize) {
    const batch = toProcess.slice(index, index + batchSize);

    const progress = Math.round((index / Math.max(1, toProcess.length)) * 100);
    const mainWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
    if (mainWindow) {
      mainWindow.webContents.send('indexing-progress', {
        percentage: progress,
        current: index,
        total: toProcess.length,
        message: `Analyzing: ${index} / ${toProcess.length}`,
      });
    }

    await Promise.all(batch.map(async (file) => {
      const existing = queries.selectByPath.get(file.path);
      const result = await resolveFileMetadata(db, file, existing, { thumbDir, analysisDir, heicDir, queries, runId });
      try {
        const { mediaId, decodablePath, thumbnailPath, ctx, needsVisualIndexing, needsFaceIndexing, needsEmbedding, hasLocation, preferredThumbnailPath } = result;
        metadataRefreshed += result.metadataRefreshed;
        if (hasLocation) geotaggedDuringRun += 1;
        else locationUnknownDuringRun += 1;

        if (existing && (existing.resolved_time_ms === 0 || existing.resolved_time_ms === -1)) {
          console.log(`[Indexer] Re-indexed corrupted 1970/reset file: ${file.path} -> Resolved: ${new Date(result.resolved.resolvedTimeMs).toISOString()} (${result.resolved.source})`);
        }

        if (needsVisualIndexing) {
          if (file.mediaType === 'video') {
            const visualJob = {
              mediaId,
              filePath: file.path,
              decodablePath,
              mediaType: file.mediaType,
              thumbnailPath,
              preferredThumbnailPath,
              skipDetection: true,
            };
            if (deferVisualIndexing) {
              pendingVisualJobs.push(visualJob);
            } else {
              await processVisualJob(db, visualJob);
            }
          } else if (shouldSkipVisualAnalysis(file, thumbnailPath, ctx)) {
            updateMediaVisualAnalysis(db, mediaId, { tags: '', faceCount: 0 }, { faceIndexComplete: true });
          } else {
            const visualJob = {
              mediaId, filePath: file.path, decodablePath, mediaType: file.mediaType, thumbnailPath,
              detectionInputPath: file.mediaType === 'image' ? await ensureAnalysisProxy(analysisDir, file, ctx) : file.path,
              needsFaceIndexing: false,
            };
            if (deferVisualIndexing) {
              pendingVisualJobs.push(visualJob);
            } else {
              const visualResult = await processVisualJob(db, visualJob);
              if (visualResult?.faceJob) {
                if (deferFaceIndexing) pendingFaceJobs.push(visualResult.faceJob);
                else await processFaceJob(db, visualResult.faceJob, inlineMatcher);
              }
            }
          }
        }

        if (needsFaceIndexing) {
          if (shouldSkipVisualAnalysis(file, thumbnailPath, ctx)) {
            db.prepare('UPDATE media_items SET faces_indexed = 1 WHERE id = ?').run(mediaId);
          } else {
            const faceJob = { mediaId, filePath: file.path, decodablePath, thumbnailPath };
            if (deferFaceIndexing) pendingFaceJobs.push(faceJob);
            else await processFaceJob(db, faceJob, inlineMatcher);
          }
        }

        if (needsEmbedding) {
          const embeddingJob = { mediaId, filePath: file.path, decodablePath, mediaType: file.mediaType };
          if (deferSemanticEmbedding) {
            pendingEmbeddingJobs.push(embeddingJob);
          } else {
            await processEmbeddingJob(db, embeddingJob);
          }
        }
      } finally {
        if (result.ctx) result.ctx.dispose();
      }
    }));
  }

  console.log(`[Indexer] Location metadata summary: ${geotaggedDuringRun} with GPS, ${locationUnknownDuringRun} without (processed ${toProcess.length}).`);
  if (!skipMarkMissing) {
    queries.markMissing.run(runId);
  }
  const activeRecords = getActiveMediaItems(db);
  const rebuildStartedAt = Date.now();
  const events = buildEvents(activeRecords);
  replaceEvents(db, events);
  const finishedAt = Date.now();

  return {
    latestRun: {
      scannedCount: scanned.length,
      toProcessCount: toProcess.length,
      refreshed: metadataRefreshed,
      eventsCount: events.length,
      roots,
      batchSize,
      timingsMs: {
        scan: scanCompletedAt - startedAt,
        process: rebuildStartedAt - processingStartedAt,
        rebuild: finishedAt - rebuildStartedAt,
        total: finishedAt - startedAt,
      },
    },
    pendingVisualJobs,
    pendingFaceJobs,
    pendingEmbeddingJobs,
  };
}

async function processVisualJob(db, job) {
  if (!job || !job.filePath || !fs.existsSync(job.filePath)) return null;

  let targetPath = job.decodablePath || job.filePath;
  let framePath = null;
  let thumbnailPath = job.thumbnailPath || null;
  try {
    if (job.mediaType === 'video') {
      framePath = await extractFrame(job.filePath, { persist: true });
      if (!framePath) {
        updateMediaVisualAnalysis(db, job.mediaId, { tags: '', faceCount: 0 }, { faceIndexComplete: true });
        return null;
      }
      targetPath = framePath;
      const desiredThumbnailPath = job.preferredThumbnailPath || thumbnailPath;
      const needsThumbnail = desiredThumbnailPath && (!thumbnailPath || !fs.existsSync(thumbnailPath));
      if (needsThumbnail) {
        try {
          const writtenPath = await writeJpegThumbnail(framePath, desiredThumbnailPath, {
            width: 256,
            quality: 82,
          });
          if (writtenPath) {
            thumbnailPath = writtenPath;
            db.prepare('UPDATE media_items SET thumbnail_path = ? WHERE id = ?').run(thumbnailPath, job.mediaId);
          }
        } catch (error) {
          console.error(`Video thumbnail generation failed for ${job.filePath}:`, error.message);
        }
      }
      if (job.skipDetection === true) {
        updateMediaVisualAnalysis(db, job.mediaId, { tags: '', faceCount: 0 }, { faceIndexComplete: true });
        return null;
      }
    }

    const detectionInputPath = job.detectionInputPath && fs.existsSync(job.detectionInputPath)
      ? job.detectionInputPath
      : targetPath;
    const analysis = await detectMedia(targetPath, { detectionInputPath });
    const needsFaces = job.mediaType === 'image' && job.needsFaceIndexing;
    updateMediaVisualAnalysis(db, job.mediaId, analysis, { faceIndexComplete: !needsFaces });

    if (needsFaces) {
      return {
        faceJob: {
          mediaId: job.mediaId,
          filePath: job.filePath,
          decodablePath: job.decodablePath,
          thumbnailPath: job.thumbnailPath,
        },
      };
    }
    return null;
  } catch (error) {
    console.error(`Visual analysis failed for ${job.filePath}:`, error);
    return null;
  } finally {
    if (framePath && path.dirname(framePath).includes(`${path.sep}temp`)) {
      try { fs.unlinkSync(framePath); } catch (_) { }
    }
  }
}

async function processPendingVisualJobs(db, jobs, options = {}) {
  const { onProgress, yieldMs = 0, beforeBatch = null, onFaceJob = null } = options;
  const startedAt = Date.now();
  const pendingJobs = Array.isArray(jobs) ? jobs.filter(Boolean) : [];
  const total = pendingJobs.length;
  const thumbnailOnlyQueue = total > 0 && pendingJobs.every((job) => isThumbnailOnlyVisualJob(job));
  const batchSize = thumbnailOnlyQueue ? 4 : getVisualBatchSize();
  const effectiveYieldMs = thumbnailOnlyQueue ? Math.min(yieldMs, 20) : yieldMs;
  const pendingFaceJobs = [];

  for (let index = 0; index < pendingJobs.length; index += batchSize) {
    if (typeof beforeBatch === 'function') {
      await beforeBatch();
    }
    if (typeof onProgress === 'function') {
      onProgress({
        current: index,
        total,
        percentage: total > 0 ? Math.round((index / total) * 100) : 100,
      });
    }
    const batch = pendingJobs.slice(index, index + batchSize);
    const results = await Promise.all(batch.map((job) => processVisualJob(db, job)));
    results.forEach((result) => {
      if (result?.faceJob) {
        if (typeof onFaceJob === 'function') {
          onFaceJob(result.faceJob);
        } else {
          pendingFaceJobs.push(result.faceJob);
        }
      }
    });
    if (yieldMs > 0 && index + batchSize < pendingJobs.length) {
      await sleep(yieldMs);
    }
  }

  if (typeof onProgress === 'function') {
    onProgress({
      current: total,
      total,
      percentage: 100,
    });
  }

  return {
    total,
    durationMs: Date.now() - startedAt,
    pendingFaceJobs,
  };
}

async function generateFaceThumbnail(filePath, box, ctx = null, decodablePath = null) {
  try {
    const { app } = require('electron');
    const userDataPath = app.getPath('userData');
    const facesDir = path.join(userDataPath, 'face-thumbnails');
    if (!fs.existsSync(facesDir)) fs.mkdirSync(facesDir, { recursive: true });
    const thumbPath = path.join(facesDir, `face_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.jpg`);
    const writtenPath = await writeFaceThumbnail(decodablePath || ctx?.decodablePath || filePath, thumbPath, box, {
      width: 160,
      quality: 85,
    });
    return writtenPath || null;
  } catch (err) {
    console.error(`[FaceIndex] Face thumbnail failed:`, err.message);
    return null;
  }
}

async function applyFaceProcessingResult(db, job, faces, matcher = null) {
  const mediaRow = db.prepare('SELECT id, ai_tags, person_class, person_confidence FROM media_items WHERE id = ?').get(job.mediaId);
  if (!mediaRow) {
    console.warn(`[FaceIndex] Skipping face job for ${job.filePath}: media_id ${job.mediaId} no longer exists`);
    return;
  }

  if (isAnimalOnlyImage(mediaRow)) {
    deleteFacesForMediaId(db, job.mediaId);
    pruneOrphanPeople(db);
    console.log(`[FaceIndex] Skipping face detection for animal-only image: ${job.filePath} (tags: ${mediaRow.ai_tags})`);
    db.prepare('UPDATE media_items SET person_class = ?, faces_indexed = 1 WHERE id = ?').run('none', job.mediaId);
    return;
  }

  if ((mediaRow.person_class || 'none') === 'none' && hasAnimalTag(mediaRow)) {
    deleteFacesForMediaId(db, job.mediaId);
    pruneOrphanPeople(db);
    console.log(`[FaceIndex] Rejecting likely animal false-positive face(s): ${job.filePath} (tags: ${mediaRow.ai_tags}, detections: ${faces.length})`);
    db.prepare('UPDATE media_items SET person_class = ?, faces_indexed = 1 WHERE id = ?').run('none', job.mediaId);
    return;
  }

  if ((mediaRow.person_class || 'none') === 'none' && hasAnimalFilenameHint(job.filePath)) {
    deleteFacesForMediaId(db, job.mediaId);
    pruneOrphanPeople(db);
    console.log(`[FaceIndex] Rejecting animal filename false-positive face(s): ${job.filePath} (${faces.length} detection(s))`);
    db.prepare('UPDATE media_items SET person_class = ?, faces_indexed = 1 WHERE id = ?').run('none', job.mediaId);
    return;
  }

  deleteFacesForMediaId(db, job.mediaId);
  for (const face of faces) {
    let personId = matcher
      ? matcher.findClosest(face.embedding, PERSON_MATCH_THRESHOLD)
      : findClosestPerson(db, face.embedding, PERSON_MATCH_THRESHOLD);
    if (!personId) {
      const faceThumbnail = await generateFaceThumbnail(job.filePath, face.box, null, job.decodablePath);
      personId = createPerson(db, `Person ${Math.floor(Math.random() * 1000)}`, faceThumbnail || job.thumbnailPath, face.embedding);
      if (matcher) matcher.add(personId, face.embedding);
    }
    const personExists = db.prepare('SELECT id FROM people WHERE id = ?').get(personId);
    if (!personExists) {
      console.warn(`[FaceIndex] Skipping face insert: person ${personId} no longer exists`);
      continue;
    }
    insertFace(db, job.mediaId, personId, face.box, face.embedding);
  }

  const CROSS_VALIDATE_THRESHOLD = 0.75;
  const detectorClass = mediaRow.person_class || 'none';
  const detectorConf = mediaRow.person_confidence || 0;
  let correctedClass;

  if (faces.length === 0) {
    correctedClass = (detectorClass !== 'none' && detectorConf >= CROSS_VALIDATE_THRESHOLD)
      ? detectorClass
      : 'none';
  } else if (faces.length === 1) {
    correctedClass = 'portrait';
  } else {
    correctedClass = 'group';
  }

  if (correctedClass !== detectorClass) {
    console.log(`[FaceIndex] Cross-validation: ${detectorClass} -> ${correctedClass} for ${job.filePath} (${faces.length} face(s), confidence ${detectorConf.toFixed(2)})`);
    db.prepare('UPDATE media_items SET person_class = ?, faces_indexed = 1 WHERE id = ?').run(correctedClass, job.mediaId);
  } else {
    db.prepare('UPDATE media_items SET faces_indexed = 1 WHERE id = ?').run(job.mediaId);
  }
}

async function processFaceJob(db, job, matcher = null) {
  if (!job || !job.filePath || !fs.existsSync(job.filePath)) return;

  try {
    const { processFaces } = require('./face-service');
    const faceInputPath = job.decodablePath || job.filePath;
    const faces = await processFaces(faceInputPath);

    await applyFaceProcessingResult(db, job, faces, matcher);
  } catch (error) {
    console.error(`Face indexing failed for ${job.filePath}:`, error);
  }
}

async function processPendingFaceJobs(db, jobs, options = {}) {
  const { onProgress, yieldMs = 0, beforeBatch = null } = options;
  const startedAt = Date.now();
  const pendingJobs = Array.isArray(jobs) ? jobs.filter(Boolean) : [];
  const total = pendingJobs.length;
  const matcher = createPersonMatcher(db);
  const batchSize = getFaceBatchSize();

  for (let index = 0; index < pendingJobs.length; index += batchSize) {
    if (typeof beforeBatch === 'function') {
      await beforeBatch();
    }
    if (typeof onProgress === 'function') {
      onProgress({
        current: index,
        total,
        percentage: total > 0 ? Math.round((index / total) * 100) : 100,
      });
    }
    const batch = pendingJobs.slice(index, index + batchSize);
    await Promise.all(batch.map((job) => processFaceJob(db, job, matcher)));
    if (yieldMs > 0 && index + batchSize < pendingJobs.length) {
      await sleep(yieldMs);
    }
  }

  pruneOrphanPeople(db);

  if (typeof onProgress === 'function') {
    onProgress({
      current: total,
      total,
      percentage: 100,
    });
  }

  return {
    total,
    durationMs: Date.now() - startedAt,
  };
}

async function applyProcessedFaceBatch(db, processedJobs, options = {}) {
  const { onProgress, yieldMs = 0, beforeBatch = null } = options;
  const startedAt = Date.now();
  const pendingJobs = Array.isArray(processedJobs) ? processedJobs.filter(Boolean) : [];
  const total = pendingJobs.length;
  const matcher = createPersonMatcher(db);
  const batchSize = getFaceBatchSize();

  for (let index = 0; index < pendingJobs.length; index += batchSize) {
    if (typeof beforeBatch === 'function') {
      await beforeBatch();
    }
    if (typeof onProgress === 'function') {
      onProgress({
        current: index,
        total,
        percentage: total > 0 ? Math.round((index / total) * 100) : 100,
      });
    }
    const batch = pendingJobs.slice(index, index + batchSize);
    await Promise.all(batch.map(async (job) => {
      const faces = Array.isArray(job.faces)
        ? job.faces
          .filter(Boolean)
          .map((face) => ({
            ...face,
            embedding: face.embedding ? Buffer.from(face.embedding, 'base64') : null,
          }))
          .filter((face) => face.embedding)
        : [];
      await applyFaceProcessingResult(db, job, faces, matcher);
    }));
    if (effectiveYieldMs > 0 && index + batchSize < pendingJobs.length) {
      await sleep(effectiveYieldMs);
    }
  }

  pruneOrphanPeople(db);

  if (typeof onProgress === 'function') {
    onProgress({
      current: total,
      total,
      percentage: 100,
    });
  }

  return {
    total,
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// StreamingFaceQueue — processes face jobs as they arrive from the visual
// pipeline, rather than waiting for all visual jobs to finish first.
// ---------------------------------------------------------------------------

function createStreamingFaceQueue(db, options = {}) {
  const { onProgress, yieldMs = 0, beforeBatch = null } = options;
  const queue = [];
  let processed = 0;
  let totalKnown = 0;
  let resolveIdle = null;
  let idlePromise = null;
  let producerDone = false;
  let running = false;
  const startedAt = Date.now();
  const matcher = createPersonMatcher(db);
  const batchSize = getFaceBatchSize();

  function resetIdle() {
    if (!idlePromise) {
      idlePromise = new Promise((resolve) => { resolveIdle = resolve; });
    }
  }

  function checkIdle() {
    if (queue.length === 0 && resolveIdle) {
      const fn = resolveIdle;
      resolveIdle = null;
      idlePromise = null;
      fn();
    }
  }

  function push(job) {
    if (job) {
      queue.push(job);
      totalKnown++;
      resetIdle();
      if (!running) drain();
    }
  }

  function markProducerDone() {
    producerDone = true;
    checkIdle();
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
        if (typeof beforeBatch === 'function') {
          await beforeBatch();
        }
        const batch = queue.splice(0, batchSize);
        if (typeof onProgress === 'function') {
          onProgress({
            current: processed,
            total: totalKnown,
            percentage: totalKnown > 0 ? Math.round((processed / totalKnown) * 100) : 0,
          });
        }
        await Promise.all(batch.map((job) => processFaceJob(db, job, matcher)));
        processed += batch.length;
        if (yieldMs > 0 && queue.length > 0) {
          await sleep(yieldMs);
        }
      }
    } finally {
      running = false;
      checkIdle();
    }
  }

  async function waitUntilDone() {
    while (true) {
      if (queue.length > 0) {
        resetIdle();
        await drain();
      }
      if (producerDone && queue.length === 0) break;
      resetIdle();
      await idlePromise;
      if (producerDone && queue.length === 0) break;
    }
    pruneOrphanPeople(db);
    if (typeof onProgress === 'function') {
      onProgress({ current: processed, total: totalKnown, percentage: 100 });
    }
    return { total: processed, durationMs: Date.now() - startedAt };
  }

  return { push, markProducerDone, waitUntilDone, getProcessed: () => processed, getTotal: () => totalKnown };
}

async function processEmbeddingJob(db, job) {
  if (!job || !job.filePath || !fs.existsSync(job.filePath)) return;

  let targetPath = job.decodablePath || job.filePath;
  let framePath = null;
  try {
    if (job.mediaType === 'video') {
      framePath = await extractFrame(job.filePath, { persist: true });
      if (!framePath) return;
      targetPath = framePath;
    }
    const embedding = await embedVisualMedia(targetPath);
    if (embedding) {
      updateMediaEmbedding(db, job.mediaId, embedding);
    }
  } catch (error) {
    console.error(`Semantic embedding failed for ${job.filePath}:`, error);
  } finally {
    if (framePath && path.dirname(framePath).includes(`${path.sep}temp`)) {
      try { fs.unlinkSync(framePath); } catch (_) { }
    }
  }
}

async function processPendingEmbeddingJobs(db, jobs, options = {}) {
  const { onProgress, yieldMs = 0, beforeBatch = null } = options;
  const startedAt = Date.now();
  const pendingJobs = Array.isArray(jobs) ? jobs.filter(Boolean) : [];
  const total = pendingJobs.length;
  const batchSize = getFaceBatchSize();

  for (let index = 0; index < pendingJobs.length; index += batchSize) {
    if (typeof beforeBatch === 'function') {
      await beforeBatch();
    }
    if (typeof onProgress === 'function') {
      onProgress({
        current: index,
        total,
        percentage: total > 0 ? Math.round((index / total) * 100) : 100,
      });
    }
    const batch = pendingJobs.slice(index, index + batchSize);
    await Promise.all(batch.map((job) => processEmbeddingJob(db, job)));
    if (yieldMs > 0 && index + batchSize < pendingJobs.length) {
      await sleep(yieldMs);
    }
  }

  if (typeof onProgress === 'function') {
    onProgress({
      current: total,
      total,
      percentage: 100,
    });
  }

  return {
    total,
    durationMs: Date.now() - startedAt,
  };
}

async function processMetadataBatches(db, app, scannedFiles, options = {}) {
  const {
    batchSize = 2,
    yieldMs = 0,
    beforeBatch = null,
    onProgress = null,
    onRefresh = null,
    skipMarkMissing = false,
    mediaAssetWorker = null,
  } = options;
  const startedAt = Date.now();
  const runId = Date.now();
  const { roots, includeVideos } = getMediaRoots(db, app);

  let scanned;
  if (Array.isArray(scannedFiles) && scannedFiles.length > 0) {
    scanned = scannedFiles;
  } else {
    const scanResults = await Promise.all(roots.map((root) => walkMediaFilesAsync(root, { includeVideos })));
    scanned = scanResults.flat();
  }

  const queries = upsertMediaItems(db, scanned, runId);
  const existingItems = db.prepare(
    'SELECT id, path, mtime_ms, size, faces_indexed, visual_indexed, ai_tags, face_count, embedding, resolved_time_ms, resolved_source, latitude, longitude, location_source, place_name, person_class, confidence, thumbnail_path FROM media_items'
  ).all();
  const existingMap = new Map(existingItems.map((item) => [item.path, item]));
  const pendingJobRows = db.prepare(`
    SELECT media_id, stage
    FROM index_jobs
    WHERE status = 'pending'
  `).all();
  const pendingVisualIds = new Set(pendingJobRows.filter((row) => row.stage === 'visual').map((row) => row.media_id));
  const pendingFaceIds = new Set(pendingJobRows.filter((row) => row.stage === 'face').map((row) => row.media_id));
  const pendingEmbeddingIds = new Set(pendingJobRows.filter((row) => row.stage === 'embedding').map((row) => row.media_id));

  const toProcess = scanned.filter((file) => {
    const existing = existingMap.get(file.path);
    if (!existing) return true;
    if (!existing.resolved_source || existing.resolved_source === 'pending') return true;
    if (existing.mtime_ms !== file.mtimeMs || existing.size !== file.size) return true;
    if (existing.resolved_time_ms === 0 || existing.resolved_time_ms === -1) return true;

    if (file.mediaType === 'image' || file.mediaType === 'video') {
      if (!existing.visual_indexed && !pendingVisualIds.has(existing.id)) return true;
      if (shouldIndexEmbeddingForFile(file) && !existing.embedding && !pendingEmbeddingIds.has(existing.id)) return true;
    }

    if (file.mediaType === 'image') {
      if (existing.latitude == null || existing.longitude == null) return true;
      if (shouldRefreshPlaceName(existing)) return true;
      if (!existing.faces_indexed && !pendingFaceIds.has(existing.id)) return true;
    }

    queries.updateLastSeen.run(runId, file.path);
    return false;
  });

  const total = toProcess.length;
  console.log(`[Metadata] Background processing ${total} files in batches of ${batchSize}`);

  const pendingVisualJobs = [];
  const pendingFaceJobs = [];
  const pendingEmbeddingJobs = [];
  let processed = 0;
  let lastRefreshAt = Date.now();
  let lastRefreshProcessed = 0;
  const REFRESH_INTERVAL_MS = total >= 5000 ? 45_000 : (total >= 2000 ? 30_000 : 15_000);
  const REFRESH_MIN_ITEMS = total >= 5000 ? 500 : (total >= 2000 ? 250 : 50);

  const userDataPath = app.getPath('userData');
  const thumbDir = path.join(userDataPath, 'thumbnails');
  const analysisDir = path.join(userDataPath, 'analysis-cache');
  const heicDir = getConvertDir(app);
  if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });
  if (!fs.existsSync(analysisDir)) fs.mkdirSync(analysisDir, { recursive: true });

  for (let index = 0; index < toProcess.length; index += batchSize) {
    if (typeof beforeBatch === 'function') await beforeBatch();

    const batch = toProcess.slice(index, index + batchSize);

    await Promise.all(batch.map(async (file) => {
      const existing = queries.selectByPath.get(file.path);
      const result = await resolveFileMetadata(db, file, existing, { thumbDir, analysisDir, heicDir, queries, runId, mediaAssetWorker });
      try {
        const { mediaId, decodablePath, thumbnailPath, ctx, needsVisualIndexing, needsFaceIndexing, needsEmbedding, precomputedAnalysisProxyPath, preferredThumbnailPath } = result;

        if (needsVisualIndexing) {
          if (file.mediaType === 'video') {
            pendingVisualJobs.push({
              mediaId,
              filePath: file.path,
              decodablePath,
              mediaType: file.mediaType,
              thumbnailPath,
              preferredThumbnailPath,
              skipDetection: true,
            });
          } else if (shouldSkipVisualAnalysis(file, thumbnailPath, ctx)) {
            updateMediaVisualAnalysis(db, mediaId, { tags: '', faceCount: 0 }, { faceIndexComplete: true });
          } else {
            pendingVisualJobs.push({
              mediaId, filePath: file.path, decodablePath, mediaType: file.mediaType, thumbnailPath,
              detectionInputPath: file.mediaType === 'image'
                ? await ensureAnalysisProxy(analysisDir, file, ctx, precomputedAnalysisProxyPath)
                : file.path,
              needsFaceIndexing: false,
            });
          }
        }

        if (needsFaceIndexing) {
          if (shouldSkipVisualAnalysis(file, thumbnailPath, ctx)) {
            db.prepare('UPDATE media_items SET faces_indexed = 1 WHERE id = ?').run(mediaId);
          } else {
            pendingFaceJobs.push({ mediaId, filePath: file.path, decodablePath, thumbnailPath });
          }
        }

        if (needsEmbedding) {
          pendingEmbeddingJobs.push({ mediaId, filePath: file.path, decodablePath, mediaType: file.mediaType });
        }
      } finally {
        if (result.ctx) result.ctx.dispose();
      }
    }));

    processed += batch.length;

    if (typeof onProgress === 'function') {
      onProgress({
        current: processed,
        total,
        percentage: total > 0 ? Math.round((processed / total) * 100) : 100,
      });
    }

    const now = Date.now();
    const shouldRefreshByWork = processed - lastRefreshProcessed >= REFRESH_MIN_ITEMS;
    const shouldRefreshByTime = now - lastRefreshAt >= REFRESH_INTERVAL_MS;
    if (typeof onRefresh === 'function' && ((shouldRefreshByWork && shouldRefreshByTime) || processed >= total)) {
      const activeRecords = getActiveMediaItems(db);
      const events = buildEvents(activeRecords);
      replaceEvents(db, events);
      lastRefreshAt = now;
      lastRefreshProcessed = processed;
      onRefresh({ processed, total, eventsCount: events.length });
    }

    if (yieldMs > 0 && index + batchSize < toProcess.length) {
      await sleep(yieldMs);
    }
  }

  if (!skipMarkMissing) {
    const markMissing = db.prepare('UPDATE media_items SET is_missing = 1 WHERE last_seen_run < ?');
    markMissing.run(runId);
  }

  if (total > 0) {
    const activeRecords = getActiveMediaItems(db);
    const events = buildEvents(activeRecords);
    replaceEvents(db, events);
  }

  const finishedAt = Date.now();
  console.log(`[Metadata] Background processing complete: ${total} files in ${finishedAt - startedAt}ms`);

  return {
    latestRun: {
      scannedCount: scanned.length,
      toProcessCount: total,
      refreshed: total,
      eventsCount: 0,
      roots: [],
      batchSize,
      timingsMs: {
        scan: 0,
        process: finishedAt - startedAt,
        rebuild: 0,
        total: finishedAt - startedAt,
      },
    },
    pendingVisualJobs,
    pendingFaceJobs,
    pendingEmbeddingJobs,
  };
}

module.exports = {
  runIndexing,
  processMetadataBatches,
  processPendingVisualJobs,
  processPendingFaceJobs,
  applyProcessedFaceBatch,
  processPendingEmbeddingJobs,
  createStreamingFaceQueue,
  applyFaceProcessingResult,
};

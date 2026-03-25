const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { BrowserWindow } = require('electron');
const { getMediaRoots, walkMediaFiles } = require('./scanner');
const { resolveMediaMetadata } = require('./metadata');
const { buildEvents } = require('./cluster');
const {
  upsertMediaItems,
  getActiveMediaItems,
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
const PERSON_MATCH_THRESHOLD = 0.82;

function shouldRefreshPlaceName(existing) {
  if (existing.latitude == null || existing.longitude == null) return false;
  if (!existing.place_name) return true;
  return /[^\x00-\x7F]/.test(existing.place_name);
}

function getIndexBatchSize() {
  const cpuCount = Array.isArray(os.cpus()) ? os.cpus().length : 4;
  return Math.max(2, Math.min(6, Math.floor(cpuCount / 2)));
}

function getFaceBatchSize() {
  const cpuCount = Array.isArray(os.cpus()) ? os.cpus().length : 4;
  return Math.max(1, Math.min(3, Math.floor(cpuCount / 4) || 1));
}

function getVisualBatchSize() {
  const cpuCount = Array.isArray(os.cpus()) ? os.cpus().length : 4;
  return Math.max(1, Math.min(2, Math.floor(cpuCount / 6) || 1));
}

function getImageDimensions(filePath) {
  try {
    const { nativeImage } = require('electron');
    const image = nativeImage.createFromPath(filePath);
    if (image.isEmpty()) return null;
    return image.getSize();
  } catch (_) {
    return null;
  }
}

function getImageProfile(filePath, sampleSize = 32) {
  try {
    const { nativeImage } = require('electron');
    const image = nativeImage.createFromPath(filePath);
    if (image.isEmpty()) return null;

    const { width, height } = image.getSize();
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

function shouldSkipVisualAnalysis(file, thumbnailPath = null) {
  if (!file || file.mediaType !== 'image') return false;

  const normalizedPath = file.path.replace(/\\/g, '/').toLowerCase();
  if (/(^|\/)(screenshots?|screen ?shots?|screen ?caps?)(\/|$)/i.test(normalizedPath)) {
    return true;
  }

  const baseName = path.basename(file.path).toLowerCase();
  if (/(^|[\s_(.-])screenshot([\s_).-]|$)/i.test(baseName)) {
    return true;
  }

  const dimensions = getImageDimensions(file.path);
  if (!dimensions) return false;

  // Tiny images are usually icons, stickers, or UI fragments, not useful memory photos.
  if (Math.min(dimensions.width, dimensions.height) < 180) {
    return true;
  }

  const profileSource = thumbnailPath && fs.existsSync(thumbnailPath) ? thumbnailPath : file.path;
  const profile = getImageProfile(profileSource);
  if (!profile) return false;

  // Staged mobile-gallery-style gate: obvious screen/UI captures are filtered from the expensive detector path.
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

function hasUsablePersonDetections(detections) {
  if (!Array.isArray(detections)) return null;
  return detections.some((d) => d.label === 'person' && d.score >= 0.7);
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

function ensureAnalysisProxy(proxyDir, file) {
  const proxyPath = getAnalysisProxyPath(proxyDir, file);
  if (fs.existsSync(proxyPath)) return proxyPath;

  try {
    const { nativeImage } = require('electron');
    const image = nativeImage.createFromPath(file.path);
    if (image.isEmpty()) return file.path;

    const { width, height } = image.getSize();
    const longestSide = Math.max(width, height);
    if (!Number.isFinite(longestSide) || longestSide <= 1536) return file.path;

    const scale = 1536 / longestSide;
    const resized = image.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: 'better',
    });
    fs.writeFileSync(proxyPath, resized.toJPEG(85));
    return proxyPath;
  } catch (error) {
    console.error(`Analysis proxy generation failed for ${file.path}:`, error);
    return file.path;
  }
}

async function runIndexing(db, app, options = {}) {
  const {
    deferVisualIndexing = false,
    deferFaceIndexing = false,
    deferSemanticEmbedding = false,
    scannedFiles = null,
    skipMarkMissing = false,
  } = options;
  const startedAt = Date.now();
  const runId = Date.now();
  const { roots, includeVideos } = getMediaRoots(db, app);
  const scanned = Array.isArray(scannedFiles) ? scannedFiles : roots.flatMap((root) => walkMediaFiles(root, { includeVideos }));
  const scanCompletedAt = Date.now();

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

  const existingItems = db.prepare('SELECT id, path, mtime_ms, size, faces_indexed, visual_indexed, ai_tags, face_count, embedding, resolved_time_ms, resolved_source, latitude, longitude, location_source, place_name, confidence FROM media_items').all();
  const existingMap = new Map(existingItems.map((item) => [item.path, item]));

  const toProcess = scanned.filter((file) => {
    const existing = existingMap.get(file.path);
    if (!existing) return true;
    if (existing.mtime_ms !== file.mtimeMs || existing.size !== file.size) return true;
    if (existing.resolved_time_ms === 0 || existing.resolved_time_ms === -1) return true;

    if (file.mediaType === 'image' || file.mediaType === 'video') {
      if (!existing.visual_indexed) return true;
      if (!existing.embedding) return true;
    }

    if (file.mediaType === 'image') {
      const missingLocation = existing.latitude == null || existing.longitude == null;
      if (missingLocation) return true;
      if (shouldRefreshPlaceName(existing)) return true;
      if (!existing.faces_indexed) return true;
    }

    queries.updateLastSeen.run(runId, file.path);
    return false;
  });

  console.log(`[Indexer] Scanned ${scanned.length} files. ${toProcess.length} need processing.`);

  const pendingVisualJobs = [];
  const pendingFaceJobs = [];
  const pendingEmbeddingJobs = [];
  const batchSize = getIndexBatchSize();
  const processingStartedAt = Date.now();

  for (let index = 0; index < toProcess.length; index += batchSize) {
    const batch = toProcess.slice(index, index + batchSize);

    const progress = Math.round((index / Math.max(1, toProcess.length)) * 100);
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      mainWindow.webContents.send('indexing-progress', {
        percentage: progress,
        current: index,
        total: toProcess.length,
        message: `Analyzing: ${index} / ${toProcess.length}`,
      });
    }

    const userDataPath = app.getPath('userData');
    const thumbDir = path.join(userDataPath, 'thumbnails');
    const analysisDir = path.join(userDataPath, 'analysis-cache');
    if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });
    if (!fs.existsSync(analysisDir)) fs.mkdirSync(analysisDir, { recursive: true });

    await Promise.all(batch.map(async (file) => {
      const existing = queries.selectByPath.get(file.path);
      let resolved;
      let thumbnailPath = existing ? existing.thumbnail_path : null;
      if (existing && existing.mtime_ms === file.mtimeMs && existing.size === file.size) {
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
          const refreshedMetadata = await resolveMediaMetadata(file);
          resolved.latitude = refreshedMetadata.latitude;
          resolved.longitude = refreshedMetadata.longitude;
          resolved.locationSource = refreshedMetadata.locationSource;
          resolved.source = refreshedMetadata.source || resolved.source;
          resolved.resolvedTimeMs = refreshedMetadata.resolvedTimeMs || resolved.resolvedTimeMs;
          resolved.confidence = refreshedMetadata.confidence || resolved.confidence;
          if (typeof refreshedMetadata.latitude === 'number' && typeof refreshedMetadata.longitude === 'number') {
            resolved.placeName = await reverseGeocode(db, refreshedMetadata.latitude, refreshedMetadata.longitude);
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
        resolved.aiTags = null;
        resolved.faceCount = null;
        resolved.embedding = null;
        metadataRefreshed += 1;
      }

      const hasLocation = typeof resolved.latitude === 'number' && typeof resolved.longitude === 'number';
      if (hasLocation) {
        geotaggedDuringRun += 1;
        console.log(`[Indexer] Location metadata available for ${file.path} (${resolved.latitude.toFixed(6)}, ${resolved.longitude.toFixed(6)}) source=${resolved.locationSource || 'index'}`);
      } else {
        locationUnknownDuringRun += 1;
        console.log(`[Indexer] No GPS metadata for ${file.path}`);
      }

      if (file.mediaType === 'image' && (!thumbnailPath || !fs.existsSync(thumbnailPath))) {
        try {
          const { nativeImage } = require('electron');
          const img = nativeImage.createFromPath(file.path);
          if (!img.isEmpty()) {
            const thumb = img.resize({ width: 256, quality: 'better' });
            const thumbPath = getThumbnailPath(thumbDir, file);
            fs.writeFileSync(thumbPath, thumb.toJPEG(80));
            thumbnailPath = thumbPath;
          }
        } catch (err) {
          console.error(`Thumbnail generation failed for ${file.path}:`, err);
        }
      }

      if (existing && (existing.resolved_time_ms === 0 || existing.resolved_time_ms === -1)) {
        console.log(`[Indexer] Re-indexed corrupted 1970/reset file: ${file.path} -> Resolved: ${new Date(resolved.resolvedTimeMs).toISOString()} (${resolved.source})`);
      }

      const isChangedOrNew = !existing || existing.mtime_ms !== file.mtimeMs || existing.size !== file.size;
      const needsVisualIndexing = (file.mediaType === 'image' || file.mediaType === 'video')
        && (isChangedOrNew || !existing?.visual_indexed);
      const needsFaceIndexing = file.mediaType === 'image'
        && (isChangedOrNew || !existing?.faces_indexed);
      const needsEmbedding = isChangedOrNew || !existing?.embedding;

      const runResult = queries.upsert.run({
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
        facesIndexed: needsFaceIndexing ? 0 : ((existing && existing.faces_indexed) ? 1 : 0),
        visualIndexed: needsVisualIndexing ? 0 : ((existing && existing.visual_indexed) ? 1 : 0),
        confidence: resolved.confidence,
      });

      const mediaId = existing ? existing.id : runResult.lastInsertRowid;

      if (needsVisualIndexing) {
        if (shouldSkipVisualAnalysis(file, thumbnailPath)) {
          updateMediaVisualAnalysis(
            db,
            mediaId,
            { tags: '', faceCount: 0 },
            { faceIndexComplete: true }
          );
        } else {
        const visualJob = {
          mediaId,
          filePath: file.path,
          mediaType: file.mediaType,
          thumbnailPath,
          detectionInputPath: file.mediaType === 'image' ? ensureAnalysisProxy(analysisDir, file) : file.path,
          needsFaceIndexing,
        };
        if (deferVisualIndexing) {
          pendingVisualJobs.push(visualJob);
        } else {
          const visualResult = await processVisualJob(db, visualJob);
          if (visualResult?.faceJob) {
            if (deferFaceIndexing) pendingFaceJobs.push(visualResult.faceJob);
            else await processFaceJob(db, visualResult.faceJob);
          }
        }
        }
      } else if (needsFaceIndexing) {
        const faceJob = { mediaId, filePath: file.path, thumbnailPath, detections: null };
        if (deferFaceIndexing) pendingFaceJobs.push(faceJob);
        else await processFaceJob(db, faceJob);
      }

      if (needsEmbedding) {
        const embeddingJob = {
          mediaId,
          filePath: file.path,
          mediaType: file.mediaType,
        };
        if (deferSemanticEmbedding) {
          pendingEmbeddingJobs.push(embeddingJob);
        } else {
          await processEmbeddingJob(db, embeddingJob);
        }
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

  let targetPath = job.filePath;
  let framePath = null;
  try {
    if (job.mediaType === 'video') {
      framePath = await extractFrame(job.filePath);
      if (!framePath) {
        updateMediaVisualAnalysis(db, job.mediaId, { tags: '', faceCount: 0 }, { faceIndexComplete: true });
        return null;
      }
      targetPath = framePath;
    }

    const detectionInputPath = job.detectionInputPath && fs.existsSync(job.detectionInputPath)
      ? job.detectionInputPath
      : targetPath;
    const analysis = await detectMedia(targetPath, { detectionInputPath });
    const hasPeople = job.mediaType === 'image' && job.needsFaceIndexing && hasUsablePersonDetections(analysis.objectDetections);
    updateMediaVisualAnalysis(db, job.mediaId, analysis, { faceIndexComplete: !hasPeople });

    if (hasPeople) {
      return {
        faceJob: {
          mediaId: job.mediaId,
          filePath: job.filePath,
          thumbnailPath: job.thumbnailPath,
          detections: analysis.objectDetections || null,
        },
      };
    }
    return null;
  } catch (error) {
    console.error(`Visual analysis failed for ${job.filePath}:`, error);
    return null;
  } finally {
    if (framePath) {
      try { fs.unlinkSync(framePath); } catch (_) {}
    }
  }
}

async function processPendingVisualJobs(db, jobs, options = {}) {
  const { onProgress, yieldMs = 0, beforeBatch = null } = options;
  const startedAt = Date.now();
  const pendingJobs = Array.isArray(jobs) ? jobs.filter(Boolean) : [];
  const total = pendingJobs.length;
  const batchSize = getVisualBatchSize();
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
      if (result?.faceJob) pendingFaceJobs.push(result.faceJob);
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

async function processFaceJob(db, job, matcher = null) {
  if (!job || !job.filePath || !fs.existsSync(job.filePath)) return;

  try {
    const { processFaces } = require('./face-service');
    const faces = await processFaces(job.filePath, { detections: job.detections || null });

    deleteFacesForMediaId(db, job.mediaId);
    for (const face of faces) {
      let personId = matcher
        ? matcher.findClosest(face.embedding, PERSON_MATCH_THRESHOLD)
        : findClosestPerson(db, face.embedding, PERSON_MATCH_THRESHOLD);
      if (!personId) {
        personId = createPerson(db, `Person ${Math.floor(Math.random() * 1000)}`, job.thumbnailPath, face.embedding);
        if (matcher) matcher.add(personId, face.embedding);
      }
      insertFace(db, job.mediaId, personId, face.box, face.embedding);
    }
    db.prepare('UPDATE media_items SET faces_indexed = 1 WHERE id = ?').run(job.mediaId);
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

async function processEmbeddingJob(db, job) {
  if (!job || !job.filePath || !fs.existsSync(job.filePath)) return;

  let targetPath = job.filePath;
  let framePath = null;
  try {
    if (job.mediaType === 'video') {
      framePath = await extractFrame(job.filePath);
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
    if (framePath) {
      try { fs.unlinkSync(framePath); } catch (_) {}
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

module.exports = {
  runIndexing,
  processPendingVisualJobs,
  processPendingFaceJobs,
  processPendingEmbeddingJobs,
};

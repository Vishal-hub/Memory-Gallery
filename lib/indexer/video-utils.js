const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { writeJpegThumbnail } = require('./image-ops');

ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

const MAX_CONCURRENT_FFMPEG = 2;
const _queue = [];
let _active = 0;
const FRAME_CACHE_DIR = path.join(os.homedir(), '.memory-desktop', 'video-frame-cache');

function drainFfmpegQueue() {
  while (_active < MAX_CONCURRENT_FFMPEG && _queue.length > 0) {
    const { videoPath, options, resolve } = _queue.shift();
    _active++;
    runExtraction(videoPath, options)
      .then(resolve)
      .finally(() => {
        _active--;
        drainFfmpegQueue();
      });
  }
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getVideoCacheKey(videoPath, stats = null) {
  const fileStats = stats || fs.statSync(videoPath);
  return crypto.createHash('sha1')
    .update(`${videoPath}|${fileStats.mtimeMs}|${fileStats.size}`)
    .digest('hex')
    .slice(0, 24);
}

function getCachedFramePath(videoPath, stats = null) {
  return path.join(FRAME_CACHE_DIR, `frame_${getVideoCacheKey(videoPath, stats)}.jpg`);
}

function runExtraction(videoPath, options = {}) {
  return new Promise((resolve) => {
    const tempDir = path.join(os.homedir(), '.memory-desktop', 'temp');
    ensureDir(tempDir);
    ensureDir(FRAME_CACHE_DIR);

    const persist = options.persist === true;
    let stats = null;
    try {
      stats = fs.statSync(videoPath);
    } catch (_) {
      resolve(null);
      return;
    }

    const cachedPath = persist ? getCachedFramePath(videoPath, stats) : null;
    if (cachedPath && fs.existsSync(cachedPath)) {
      resolve(cachedPath);
      return;
    }

    const uid = crypto.randomBytes(6).toString('hex');
    const outputFilename = `frame_${uid}.jpg`;
    const outputPath = path.join(tempDir, outputFilename);
    const normalizedPath = cachedPath || path.join(tempDir, `frame_${uid}_norm.jpg`);

    ffmpeg(videoPath)
      .screenshots({
        timestamps: ['50%'],
        filename: outputFilename,
        folder: tempDir,
        size: '300x?',
      })
      .on('end', async () => {
        try {
          if (!fs.existsSync(outputPath)) {
            resolve(null);
            return;
          }
          const rewrittenPath = await writeJpegThumbnail(outputPath, normalizedPath, { width: 300, quality: 88 });
          try { fs.unlinkSync(outputPath); } catch (_) { }
          resolve(rewrittenPath || null);
        } catch (error) {
          console.error(`Error normalizing frame from ${videoPath}:`, error.message);
          try { fs.unlinkSync(outputPath); } catch (_) { }
          try { fs.unlinkSync(normalizedPath); } catch (_) { }
          resolve(null);
        }
      })
      .on('error', (err) => {
        console.error(`Error extracting frame from ${videoPath}:`, err.message);
        resolve(null);
      });
  });
}

async function extractFrame(videoPath, options = {}) {
  return new Promise((resolve) => {
    _queue.push({ videoPath, options, resolve });
    drainFfmpegQueue();
  });
}

module.exports = {
  extractFrame,
  getCachedFramePath,
};

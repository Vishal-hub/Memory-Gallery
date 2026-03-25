const fs = require('fs');
const path = require('path');
const { SUPPORTED_MEDIA, VIDEO_EXTENSIONS } = require('./constants');

function getMediaRoots(db, app) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('index_roots');
    const includeVideosRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('include_videos');
    
    let roots = [];
    if (row) {
      try {
        roots = JSON.parse(row.value);
      } catch (e) {
        console.error('Failed to parse index_roots setting', e);
      }
    } else {
      roots = [app.getPath('pictures'), app.getPath('videos')].filter(Boolean);
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('index_roots', JSON.stringify(roots));
    }

    const includeVideos = includeVideosRow ? includeVideosRow.value === 'true' : true;
    return { roots, includeVideos };
  } catch (dbErr) {
    console.error('Database error in getMediaRoots:', dbErr);
    return { roots: [], includeVideos: true };
  }
}

function walkMediaFiles(rootPath, options = { includeVideos: true }) {
  const found = [];

  function walk(currentPath) {
    let entries = [];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch (error) {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!SUPPORTED_MEDIA.has(ext)) continue;

      const isVideo = VIDEO_EXTENSIONS.has(ext);
      if (isVideo && !options.includeVideos) continue;

      try {
        const stat = fs.statSync(fullPath);
        found.push({
          path: fullPath,
          ext,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          mediaType: isVideo ? 'video' : 'image',
        });
      } catch (error) {
        // Skip files that disappear during scan.
      }
    }
  }

  walk(rootPath);
  return found;
}

function getMediaFileRecord(filePath, options = { includeVideos: true }) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;

    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_MEDIA.has(ext)) return null;

    const isVideo = VIDEO_EXTENSIONS.has(ext);
    if (isVideo && !options.includeVideos) return null;

    return {
      path: filePath,
      ext,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      mediaType: isVideo ? 'video' : 'image',
    };
  } catch (_) {
    return null;
  }
}

module.exports = {
  getMediaRoots,
  walkMediaFiles,
  getMediaFileRecord,
};

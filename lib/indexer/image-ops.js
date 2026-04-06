const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { createRequire } = require('module');

let sharpInstance = null;
let sharpLoadAttempted = false;
const requireFromCwd = createRequire(path.join(process.cwd(), 'package.json'));

function getSharp() {
  if (sharpLoadAttempted) {
    return sharpInstance;
  }
  sharpLoadAttempted = true;
  try {
    const sharp = require('sharp');
    // Keep Sharp conservative on low-memory Windows machines.
    sharp.cache({ memory: 32, files: 0, items: 32 });
    sharp.concurrency(1);
    sharp.simd(true);
    sharpInstance = sharp;
  } catch (error) {
    try {
      const sharp = requireFromCwd('sharp');
      sharp.cache({ memory: 32, files: 0, items: 32 });
      sharp.concurrency(1);
      sharp.simd(true);
      sharpInstance = sharp;
    } catch (_) {
      sharpInstance = null;
    }
  }
  return sharpInstance;
}

function getNativeImage() {
  try {
    const { nativeImage } = require('electron');
    return nativeImage || null;
  } catch (_) {
    return null;
  }
}

async function writeJpegThumbnail(inputPath, outputPath, options = {}) {
  const {
    width = 256,
    quality = 80,
  } = options;
  const sharp = getSharp();

  if (sharp) {
    await sharp(inputPath, { failOn: 'none' })
      .rotate()
      .resize({ width, withoutEnlargement: true, fit: 'inside' })
      .jpeg({ quality, mozjpeg: true })
      .toFile(outputPath);
    return outputPath;
  }

  const nativeImage = getNativeImage();
  if (!nativeImage || typeof nativeImage.createFromPath !== 'function') {
    return null;
  }
  const image = nativeImage.createFromPath(inputPath);
  if (image.isEmpty()) {
    return null;
  }
  const thumb = image.resize({ width, quality: 'better' });
  await fsp.writeFile(outputPath, thumb.toJPEG(quality));
  return outputPath;
}

async function writeAnalysisProxy(inputPath, outputPath, options = {}) {
  const {
    maxSide = 1536,
    quality = 85,
  } = options;
  const sharp = getSharp();

  if (sharp) {
    const meta = await sharp(inputPath, { failOn: 'none' }).metadata();
    const width = Number(meta.width) || 0;
    const height = Number(meta.height) || 0;
    const longestSide = Math.max(width, height);
    if (!Number.isFinite(longestSide) || longestSide <= maxSide) {
      return null;
    }

    await sharp(inputPath, { failOn: 'none' })
      .rotate()
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toFile(outputPath);
    return outputPath;
  }

  const nativeImage = getNativeImage();
  if (!nativeImage || typeof nativeImage.createFromPath !== 'function') {
    return null;
  }
  const image = nativeImage.createFromPath(inputPath);
  if (image.isEmpty()) {
    return null;
  }
  const { width, height } = image.getSize();
  const longestSide = Math.max(width, height);
  if (!Number.isFinite(longestSide) || longestSide <= maxSide) {
    return null;
  }

  const scale = maxSide / longestSide;
  const resized = image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: 'better',
  });
  await fsp.writeFile(outputPath, resized.toJPEG(quality));
  return outputPath;
}

async function writeFaceThumbnail(inputPath, outputPath, box, options = {}) {
  const {
    width = 160,
    quality = 85,
  } = options;
  const sharp = getSharp();
  const [x1, y1, x2, y2] = box;

  if (sharp) {
    const meta = await sharp(inputPath, { failOn: 'none' }).metadata();
    const imgW = Number(meta.width) || 0;
    const imgH = Number(meta.height) || 0;
    if (imgW <= 0 || imgH <= 0) return null;

    const faceW = x2 - x1;
    const faceH = y2 - y1;
    const pad = Math.round(Math.max(faceW, faceH) * 0.35);
    const cx = Math.max(0, Math.floor(x1 - pad));
    const cy = Math.max(0, Math.floor(y1 - pad));
    const cw = Math.min(imgW - cx, Math.ceil(faceW + pad * 2));
    const ch = Math.min(imgH - cy, Math.ceil(faceH + pad * 2));
    if (cw < 10 || ch < 10) return null;

    await sharp(inputPath, { failOn: 'none' })
      .rotate()
      .extract({ left: cx, top: cy, width: cw, height: ch })
      .resize({ width, withoutEnlargement: true, fit: 'inside' })
      .jpeg({ quality, mozjpeg: true })
      .toFile(outputPath);
    return outputPath;
  }

  const nativeImage = getNativeImage();
  if (!nativeImage || typeof nativeImage.createFromPath !== 'function') {
    return null;
  }
  const image = nativeImage.createFromPath(inputPath);
  if (image.isEmpty()) return null;
  const { width: imgW, height: imgH } = image.getSize();
  const faceW = x2 - x1;
  const faceH = y2 - y1;
  const pad = Math.round(Math.max(faceW, faceH) * 0.35);
  const cx = Math.max(0, x1 - pad);
  const cy = Math.max(0, y1 - pad);
  const cw = Math.min(imgW - cx, faceW + pad * 2);
  const ch = Math.min(imgH - cy, faceH + pad * 2);
  if (cw < 10 || ch < 10) return null;

  const cropped = image.crop({ x: cx, y: cy, width: cw, height: ch });
  const resized = cropped.resize({ width, quality: 'better' });
  await fsp.writeFile(outputPath, resized.toJPEG(quality));
  return outputPath;
}

function hasSharpSupport() {
  return Boolean(getSharp());
}

module.exports = {
  hasSharpSupport,
  writeJpegThumbnail,
  writeAnalysisProxy,
  writeFaceThumbnail,
};

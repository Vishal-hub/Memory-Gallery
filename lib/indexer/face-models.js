const fs = require('fs');
const path = require('path');
const os = require('os');
const { createRequire } = require('module');
const ort = require('onnxruntime-node');

const MODELS_DIR = path.join(os.homedir(), '.memory-desktop', 'models', 'insightface');

const MODEL_URLS = {
  detector: 'https://huggingface.co/deepghs/insightface/resolve/4e1f33d3fe0e50a0945f3a53ab94ae8977ae7ddb/buffalo_s/det_500m.onnx',
  recognizer: 'https://huggingface.co/deepghs/insightface/resolve/4e1f33d3fe0e50a0945f3a53ab94ae8977ae7ddb/buffalo_s/w600k_mbf.onnx',
};

const MODEL_FILES = {
  detector: path.join(MODELS_DIR, 'det_500m.onnx'),
  recognizer: path.join(MODELS_DIR, 'w600k_mbf.onnx'),
};

const INPUT_SIZE = 640;
const FEAT_STRIDES = [8, 16, 32];
const NUM_ANCHORS = 2;
const ONNX_THREADS = Math.max(1, Math.min(os.cpus().length - 1, 4));
const FMC = 3;
const NMS_THRESHOLD = 0.4;
const DET_THRESHOLD = 0.6;

const ARCFACE_TEMPLATE = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

let detectorSessionPromise = null;
let recognizerSessionPromise = null;
let ensureModelsPromise = null;
const anchorCache = new Map();
const requireFromCwd = createRequire(path.join(process.cwd(), 'package.json'));
let sharpInstance = null;
let sharpLoadAttempted = false;

function getSharp() {
  if (sharpLoadAttempted) return sharpInstance;
  sharpLoadAttempted = true;
  try {
    const sharp = require('sharp');
    sharp.cache({ memory: 32, files: 0, items: 16 });
    sharp.concurrency(1);
    sharpInstance = sharp;
  } catch (error) {
    try {
      const sharp = requireFromCwd('sharp');
      sharp.cache({ memory: 32, files: 0, items: 16 });
      sharp.concurrency(1);
      sharpInstance = sharp;
    } catch (fallbackError) {
      console.warn('[FaceModels] Sharp unavailable, falling back to Electron nativeImage when possible:', fallbackError.message || error.message);
      sharpInstance = null;
    }
  }
  return sharpInstance;
}

async function fetchBuffer(url) {
  if (typeof global.fetch === 'function') {
    const response = await global.fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    return Buffer.from(await response.arrayBuffer());
  }

  try {
    const electron = require('electron');
    if (electron?.net?.fetch) {
      const response = await electron.net.fetch(url);
      if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
      return Buffer.from(await response.arrayBuffer());
    }
  } catch (_) { }

  throw new Error('No fetch implementation available for face model downloads');
}

// ---------------------------------------------------------------------------
// Model download
// ---------------------------------------------------------------------------

async function downloadFile(url, destPath) {
  if (!fs.existsSync(path.dirname(destPath))) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
  }
  const tmpPath = destPath + '.tmp';
  console.log(`[FaceModels] Downloading ${path.basename(destPath)}...`);
  const buffer = await fetchBuffer(url);
  fs.writeFileSync(tmpPath, buffer);
  fs.renameSync(tmpPath, destPath);
  console.log(`[FaceModels] Downloaded ${path.basename(destPath)} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
}

async function ensureModels() {
  if (ensureModelsPromise) return ensureModelsPromise;
  ensureModelsPromise = (async () => {
    if (!fs.existsSync(MODELS_DIR)) {
      fs.mkdirSync(MODELS_DIR, { recursive: true });
    }
    const downloads = [];
    for (const [key, filePath] of Object.entries(MODEL_FILES)) {
      if (!fs.existsSync(filePath)) {
        downloads.push(downloadFile(MODEL_URLS[key], filePath));
      }
    }
    if (downloads.length > 0) {
      await Promise.all(downloads);
    }
  })();
  return ensureModelsPromise;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

async function getDetectorSession() {
  if (detectorSessionPromise) return detectorSessionPromise;
  detectorSessionPromise = (async () => {
    await ensureModels();
    const session = await ort.InferenceSession.create(MODEL_FILES.detector, {
      executionProviders: ['cpu'],
      enableMemPattern: false,
      intraOpNumThreads: ONNX_THREADS,
    });
    console.log(`[FaceModels] SCRFD detector loaded (threads=${ONNX_THREADS})`);
    return session;
  })();
  return detectorSessionPromise;
}

async function getRecognizerSession() {
  if (recognizerSessionPromise) return recognizerSessionPromise;
  recognizerSessionPromise = (async () => {
    await ensureModels();
    const session = await ort.InferenceSession.create(MODEL_FILES.recognizer, {
      executionProviders: ['cpu'],
      enableMemPattern: false,
      intraOpNumThreads: ONNX_THREADS,
    });
    console.log(`[FaceModels] MobileFaceNet recognizer loaded (threads=${ONNX_THREADS})`);
    return session;
  })();
  return recognizerSessionPromise;
}

// ---------------------------------------------------------------------------
// Image I/O helpers (prefers Sharp, falls back to Electron nativeImage)
// ---------------------------------------------------------------------------

async function loadImageAsRGB(filePath) {
  const sharp = getSharp();
  if (sharp) {
    const { data, info } = await sharp(filePath, { failOn: 'none' })
      .rotate()
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      rgb: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      width: info.width,
      height: info.height,
    };
  }

  let nativeImage = null;
  try {
    nativeImage = require('electron')?.nativeImage || null;
  } catch (_) {
    nativeImage = null;
  }
  if (!nativeImage || typeof nativeImage.createFromPath !== 'function') {
    throw new Error('No image decoder available for face detection');
  }
  const img = nativeImage.createFromPath(filePath);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const bitmap = img.toBitmap();
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = bitmap[i * 4 + 2];
    rgb[i * 3 + 1] = bitmap[i * 4 + 1];
    rgb[i * 3 + 2] = bitmap[i * 4];
  }
  return { rgb, width, height };
}

function resizeImageData(srcRgb, srcW, srcH, dstW, dstH) {
  const dst = new Uint8Array(dstW * dstH * 3);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const srcX = Math.min(Math.floor(x * xRatio), srcW - 1);
      const srcY = Math.min(Math.floor(y * yRatio), srcH - 1);
      const srcIdx = (srcY * srcW + srcX) * 3;
      const dstIdx = (y * dstW + x) * 3;
      dst[dstIdx] = srcRgb[srcIdx];
      dst[dstIdx + 1] = srcRgb[srcIdx + 1];
      dst[dstIdx + 2] = srcRgb[srcIdx + 2];
    }
  }
  return dst;
}

// ---------------------------------------------------------------------------
// SCRFD preprocessing
// ---------------------------------------------------------------------------

function prepareDetectorInput(imageData) {
  const { rgb, width, height } = imageData;
  const imRatio = height / width;
  const modelRatio = 1.0;
  let newW, newH;
  if (imRatio > modelRatio) {
    newH = INPUT_SIZE;
    newW = Math.round(INPUT_SIZE / imRatio);
  } else {
    newW = INPUT_SIZE;
    newH = Math.round(INPUT_SIZE * imRatio);
  }
  const detScale = newH / height;
  const resized = resizeImageData(rgb, width, height, newW, newH);

  const inputData = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      const srcIdx = (y * newW + x) * 3;
      const r = resized[srcIdx];
      const g = resized[srcIdx + 1];
      const b = resized[srcIdx + 2];
      inputData[0 * INPUT_SIZE * INPUT_SIZE + y * INPUT_SIZE + x] = (r - 127.5) / 128.0;
      inputData[1 * INPUT_SIZE * INPUT_SIZE + y * INPUT_SIZE + x] = (g - 127.5) / 128.0;
      inputData[2 * INPUT_SIZE * INPUT_SIZE + y * INPUT_SIZE + x] = (b - 127.5) / 128.0;
    }
  }

  return { inputData, detScale, inputH: INPUT_SIZE, inputW: INPUT_SIZE };
}

// ---------------------------------------------------------------------------
// SCRFD postprocessing: anchor decode, distance2bbox, distance2kps, NMS
// ---------------------------------------------------------------------------

function getAnchors(fH, fW, stride) {
  const key = `${fH}_${fW}_${stride}`;
  if (anchorCache.has(key)) return anchorCache.get(key);

  const centers = new Float32Array(fH * fW * NUM_ANCHORS * 2);
  let idx = 0;
  for (let y = 0; y < fH; y++) {
    for (let x = 0; x < fW; x++) {
      for (let a = 0; a < NUM_ANCHORS; a++) {
        centers[idx++] = x * stride;
        centers[idx++] = y * stride;
      }
    }
  }
  anchorCache.set(key, centers);
  return centers;
}

function distance2bbox(anchors, distArr, numDets) {
  const bboxes = new Float32Array(numDets * 4);
  for (let i = 0; i < numDets; i++) {
    const ax = anchors[i * 2];
    const ay = anchors[i * 2 + 1];
    bboxes[i * 4] = ax - distArr[i * 4];
    bboxes[i * 4 + 1] = ay - distArr[i * 4 + 1];
    bboxes[i * 4 + 2] = ax + distArr[i * 4 + 2];
    bboxes[i * 4 + 3] = ay + distArr[i * 4 + 3];
  }
  return bboxes;
}

function distance2kps(anchors, distArr, numDets) {
  const kps = new Float32Array(numDets * 10);
  for (let i = 0; i < numDets; i++) {
    const ax = anchors[i * 2];
    const ay = anchors[i * 2 + 1];
    for (let j = 0; j < 5; j++) {
      kps[i * 10 + j * 2] = ax + distArr[i * 10 + j * 2];
      kps[i * 10 + j * 2 + 1] = ay + distArr[i * 10 + j * 2 + 1];
    }
  }
  return kps;
}

function nms(boxes, scores, threshold) {
  const n = scores.length;
  const indices = Array.from({ length: n }, (_, i) => i);
  indices.sort((a, b) => scores[b] - scores[a]);

  const keep = [];
  const suppressed = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const idx = indices[i];
    if (suppressed[idx]) continue;
    keep.push(idx);

    const x1a = boxes[idx * 4];
    const y1a = boxes[idx * 4 + 1];
    const x2a = boxes[idx * 4 + 2];
    const y2a = boxes[idx * 4 + 3];
    const areaA = (x2a - x1a + 1) * (y2a - y1a + 1);

    for (let j = i + 1; j < n; j++) {
      const jdx = indices[j];
      if (suppressed[jdx]) continue;

      const x1b = boxes[jdx * 4];
      const y1b = boxes[jdx * 4 + 1];
      const x2b = boxes[jdx * 4 + 2];
      const y2b = boxes[jdx * 4 + 3];
      const areaB = (x2b - x1b + 1) * (y2b - y1b + 1);

      const xx1 = Math.max(x1a, x1b);
      const yy1 = Math.max(y1a, y1b);
      const xx2 = Math.min(x2a, x2b);
      const yy2 = Math.min(y2a, y2b);

      const w = Math.max(0, xx2 - xx1 + 1);
      const h = Math.max(0, yy2 - yy1 + 1);
      const overlap = (w * h) / (areaA + areaB - w * h);

      if (overlap > threshold) suppressed[jdx] = 1;
    }
  }
  return keep;
}

function decodeOutputs(outputs, detScale, orderedOutputNames) {
  const outputNames = orderedOutputNames;
  const allScores = [];
  const allBboxes = [];
  const allKps = [];
  const hasKps = outputNames.length === FMC * 3;

  for (let strideIdx = 0; strideIdx < FMC; strideIdx++) {
    const stride = FEAT_STRIDES[strideIdx];
    const fH = Math.ceil(INPUT_SIZE / stride);
    const fW = Math.ceil(INPUT_SIZE / stride);
    const numAnchorsTotal = fH * fW * NUM_ANCHORS;

    const scoresTensor = outputs[outputNames[strideIdx]];
    const bboxTensor = outputs[outputNames[strideIdx + FMC]];
    const scoresData = scoresTensor.data;
    const bboxData = new Float32Array(bboxTensor.data.length);
    for (let i = 0; i < bboxTensor.data.length; i++) {
      bboxData[i] = bboxTensor.data[i] * stride;
    }

    let kpsData = null;
    if (hasKps) {
      const kpsTensor = outputs[outputNames[strideIdx + FMC * 2]];
      kpsData = new Float32Array(kpsTensor.data.length);
      for (let i = 0; i < kpsTensor.data.length; i++) {
        kpsData[i] = kpsTensor.data[i] * stride;
      }
    }

    const anchors = getAnchors(fH, fW, stride);

    for (let i = 0; i < numAnchorsTotal; i++) {
      const rawScore = scoresData[i];
      const score = 1.0 / (1.0 + Math.exp(-rawScore));
      if (score < DET_THRESHOLD) continue;

      const ax = anchors[i * 2];
      const ay = anchors[i * 2 + 1];

      const x1 = (ax - bboxData[i * 4]) / detScale;
      const y1 = (ay - bboxData[i * 4 + 1]) / detScale;
      const x2 = (ax + bboxData[i * 4 + 2]) / detScale;
      const y2 = (ay + bboxData[i * 4 + 3]) / detScale;

      allScores.push(score);
      allBboxes.push(x1, y1, x2, y2);

      if (kpsData) {
        const kp = [];
        for (let j = 0; j < 5; j++) {
          kp.push(
            (ax + kpsData[i * 10 + j * 2]) / detScale,
            (ay + kpsData[i * 10 + j * 2 + 1]) / detScale
          );
        }
        allKps.push(kp);
      }
    }
  }

  const bboxArr = new Float32Array(allBboxes);
  const keepIndices = nms(bboxArr, allScores, NMS_THRESHOLD);

  const faces = [];
  for (const idx of keepIndices) {
    const face = {
      score: allScores[idx],
      bbox: [
        bboxArr[idx * 4],
        bboxArr[idx * 4 + 1],
        bboxArr[idx * 4 + 2],
        bboxArr[idx * 4 + 3],
      ],
    };
    if (allKps.length > 0) {
      face.landmarks = [];
      for (let j = 0; j < 5; j++) {
        face.landmarks.push([
          allKps[idx][j * 2],
          allKps[idx][j * 2 + 1],
        ]);
      }
    }
    faces.push(face);
  }

  faces.sort((a, b) => b.score - a.score);
  return faces;
}

// ---------------------------------------------------------------------------
// Face detection
// ---------------------------------------------------------------------------

async function detectFaces(filePath, maxFaces = 10, preloadedImageData = null) {
  const session = await getDetectorSession();
  const imageData = preloadedImageData || await loadImageAsRGB(filePath);
  if (!imageData) return { faces: [], imageData: null };

  const { inputData, detScale } = prepareDetectorInput(imageData);
  const inputTensor = new ort.Tensor('float32', inputData, [1, 3, INPUT_SIZE, INPUT_SIZE]);

  const inputName = session.inputNames[0];
  const results = await session.run({ [inputName]: inputTensor });

  const rawFaces = decodeOutputs(results, detScale, session.outputNames);
  const { width: imgW, height: imgH } = imageData;

  const faces = [];
  for (const face of rawFaces) {
    face.bbox[0] = Math.max(0, face.bbox[0]);
    face.bbox[1] = Math.max(0, face.bbox[1]);
    face.bbox[2] = Math.min(imgW, face.bbox[2]);
    face.bbox[3] = Math.min(imgH, face.bbox[3]);

    const w = face.bbox[2] - face.bbox[0];
    const h = face.bbox[3] - face.bbox[1];
    if (w < 20 || h < 20) continue;

    if (face.landmarks) {
      for (const pt of face.landmarks) {
        pt[0] = Math.max(0, Math.min(imgW - 1, pt[0]));
        pt[1] = Math.max(0, Math.min(imgH - 1, pt[1]));
      }
    }
    faces.push(face);
  }

  return { faces: faces.slice(0, maxFaces), imageData };
}

// ---------------------------------------------------------------------------
// Face alignment (affine warp to 112x112 using 5-point landmarks)
// ---------------------------------------------------------------------------

function estimateAffinePartial(src, dst) {
  const n = src.length;
  const A = [];
  const B = [];
  for (let i = 0; i < n; i++) {
    A.push([src[i][0], -src[i][1], 1, 0]);
    A.push([src[i][1], src[i][0], 0, 1]);
    B.push(dst[i][0]);
    B.push(dst[i][1]);
  }

  const m = A.length;
  const k = 4;
  const AtA = Array.from({ length: k }, () => new Float64Array(k));
  const AtB = new Float64Array(k);

  for (let i = 0; i < m; i++) {
    for (let j = 0; j < k; j++) {
      AtB[j] += A[i][j] * B[i];
      for (let l = 0; l < k; l++) {
        AtA[j][l] += A[i][j] * A[i][l];
      }
    }
  }

  for (let col = 0; col < k; col++) {
    let maxRow = col;
    for (let row = col + 1; row < k; row++) {
      if (Math.abs(AtA[row][col]) > Math.abs(AtA[maxRow][col])) maxRow = row;
    }
    [AtA[col], AtA[maxRow]] = [AtA[maxRow], AtA[col]];
    [AtB[col], AtB[maxRow]] = [AtB[maxRow], AtB[col]];

    const pivot = AtA[col][col];
    if (Math.abs(pivot) < 1e-12) continue;
    for (let j = col; j < k; j++) AtA[col][j] /= pivot;
    AtB[col] /= pivot;

    for (let row = 0; row < k; row++) {
      if (row === col) continue;
      const factor = AtA[row][col];
      for (let j = col; j < k; j++) AtA[row][j] -= factor * AtA[col][j];
      AtB[row] -= factor * AtB[col];
    }
  }

  const a = AtB[0], b = AtB[1], tx = AtB[2], ty = AtB[3];
  return [
    [a, -b, tx],
    [b, a, ty],
  ];
}

function warpAffine(srcRgb, srcW, srcH, M, dstW, dstH) {
  const det = M[0][0] * M[1][1] - M[0][1] * M[1][0];
  if (Math.abs(det) < 1e-12) return null;

  const invDet = 1.0 / det;
  const iM = [
    [M[1][1] * invDet, -M[0][1] * invDet, 0],
    [-M[1][0] * invDet, M[0][0] * invDet, 0],
  ];
  iM[0][2] = -(iM[0][0] * M[0][2] + iM[0][1] * M[1][2]);
  iM[1][2] = -(iM[1][0] * M[0][2] + iM[1][1] * M[1][2]);

  const dst = new Uint8Array(dstW * dstH * 3);
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const sx = iM[0][0] * x + iM[0][1] * y + iM[0][2];
      const sy = iM[1][0] * x + iM[1][1] * y + iM[1][2];

      const sx0 = Math.floor(sx);
      const sy0 = Math.floor(sy);

      if (sx0 < 0 || sx0 >= srcW - 1 || sy0 < 0 || sy0 >= srcH - 1) continue;

      const fx = sx - sx0;
      const fy = sy - sy0;

      const i00 = (sy0 * srcW + sx0) * 3;
      const i10 = i00 + 3;
      const i01 = ((sy0 + 1) * srcW + sx0) * 3;
      const i11 = i01 + 3;

      const dstIdx = (y * dstW + x) * 3;
      for (let c = 0; c < 3; c++) {
        const v = (1 - fx) * (1 - fy) * srcRgb[i00 + c]
          + fx * (1 - fy) * srcRgb[i10 + c]
          + (1 - fx) * fy * srcRgb[i01 + c]
          + fx * fy * srcRgb[i11 + c];
        dst[dstIdx + c] = Math.round(Math.max(0, Math.min(255, v)));
      }
    }
  }
  return dst;
}

function alignFace(imageData, landmarks) {
  const M = estimateAffinePartial(landmarks, ARCFACE_TEMPLATE);
  const aligned = warpAffine(imageData.rgb, imageData.width, imageData.height, M, 112, 112);
  return aligned;
}

// ---------------------------------------------------------------------------
// Face embedding (MobileFaceNet / ArcFace w600k)
// ---------------------------------------------------------------------------

async function embedFace(alignedRgb112) {
  if (!alignedRgb112) return null;
  const session = await getRecognizerSession();

  const inputData = prepareEmbeddingInput(alignedRgb112);
  const inputTensor = new ort.Tensor('float32', inputData, [1, FACE_CHANNELS, 112, 112]);
  const inputName = session.inputNames[0];
  const results = await session.run({ [inputName]: inputTensor });
  const outputName = session.outputNames[0];
  const embedding = new Float32Array(results[outputName].data);

  return normalizeEmbedding(embedding);
}

const FACE_PIXELS = 112 * 112;
const FACE_CHANNELS = 3;
const FACE_ELEMENTS = FACE_CHANNELS * FACE_PIXELS;

function prepareEmbeddingInput(alignedRgb112) {
  const data = new Float32Array(FACE_ELEMENTS);
  for (let y = 0; y < 112; y++) {
    for (let x = 0; x < 112; x++) {
      const srcIdx = (y * 112 + x) * 3;
      data[0 * FACE_PIXELS + y * 112 + x] = (alignedRgb112[srcIdx] - 127.5) / 127.5;
      data[1 * FACE_PIXELS + y * 112 + x] = (alignedRgb112[srcIdx + 1] - 127.5) / 127.5;
      data[2 * FACE_PIXELS + y * 112 + x] = (alignedRgb112[srcIdx + 2] - 127.5) / 127.5;
    }
  }
  return data;
}

function normalizeEmbedding(raw) {
  let mag = 0;
  for (let i = 0; i < raw.length; i++) mag += raw[i] * raw[i];
  mag = Math.sqrt(mag);
  if (mag < 1e-6) return null;
  const norm = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) norm[i] = raw[i] / mag;
  return Buffer.from(norm.buffer);
}

async function embedFacesBatch(alignedFaces) {
  if (!alignedFaces || alignedFaces.length === 0) return [];
  const valid = alignedFaces.filter(Boolean);
  if (valid.length === 0) return alignedFaces.map(() => null);

  if (valid.length === 1) {
    const single = await embedFace(valid[0]);
    return alignedFaces.map(f => f ? single : null);
  }

  const session = await getRecognizerSession();
  const batchSize = valid.length;
  const batchData = new Float32Array(batchSize * FACE_ELEMENTS);

  valid.forEach((face, i) => {
    const prepared = prepareEmbeddingInput(face);
    batchData.set(prepared, i * FACE_ELEMENTS);
  });

  const inputTensor = new ort.Tensor('float32', batchData, [batchSize, FACE_CHANNELS, 112, 112]);
  const inputName = session.inputNames[0];
  const results = await session.run({ [inputName]: inputTensor });
  const outputName = session.outputNames[0];
  const outputData = results[outputName].data;
  const embDim = outputData.length / batchSize;

  const embeddings = [];
  for (let i = 0; i < batchSize; i++) {
    const raw = new Float32Array(outputData.buffer, outputData.byteOffset + i * embDim * 4, embDim);
    embeddings.push(normalizeEmbedding(raw));
  }

  let validIdx = 0;
  return alignedFaces.map(f => f ? embeddings[validIdx++] : null);
}

// ---------------------------------------------------------------------------
// Warm up (pre-load both sessions)
// ---------------------------------------------------------------------------

async function warmFaceModels() {
  const startedAt = Date.now();
  await Promise.all([getDetectorSession(), getRecognizerSession()]);
  console.log(`[FaceModels] Face models ready in ${Date.now() - startedAt}ms`);
}

module.exports = {
  ensureModels,
  detectFaces,
  alignFace,
  embedFace,
  embedFacesBatch,
  warmFaceModels,
  loadImageAsRGB,
};

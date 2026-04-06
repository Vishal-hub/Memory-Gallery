const path = require('path');
const os = require('os');
let fetchInitialized = false;

async function ensureFetch() {
  if (fetchInitialized) return;
  fetchInitialized = true;

  if (typeof global.fetch === 'function') {
    return;
  }

  try {
    const electron = require('electron');
    if (electron?.net?.fetch) {
      global.fetch = async (url, options = {}) => electron.net.fetch(url, options);
      return;
    }
  } catch (_) { }

  throw new Error('No fetch implementation available for model downloads');
}

let transformersPromise = null;
async function getTransformers() {
  if (transformersPromise) return transformersPromise;
  transformersPromise = (async () => {
    await ensureFetch();
    const module = await import('@xenova/transformers');
    const { env } = module;
    env.cacheDir = path.join(os.homedir(), '.memory-desktop', 'models');
    env.allowLocalModels = true;
    env.allowRemoteModels = true;
    env.useBrowserCache = false;
    return module;
  })();
  return transformersPromise;
}

let detectorPromise = null;
let visionExtractorPromise = null;
let textExtractorPromise = null;
let warmVisionModelsPromise = null;
const progressDoneLogged = new Set();
const DETECTOR_LABEL = 'CLIP Visual Tags';
const VISUAL_TAG_LABELS = [
  { tag: 'person', prompt: 'a photo of a person' },
  { tag: 'group', prompt: 'a photo of a group of people' },
  { tag: 'portrait', prompt: 'a portrait photo of one person' },
  { tag: 'dog', prompt: 'a photo of a dog' },
  { tag: 'cat', prompt: 'a photo of a cat' },
  { tag: 'flower', prompt: 'a photo of a flower' },
  { tag: 'tree', prompt: 'a photo of trees' },
  { tag: 'mountain', prompt: 'a photo of mountains' },
  { tag: 'lake', prompt: 'a photo of a lake' },
  { tag: 'river', prompt: 'a photo of a river' },
  { tag: 'beach', prompt: 'a photo of a beach' },
  { tag: 'sunset', prompt: 'a photo of a sunset' },
  { tag: 'snow', prompt: 'a photo of snow' },
  { tag: 'boat', prompt: 'a photo of a boat' },
  { tag: 'bridge', prompt: 'a photo of a bridge' },
  { tag: 'building', prompt: 'a photo of a building' },
  { tag: 'city', prompt: 'a photo of a city street' },
  { tag: 'architecture', prompt: 'a photo of architecture' },
  { tag: 'car', prompt: 'a photo of a car' },
  { tag: 'bus', prompt: 'a photo of a bus' },
  { tag: 'bicycle', prompt: 'a photo of a bicycle' },
  { tag: 'food', prompt: 'a photo of food' },
  { tag: 'drink', prompt: 'a photo of a drink' },
  { tag: 'room', prompt: 'a photo of a room interior' },
  { tag: 'hotel', prompt: 'a photo of a hotel room' },
  { tag: 'landscape', prompt: 'a landscape photo' },
];
let visualTagEmbeddingsPromise = null;

function logProgress(prefix, info) {
  if (info.status === 'progress') {
    process.stdout.write(`\r${prefix}: ${Math.round(info.progress)}% `);
  } else if (info.status === 'done' && !progressDoneLogged.has(prefix)) {
    progressDoneLogged.add(prefix);
    process.stdout.write(`\n${prefix} loaded.\n`);
  }
}

async function getDetector() {
  if (detectorPromise) return detectorPromise;
  detectorPromise = (async () => {
    const startedAt = Date.now();
    try {
      const vision = await getVisionExtractor();
      const { tokenizer, model } = await getTextExtractor();

      if (!visualTagEmbeddingsPromise) {
        visualTagEmbeddingsPromise = (async () => {
          const inputs = await tokenizer(VISUAL_TAG_LABELS.map((item) => item.prompt), {
            padding: true,
            truncation: true,
          });
          const { text_embeds } = await model(inputs);
          return chunkAndNormalize(text_embeds.data, VISUAL_TAG_LABELS.length);
        })();
      }

      const textEmbeddings = await visualTagEmbeddingsPromise;
      logProgress(DETECTOR_LABEL, { status: 'done', progress: 100 });
      console.log(`[Models] ${DETECTOR_LABEL} ready in ${Date.now() - startedAt}ms`);

      return async (filePath) => {
        const embedResult = await vision(filePath);
        const imageEmbedding = normalizeVector(embedResult.data);
        const scored = VISUAL_TAG_LABELS.map((item, index) => ({
          label: item.tag,
          score: cosineSimilarity(imageEmbedding, textEmbeddings[index]),
        })).sort((a, b) => b.score - a.score);
        return scored;
      };
    } catch (error) {
      detectorPromise = null;
      throw error;
    }
  })();
  return detectorPromise;
}

function normalizeVector(data) {
  const vector = ArrayBuffer.isView(data) ? Float32Array.from(data) : new Float32Array(data);
  let magnitude = 0;
  for (let i = 0; i < vector.length; i += 1) magnitude += vector[i] * vector[i];
  magnitude = Math.sqrt(magnitude) || 1;
  for (let i = 0; i < vector.length; i += 1) vector[i] /= magnitude;
  return vector;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) dot += a[i] * b[i];
  return dot;
}

function chunkAndNormalize(flatData, rows) {
  const source = ArrayBuffer.isView(flatData) ? flatData : new Float32Array(flatData);
  const width = Math.floor(source.length / rows);
  const chunks = [];
  for (let row = 0; row < rows; row += 1) {
    const start = row * width;
    const end = start + width;
    chunks.push(normalizeVector(source.slice(start, end)));
  }
  return chunks;
}

async function getVisionExtractor() {
  if (visionExtractorPromise) return visionExtractorPromise;
  visionExtractorPromise = (async () => {
    const startedAt = Date.now();
    try {
      const { pipeline } = await getTransformers();
      const model = await pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32', {
        quantized: true,
        progress_callback: (info) => logProgress('CLIP Vision', info),
      });
      console.log(`[Models] CLIP Vision ready in ${Date.now() - startedAt}ms`);
      return model;
    } catch (error) {
      visionExtractorPromise = null;
      throw error;
    }
  })();
  return visionExtractorPromise;
}

async function getTextExtractor() {
  if (textExtractorPromise) return textExtractorPromise;
  textExtractorPromise = (async () => {
    const startedAt = Date.now();
    try {
      const { AutoTokenizer, CLIPTextModelWithProjection } = await getTransformers();
      const [tokenizer, model] = await Promise.all([
        AutoTokenizer.from_pretrained('Xenova/clip-vit-base-patch32'),
        CLIPTextModelWithProjection.from_pretrained('Xenova/clip-vit-base-patch32', {
          quantized: true,
          progress_callback: (info) => logProgress('CLIP Text', info),
        }),
      ]);
      console.log(`[Models] CLIP Text ready in ${Date.now() - startedAt}ms`);
      return { tokenizer, model };
    } catch (error) {
      textExtractorPromise = null;
      throw error;
    }
  })();
  return textExtractorPromise;
}

async function warmVisionModels() {
  if (warmVisionModelsPromise) return warmVisionModelsPromise;
  warmVisionModelsPromise = (async () => {
    const startedAt = Date.now();
    await getDetector();
    await getVisionExtractor();
    console.log(`[Models] Vision warmup complete in ${Date.now() - startedAt}ms`);
  })().catch((error) => {
    warmVisionModelsPromise = null;
    throw error;
  });
  return warmVisionModelsPromise;
}

let warmFaceModelsPromise = null;

async function warmFaceModels() {
  if (warmFaceModelsPromise) return warmFaceModelsPromise;
  warmFaceModelsPromise = (async () => {
    const startedAt = Date.now();
    try {
      const { warmFaceModels: warmInsightFace } = require('./face-models');
      await warmInsightFace();
      console.log(`[Models] Face models warmup complete in ${Date.now() - startedAt}ms`);
    } catch (error) {
      warmFaceModelsPromise = null;
      throw error;
    }
  })();
  return warmFaceModelsPromise;
}

module.exports = {
  getDetector,
  getVisionExtractor,
  getTextExtractor,
  warmVisionModels,
  warmFaceModels,
};

const path = require('path');
const os = require('os');
const { pipeline, env } = require('@xenova/transformers');
const { net } = require('electron');

global.fetch = async (url, options = {}) => {
  const res = await net.fetch(url, options);
  return res;
};

env.cacheDir = path.join(os.homedir(), '.memory-desktop', 'models');
env.allowLocalModels = true;
env.allowRemoteModels = true;
env.useBrowserCache = false;

let detectorPromise = null;
let visionExtractorPromise = null;
let textExtractorPromise = null;
let warmVisionModelsPromise = null;
const progressDoneLogged = new Set();
const DETECTOR_MODEL_ID = 'Xenova/detr-resnet-50';
const DETECTOR_LABEL = 'Detr-ResNet';

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
      const model = await pipeline('object-detection', DETECTOR_MODEL_ID, {
        quantized: true,
        progress_callback: (info) => logProgress(DETECTOR_LABEL, info),
      });
      console.log(`[Models] ${DETECTOR_LABEL} ready in ${Date.now() - startedAt}ms`);
      return model;
    } catch (error) {
      detectorPromise = null;
      throw error;
    }
  })();
  return detectorPromise;
}

async function getVisionExtractor() {
  if (visionExtractorPromise) return visionExtractorPromise;
  visionExtractorPromise = (async () => {
    const startedAt = Date.now();
    try {
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
      const { AutoTokenizer, CLIPTextModelWithProjection } = require('@xenova/transformers');
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
    await Promise.all([getDetector(), getVisionExtractor()]);
    console.log(`[Models] Vision warmup complete in ${Date.now() - startedAt}ms`);
  })().catch((error) => {
    warmVisionModelsPromise = null;
    throw error;
  });
  return warmVisionModelsPromise;
}

module.exports = {
  getDetector,
  getVisionExtractor,
  getTextExtractor,
  warmVisionModels,
};

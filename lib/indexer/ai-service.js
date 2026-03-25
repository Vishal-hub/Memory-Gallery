const { getDetector, getVisionExtractor, getTextExtractor } = require('./model-registry');

async function embedText(text) {
  try {
    const { tokenizer, model } = await getTextExtractor();
    const inputs = await tokenizer(text, { padding: true, truncation: true });
    const { text_embeds } = await model(inputs);
    return new Float32Array(text_embeds.data);
  } catch (error) {
    console.error(`Text embedding failed for "${text}":`, error);
    return null;
  }
}

async function detectMedia(filePath, options = {}) {
  try {
    const pipe = await getDetector();
    const detectionInput = options.detectionInputPath || filePath;
    const objResults = await pipe(detectionInput, { threshold: 0.4 });

    const uniqueTags = [...new Set(objResults.map(r => r.label))];
    const personCount = objResults.filter(r => r.label === 'person').length;

    return {
      tags: uniqueTags.join(', '),
      faceCount: personCount,
      objectDetections: objResults,
    };
  } catch (error) {
    console.error(`Object detection failed for ${filePath}:`, error);
    return { tags: '', faceCount: 0, objectDetections: [] };
  }
}

async function embedVisualMedia(filePath) {
  try {
    const visionPipe = await getVisionExtractor();
    const embedResult = await visionPipe(filePath);
    const embeddingFloat = new Float32Array(embedResult.data);
    return Buffer.from(embeddingFloat.buffer);
  } catch (error) {
    console.error(`Visual embedding failed for ${filePath}:`, error);
    return null;
  }
}

async function analyzeMedia(filePath) {
  try {
    const [detection, embedding] = await Promise.all([
      detectMedia(filePath),
      embedVisualMedia(filePath)
    ]);

    return {
      tags: detection.tags,
      faceCount: detection.faceCount,
      embedding,
      objectDetections: detection.objectDetections,
    };
  } catch (error) {
    console.error(`AI Analysis failed for ${filePath}:`, error);
    return { tags: '', faceCount: 0, embedding: null, objectDetections: [] };
  }
}

module.exports = {
  detectMedia,
  embedVisualMedia,
  analyzeMedia,
  embedText
};

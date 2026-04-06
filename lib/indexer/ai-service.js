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
    const scoredLabels = await pipe(detectionInput);
    const topLabels = Array.isArray(scoredLabels) ? scoredLabels : [];
    const strongLabels = topLabels.filter((item) => item.score >= 0.205);
    const nonPeopleLabels = strongLabels
      .filter((item) => !['person', 'group', 'portrait'].includes(item.label))
      .slice(0, 4);
    const uniqueTags = [...new Set(nonPeopleLabels.map((item) => item.label))];

    const portraitScore = topLabels.find((item) => item.label === 'portrait')?.score || 0;
    const groupScore = topLabels.find((item) => item.label === 'group')?.score || 0;
    const personScore = topLabels.find((item) => item.label === 'person')?.score || 0;
    const bestPeopleScore = Math.max(portraitScore, groupScore, personScore);
    let personClass = 'none';
    if (bestPeopleScore >= 0.215) {
      personClass = groupScore > portraitScore + 0.015 ? 'group' : 'portrait';
    }

    return {
      tags: uniqueTags.join(', '),
      faceCount: personClass === 'group' ? 2 : (personClass === 'portrait' ? 1 : 0),
      objectDetections: [],
      personClass,
      personConfidence: bestPeopleScore,
      tagScores: nonPeopleLabels,
      labelScores: topLabels.slice(0, 12),
    };
  } catch (error) {
    console.error(`Object detection failed for ${filePath}:`, error);
    return { tags: '', faceCount: 0, objectDetections: [], personClass: 'none', personConfidence: 0, tagScores: [], labelScores: [] };
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

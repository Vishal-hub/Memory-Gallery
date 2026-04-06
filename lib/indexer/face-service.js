const { detectFaces, alignFace, embedFacesBatch } = require('./face-models');

async function processFaces(filePath, options = {}) {
  const { propagateErrors = false } = options;
  console.log(`[FaceService] Processing: ${filePath}`);
  try {
    const { faces, imageData } = await detectFaces(filePath, 6);
    console.log(`[FaceService] SCRFD detected ${faces.length} face(s)`);

    if (faces.length === 0 || !imageData) return [];

    const candidates = [];
    for (let i = 0; i < faces.length; i++) {
      const face = faces[i];
      const [x1, y1, x2, y2] = face.bbox;
      const faceW = x2 - x1;
      const faceH = y2 - y1;

      if (faceW < 50 || faceH < 50) continue;
      if (!face.landmarks || face.landmarks.length < 5) continue;

      const alignedRgb = alignFace(imageData, face.landmarks);
      if (!alignedRgb) continue;

      candidates.push({ face, alignedRgb });
    }

    if (candidates.length === 0) return [];

    const embeddings = await embedFacesBatch(candidates.map(c => c.alignedRgb));

    const results = [];
    for (let i = 0; i < candidates.length; i++) {
      if (!embeddings[i]) continue;
      const [x1, y1, x2, y2] = candidates[i].face.bbox;
      results.push({
        box: [Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)],
        embedding: embeddings[i],
      });
    }

    console.log(`[FaceService] Result: ${results.length} identity fingerprints from ${filePath}`);
    return results;
  } catch (err) {
    console.error(`[FaceService] ERROR for ${filePath}:`, err);
    if (propagateErrors) {
      throw err;
    }
    return [];
  }
}

module.exports = {
  processFaces,
};

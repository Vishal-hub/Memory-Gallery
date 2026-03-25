const path = require('path');
const os = require('os');
const fs = require('fs');
const { getDetector, getVisionExtractor } = require('./model-registry');

async function embedCrop(embedder, headCrop, tmpDir, cropId) {
  try {
    return await embedder(headCrop.toDataURL());
  } catch (inMemoryError) {
    const tmpFile = path.join(tmpDir, `crop_${cropId}.png`);
    fs.writeFileSync(tmpFile, headCrop.toPNG());
    try {
      return await embedder(tmpFile);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  }
}

/**
 * Detects people in an image and returns head-crop boxes + embeddings.
 * Uses a heuristic head-crop from detected "person" boxes to create identity fingerprints.
 */
async function processFaces(filePath, { detections = null } = {}) {
  const { nativeImage } = require('electron');
  console.log(`[FaceService] Processing: ${filePath}`);
  try {
    const embedderPromise = getVisionExtractor();
    const detectorPromise = detections ? null : getDetector();
    const [embedder, detector] = await Promise.all([embedderPromise, detectorPromise]);

    const allDetections = detections || await detector(filePath, { threshold: 0.5 });
    const personDetections = allDetections
      .filter((d) => d.label === 'person' && d.score >= 0.7)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    console.log(`[FaceService] Detections: ${allDetections.length} total, ${personDetections.length} people (${allDetections.map((d) => `${d.label}:${d.score.toFixed(2)}`).join(', ')})`);

    if (personDetections.length === 0) return [];

    const fullImg = nativeImage.createFromPath(filePath);
    if (fullImg.isEmpty()) {
      console.error(`[FaceService] Could not load image: ${filePath}`);
      return [];
    }

    const { width, height } = fullImg.getSize();
    const results = [];
    const tmpDir = path.join(os.tmpdir(), 'memory-faces');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    for (let i = 0; i < personDetections.length; i++) {
      const det = personDetections[i];
      const { xmin, ymin, xmax, ymax } = det.box;

      const personHeight = ymax - ymin;
      const headYmax = ymin + personHeight * 0.4;

      const cx = Math.max(0, Math.floor(xmin));
      const cy = Math.max(0, Math.floor(ymin));
      const cw = Math.min(width, Math.floor(xmax)) - cx;
      const ch = Math.min(height, Math.floor(headYmax)) - cy;

      if (cw <= 40 || ch <= 40) continue;

      console.log(`[FaceService] Person ${i}: score=${det.score.toFixed(2)}, head crop: ${cx},${cy} ${cw}x${ch}`);

      const headCrop = fullImg.crop({ x: cx, y: cy, width: cw, height: ch });
      const cropId = `${Date.now()}_${i}`;

      try {
        const embedResult = await embedCrop(embedder, headCrop, tmpDir, cropId);
        const embedding = new Float32Array(embedResult.data);

        results.push({
          box: [cx, cy, cx + cw, cy + ch],
          embedding: Buffer.from(embedding.buffer),
        });
        console.log(`[FaceService] Embedded person ${i} (${embedding.length} dims)`);
      } catch (embedErr) {
        console.error(`[FaceService] Embedding failed for person ${i}:`, embedErr.message);
      }
    }

    console.log(`[FaceService] Result: ${results.length} identity fingerprints from ${filePath}`);
    return results;
  } catch (err) {
    console.error(`[FaceService] ERROR for ${filePath}:`, err);
    return [];
  }
}

module.exports = {
  processFaces,
};

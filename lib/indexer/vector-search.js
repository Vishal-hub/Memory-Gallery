const { embedText } = require('./ai-service');

function cosineSimilarity(bufA, bufB) {
  if (!bufA || !bufB) return 0;
  
  const a = new Float32Array(bufA.buffer, bufA.byteOffset, bufA.byteLength / 4);
  const b = new Float32Array(bufB.buffer, bufB.byteOffset, bufB.byteLength / 4);
  
  if (a.length !== b.length) return 0;

  let dotProduct = 0.0;
  let normA = 0.0;
  let normB = 0.0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function searchSemanticVectors(db, textQuery) {
  try {
    console.log(`Embedding text query: "${textQuery}"`);
    const searchBuffer = await embedText(textQuery);
    if (!searchBuffer) return [];

    console.log(`Executing Vector scan across SQLite...`);
    // Pull all available embeddings from SQLite
    const rows = db.prepare(`SELECT path, embedding FROM media_items WHERE embedding IS NOT NULL AND is_missing = 0`).all();
    
    console.log(`Reticulating splines (Comparing ${rows.length} mathematical vectors).`);
    const results = [];
    rows.forEach(row => {
      const sim = cosineSimilarity(searchBuffer, row.embedding);
      if (sim > 0.22) { // 22% similarity is a healthy semantic threshold for CLIP-ViT
        results.push({ path: row.path, similarity: sim });
      }
    });

    results.sort((a, b) => b.similarity - a.similarity);
    
    // Return max 100 paths
    return results.slice(0, 100).map(r => r.path);
  } catch (error) {
    console.error('Vector Search failed:', error);
    return [];
  }
}

module.exports = { searchSemanticVectors };

const { analyzeMedia } = require('./lib/indexer/ai-service');
const path = require('path');
const fs = require('fs');

async function run() {
  const imagesDir = path.join(require('os').homedir(), 'Pictures');
  const files = fs.readdirSync(imagesDir).filter(f => f.endsWith('.jpg') || f.endsWith('.png'));
  if (files.length > 0) {
    console.log('Testing image:', files[0]);
    const res = await analyzeMedia(path.join(imagesDir, files[0]));
    console.log('Result:', res);
  } else {
    console.log('No images found in Pictures');
  }
}
run();

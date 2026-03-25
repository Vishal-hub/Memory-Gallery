const { classifyImage } = require('../lib/indexer/ai-service');
const path = require('path');

async function test() {
  console.log('--- Testing AI Classification ---');
  // Use any image in the repo if possible, or just a dummy path to trigger model download
  // We'll use the path from the user's error to be sure
  const testPath = 'C:\\Users\\Vishal\\Pictures\\car.jpg';
  
  console.log(`Classifying: ${testPath}`);
  try {
    const tags = await classifyImage(testPath);
    console.log(`SUCCESS: Tags generated: ${tags}`);
  } catch (err) {
    console.error(`FAILED: ${err.message}`);
  }
  process.exit(0);
}

test();

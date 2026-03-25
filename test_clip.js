const { pipeline, env } = require('@xenova/transformers');

// Prevent downloading to system cache, use local model to ensure privacy
env.localModelPath = './models';
env.backends.onnx.wasm.numThreads = 1;

async function testClip() {
  console.log('Loading text extractor...');
  const textExtractor = await pipeline('feature-extraction', 'Xenova/clip-vit-base-patch32');
  console.log('Text loaded! Computing "dog"...');
  const textRes = await textExtractor("a photo of a dog", { pooling: 'mean', normalize: true });
  console.log('Text Embed shape:', textRes.dims); // Should be [1, 512]
  
  console.log('Loading vision extractor...');
  const imageExtractor = await pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32');
  const imgUrl = "https://images.unsplash.com/photo-1543852786-1cf6624b9987"; // Cat image
  console.log('Downloading and computing image...', imgUrl);
  const imgRes = await imageExtractor(imgUrl);
  console.log('Image Embed shape:', imgRes.dims); // Should be [1, 512]
}

testClip().catch(console.error);

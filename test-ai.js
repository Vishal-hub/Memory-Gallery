const { pipeline, env } = require('@xenova/transformers');
const path = require('path');
const fs = require('fs');

env.allowLocalModels = false;
env.useBrowserCache = false;

async function test() {
    const filePath = process.argv[2];
    if (!filePath) {
        console.error('Please provide a file path');
        return;
    }

    console.log('Testing models on:', filePath);

    try {
        console.log('Loading detector...');
        const detector = await pipeline('object-detection', 'Xenova/blazeface', { quantized: true });
        console.log('Detector loaded.');

        console.log('Detecting...');
        const detections = await detector(filePath, { threshold: 0.1 });
        console.log('Detections:', JSON.stringify(detections, null, 2));

        if (detections.length > 0) {
            console.log('Loading embedder...');
            const embedder = await pipeline('image-feature-extraction', 'Xenova/facenet-base', { quantized: true });
            console.log('Embedder loaded.');

            console.log('Extracting embedding...');
            const result = await embedder(filePath);
            console.log('Embedding data length:', result.data.length);
        } else {
            console.log('No faces detected at threshold 0.1');
        }
    } catch (err) {
        console.error('TEST FAILED:', err);
    }
}

test();

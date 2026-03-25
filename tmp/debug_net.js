const https = require('https');

const urls = [
  'https://huggingface.co/Xenova/mobilenet_v1_1.0_224/resolve/main/config.json',
  'https://huggingface.co/Xenova/mobilenet_v1_1.0_224/resolve/main/preprocessor_config.json'
];

async function testUrl(url) {
  return new Promise((resolve) => {
    console.log(`Testing: ${url}`);
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
      }
    }, (res) => {
      console.log(`Status: ${res.statusCode}`);
      console.log(`Headers: ${JSON.stringify(res.headers, null, 2)}`);
      resolve(res.statusCode);
    });

    req.on('error', (err) => {
      console.error(`Error: ${err.message}`);
      resolve(500);
    });
  });
}

async function run() {
  for (const url of urls) {
    await testUrl(url);
  }
}

run();

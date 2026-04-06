const fs = require('fs');
const { writeJpegThumbnail, writeAnalysisProxy } = require('../../lib/indexer/image-ops');

function send(message) {
  if (typeof process.send === 'function') {
    process.send(message);
  }
}

async function processJob(job) {
  if (!job || !job.inputPath || !fs.existsSync(job.inputPath)) {
    return {
      thumbnailPath: null,
      analysisProxyPath: null,
    };
  }

  let thumbnailPath = job.thumbnailPath || null;
  let analysisProxyPath = null;

  if (job.generateThumbnail && job.thumbnailPath) {
    try {
      const writtenThumb = await writeJpegThumbnail(job.inputPath, job.thumbnailPath, {
        width: 256,
        quality: 80,
      });
      thumbnailPath = writtenThumb || thumbnailPath;
    } catch (_) { }
  }

  if (job.generateAnalysisProxy && job.analysisProxyPath) {
    try {
      const writtenProxy = await writeAnalysisProxy(job.inputPath, job.analysisProxyPath, {
        maxSide: 1536,
        quality: 85,
      });
      analysisProxyPath = writtenProxy || null;
    } catch (_) { }
  }

  return {
    thumbnailPath,
    analysisProxyPath,
  };
}

process.on('message', async (message) => {
  if (!message || !message.type || !message.requestId) return;

  try {
    if (message.type !== 'process-media-assets') {
      send({
        type: 'response',
        requestId: message.requestId,
        ok: false,
        error: `Unknown worker message type: ${message.type}`,
      });
      return;
    }

    const jobs = Array.isArray(message.jobs) ? message.jobs : [];
    const processed = [];
    for (let index = 0; index < jobs.length; index += 1) {
      processed.push(await processJob(jobs[index]));
      send({
        type: 'progress',
        requestId: message.requestId,
        stage: 'media-assets',
        current: index + 1,
        total: jobs.length,
        percentage: jobs.length > 0 ? Math.round(((index + 1) / jobs.length) * 100) : 100,
      });
    }

    send({
      type: 'response',
      requestId: message.requestId,
      ok: true,
      result: { processed },
    });
  } catch (error) {
    send({
      type: 'response',
      requestId: message.requestId,
      ok: false,
      error: error.message || 'Media asset worker failed',
    });
  }
});

send({ type: 'ready' });

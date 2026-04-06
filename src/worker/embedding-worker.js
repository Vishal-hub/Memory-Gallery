const fs = require('fs');
const { embedVisualMedia } = require('../../lib/indexer/ai-service');
const { extractFrame } = require('../../lib/indexer/video-utils');
const { getVisionExtractor } = require('../../lib/indexer/model-registry');

function send(message) {
  if (typeof process.send === 'function') {
    process.send(message);
  }
}

async function processEmbeddingJob(job) {
  if (!job || !job.filePath || !fs.existsSync(job.filePath)) {
    return { mediaId: job?.mediaId || null, embedding: null };
  }

  let targetPath = job.decodablePath || job.filePath;
  let framePath = null;
  try {
    if (job.mediaType === 'video') {
      framePath = await extractFrame(job.filePath);
      if (!framePath) {
        return { mediaId: job.mediaId, embedding: null };
      }
      targetPath = framePath;
    }

    const embedding = await embedVisualMedia(targetPath);
    return {
      mediaId: job.mediaId,
      embedding: embedding ? embedding.toString('base64') : null,
    };
  } finally {
    if (framePath) {
      try { fs.unlinkSync(framePath); } catch (_) { }
    }
  }
}

async function handleWarmEmbeddingModels(requestId) {
  await getVisionExtractor();
  send({
    type: 'response',
    requestId,
    ok: true,
    result: { warmed: true },
  });
}

async function handleEmbedJobs(requestId, jobs = []) {
  const startedAt = Date.now();
  const processed = [];
  const total = Array.isArray(jobs) ? jobs.length : 0;

  for (let index = 0; index < total; index += 1) {
    const result = await processEmbeddingJob(jobs[index]);
    processed.push(result);
    send({
      type: 'progress',
      requestId,
      stage: 'embedding',
      current: index + 1,
      total,
      percentage: total > 0 ? Math.round(((index + 1) / total) * 100) : 100,
    });
  }

  send({
    type: 'response',
    requestId,
    ok: true,
    result: {
      total,
      durationMs: Date.now() - startedAt,
      processed,
    },
  });
}

process.on('message', async (message) => {
  if (!message || !message.type || !message.requestId) return;

  try {
    if (message.type === 'warm-embedding-models') {
      await handleWarmEmbeddingModels(message.requestId);
      return;
    }

    if (message.type === 'embed-jobs') {
      await handleEmbedJobs(message.requestId, message.jobs);
      return;
    }

    send({
      type: 'response',
      requestId: message.requestId,
      ok: false,
      error: `Unknown worker message type: ${message.type}`,
    });
  } catch (error) {
    send({
      type: 'response',
      requestId: message.requestId,
      ok: false,
      error: error.message || 'Worker task failed',
    });
  }
});

send({ type: 'ready' });

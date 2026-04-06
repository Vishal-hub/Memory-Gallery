const fs = require('fs');
const { detectMedia } = require('../../lib/indexer/ai-service');
const { processFaces } = require('../../lib/indexer/face-service');
const { extractFrame } = require('../../lib/indexer/video-utils');
const { getDetector, warmFaceModels } = require('../../lib/indexer/model-registry');

function send(message) {
  if (typeof process.send === 'function') {
    process.send(message);
  }
}

async function processVisualJob(job) {
  if (!job || !job.filePath || !fs.existsSync(job.filePath)) {
    return null;
  }

  let targetPath = job.decodablePath || job.filePath;
  let framePath = null;
  try {
    if (job.mediaType === 'video') {
      framePath = await extractFrame(job.filePath);
      if (!framePath) {
        return {
          mediaId: job.mediaId,
          analysis: { tags: '', faceCount: 0, objectDetections: [] },
          needsFaceIndexing: false,
          faceJob: null,
        };
      }
      targetPath = framePath;
    }

    const detectionInputPath = job.detectionInputPath && fs.existsSync(job.detectionInputPath)
      ? job.detectionInputPath
      : targetPath;
    const analysis = await detectMedia(targetPath, { detectionInputPath });
    const needsFaces = job.mediaType === 'image' && job.needsFaceIndexing;

    return {
      mediaId: job.mediaId,
      analysis,
      needsFaceIndexing: needsFaces,
      faceJob: needsFaces ? {
        mediaId: job.mediaId,
        filePath: job.filePath,
        decodablePath: job.decodablePath,
        thumbnailPath: job.thumbnailPath,
      } : null,
    };
  } finally {
    if (framePath) {
      try { fs.unlinkSync(framePath); } catch (_) { }
    }
  }
}

async function processFaceJob(job) {
  if (!job || !job.filePath || !fs.existsSync(job.filePath)) {
    return { mediaId: job?.mediaId || null, faces: [] };
  }

  const faceInputPath = job.decodablePath || job.filePath;
  const faces = await processFaces(faceInputPath, { propagateErrors: true });
  return {
    mediaId: job.mediaId,
    filePath: job.filePath,
    decodablePath: job.decodablePath,
    thumbnailPath: job.thumbnailPath,
    faces: faces.map((face) => ({
      box: face.box,
      embedding: face.embedding ? face.embedding.toString('base64') : null,
    })),
  };
}

async function handleWarmModels(requestId) {
  await getDetector();
  await warmFaceModels();
  send({
    type: 'response',
    requestId,
    ok: true,
    result: { warmed: true },
  });
}

async function handleWarmVisualModels(requestId) {
  await getDetector();
  send({
    type: 'response',
    requestId,
    ok: true,
    result: { warmed: true, visualOnly: true },
  });
}

async function handleVisualJobs(requestId, jobs = []) {
  const startedAt = Date.now();
  const processed = [];
  const total = Array.isArray(jobs) ? jobs.length : 0;

  for (let index = 0; index < total; index += 1) {
    processed.push(await processVisualJob(jobs[index]));
    send({
      type: 'progress',
      requestId,
      stage: 'visual',
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

async function handleFaceJobs(requestId, jobs = []) {
  const startedAt = Date.now();
  const processed = [];
  const total = Array.isArray(jobs) ? jobs.length : 0;

  for (let index = 0; index < total; index += 1) {
    processed.push(await processFaceJob(jobs[index]));
    send({
      type: 'progress',
      requestId,
      stage: 'face',
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
    if (message.type === 'warm-vision-face-models') {
      await handleWarmModels(message.requestId);
      return;
    }
    if (message.type === 'warm-visual-models') {
      await handleWarmVisualModels(message.requestId);
      return;
    }
    if (message.type === 'process-visual-jobs') {
      await handleVisualJobs(message.requestId, message.jobs);
      return;
    }
    if (message.type === 'process-face-jobs') {
      await handleFaceJobs(message.requestId, message.jobs);
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

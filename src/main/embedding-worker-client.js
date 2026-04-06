const path = require('path');
const { fork } = require('child_process');

function createEmbeddingWorkerClient() {
  let child = null;
  let nextRequestId = 1;
  const pending = new Map();

  function clearPendingWithError(message) {
    for (const { reject } of pending.values()) {
      reject(new Error(message));
    }
    pending.clear();
  }

  function attachChildListeners(worker) {
    worker.on('message', (message) => {
      if (!message || !message.type) return;

      if (message.type === 'progress') {
        const entry = pending.get(message.requestId);
        if (entry?.onProgress) {
          entry.onProgress({
            current: message.current,
            total: message.total,
            percentage: message.percentage,
          });
        }
        return;
      }

      if (message.type === 'response') {
        const entry = pending.get(message.requestId);
        if (!entry) return;
        pending.delete(message.requestId);
        if (message.ok) {
          entry.resolve(message.result);
        } else {
          entry.reject(new Error(message.error || 'Worker request failed'));
        }
      }
    });

    worker.on('exit', (code, signal) => {
      child = null;
      if (pending.size > 0) {
        clearPendingWithError(`Embedding worker exited unexpectedly (${signal || code || 'unknown'})`);
      }
    });

    worker.on('error', (error) => {
      child = null;
      clearPendingWithError(error.message || 'Embedding worker failed');
    });

    if (worker.stdout) {
      worker.stdout.on('data', (chunk) => {
        const text = String(chunk || '').trim();
        if (text) console.log(`[EmbeddingWorker] ${text}`);
      });
    }

    if (worker.stderr) {
      worker.stderr.on('data', (chunk) => {
        const text = String(chunk || '').trim();
        if (text) console.error(`[EmbeddingWorker] ${text}`);
      });
    }
  }

  function ensureWorker() {
    if (child && child.connected) return child;
    const workerPath = path.join(__dirname, '..', 'worker', 'embedding-worker.js');
    child = fork(workerPath, [], {
      execPath: process.execPath,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    attachChildListeners(child);
    return child;
  }

  function request(type, payload = {}, options = {}) {
    const worker = ensureWorker();
    const requestId = `embedding-${nextRequestId++}`;
    return new Promise((resolve, reject) => {
      pending.set(requestId, {
        resolve,
        reject,
        onProgress: options.onProgress || null,
      });
      worker.send({
        requestId,
        type,
        ...payload,
      });
    });
  }

  return {
    warmEmbeddingModels() {
      return request('warm-embedding-models');
    },
    processEmbeddingJobs(jobs, options = {}) {
      return request('embed-jobs', { jobs }, options);
    },
    dispose() {
      clearPendingWithError('Embedding worker disposed');
      if (child) {
        try {
          child.kill();
        } catch (_) { }
        child = null;
      }
    },
  };
}

module.exports = {
  createEmbeddingWorkerClient,
};

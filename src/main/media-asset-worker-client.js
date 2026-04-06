const path = require('path');
const { fork } = require('child_process');

function createMediaAssetWorkerClient() {
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
        clearPendingWithError(`Media asset worker exited unexpectedly (${signal || code || 'unknown'})`);
      }
    });

    worker.on('error', (error) => {
      child = null;
      clearPendingWithError(error.message || 'Media asset worker failed');
    });
  }

  function ensureWorker() {
    if (child && child.connected) return child;
    const workerPath = path.join(__dirname, '..', 'worker', 'media-asset-worker.js');
    child = fork(workerPath, [], {
      execPath: process.execPath,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    attachChildListeners(child);
    return child;
  }

  function request(type, payload = {}, options = {}) {
    const worker = ensureWorker();
    const requestId = `media-assets-${nextRequestId++}`;
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
    processJobs(jobs, options = {}) {
      return request('process-media-assets', { jobs }, options);
    },
    dispose() {
      clearPendingWithError('Media asset worker disposed');
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
  createMediaAssetWorkerClient,
};

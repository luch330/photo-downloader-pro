const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function createJobStore() {
  const jobs = new Map();

  return {
    async create({ fileName, rows, referer, settings }) {
      const id = crypto.randomBytes(12).toString('hex');
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `photo-downloader-${id}-`));
      const job = {
        id,
        fileName,
        rows,
        referer,
        settings,
        tempDir,
        status: 'queued',
        progress: 0,
        total: 0,
        done: 0,
        ready: 0,
        failed: 0,
        current: '',
        message: 'Waiting to start.',
        preview: [],
        logs: [],
        downloadName: '',
        zipPath: '',
        reportText: '',
        failedCsv: '',
        etaMs: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        error: '',
      };
      jobs.set(id, job);
      return job;
    },

    get(id) {
      return jobs.get(id);
    },

    update(id, patch) {
      const job = jobs.get(id);
      if (!job) return null;
      Object.assign(job, patch, { updatedAt: Date.now() });
      return job;
    },

    log(id, line) {
      const job = jobs.get(id);
      if (!job) return null;
      job.logs.push(line);
      if (job.logs.length > 500) job.logs.splice(0, job.logs.length - 500);
      job.updatedAt = Date.now();
      return job;
    },

    snapshot(id) {
      const job = jobs.get(id);
      if (!job) return null;
      return {
        id: job.id,
        fileName: job.fileName,
        status: job.status,
        progress: job.progress,
        total: job.total,
        done: job.done,
        ready: job.ready,
        failed: job.failed,
        current: job.current,
        message: job.message,
        preview: job.preview,
        logs: job.logs,
        downloadReady: Boolean(job.zipPath && job.status === 'done'),
        downloadUrl: job.zipPath ? `/api/download/${job.id}` : '',
        downloadName: job.downloadName,
        etaMs: job.etaMs || 0,
        startedAt: job.startedAt,
        updatedAt: job.updatedAt,
        error: job.error,
        settings: job.settings,
      };
    },
  };
}

module.exports = { createJobStore };

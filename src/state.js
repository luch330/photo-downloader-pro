const os = require('os');
const path = require('path');
const fs = require('fs/promises');

function createJobStore() {
  const jobs = new Map();

  return {
    async create({ fileName, rows, referer, settings }) {
      const id = randomId();
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-downloader-'));

      const job = {
        id,
        fileName: String(fileName || 'catalog.xlsx'),
        rows: Array.isArray(rows) ? rows : [],
        referer: String(referer || ''),
        settings: settings || {},
        tempDir,

        status: 'queued',
        progress: 0,
        total: 0,
        done: 0,
        ready: 0,
        failed: 0,
        current: '',
        message: 'Waiting to start.',
        error: null,

        startedAt: Date.now(),
        updatedAt: Date.now(),
        zipPath: null,
        downloadName: null,
        zipSizeBytes: 0,
        zipSizeText: '—',

        preview: [],
        logs: [],
        failedRows: [],
        errorSummary: makeEmptyErrorSummary(),
        reportText: '',
        failedCsv: '',
        etaMs: 0,
      };

      jobs.set(id, job);
      return job;
    },

    get(id) {
      return jobs.get(id) || null;
    },

    update(id, patch = {}) {
      const job = jobs.get(id);
      if (!job) return null;

      Object.assign(job, patch, {
        updatedAt: Date.now(),
      });

      return job;
    },

    log(id, message) {
      const job = jobs.get(id);
      if (!job) return null;

      job.logs.push(String(message));
      if (job.logs.length > 200) {
        job.logs.splice(0, job.logs.length - 200);
      }
      job.updatedAt = Date.now();
      return job;
    },

    snapshot(id) {
      const job = jobs.get(id);
      if (!job) return null;

      return {
        jobId: job.id,
        fileName: job.fileName,
        status: job.status,
        progress: job.progress,
        total: job.total,
        done: job.done,
        ready: job.ready,
        failed: job.failed,
        current: job.current,
        message: job.message,
        error: job.error,
        startedAt: job.startedAt,
        updatedAt: job.updatedAt,
        etaMs: job.etaMs,

        preview: job.preview,
        logs: job.logs.slice(-120),
        failedRows: job.failedRows,
        errorSummary: job.errorSummary,

        downloadReady: Boolean(job.zipPath && job.status === 'done'),
        downloadUrl: job.zipPath ? `/api/download/${job.id}` : null,
        downloadName: job.downloadName,
        zipSizeBytes: job.zipSizeBytes,
        zipSizeText: job.zipSizeText,
        reportText: job.reportText,
        failedCsv: job.failedCsv,
      };
    },

    remove(id) {
      jobs.delete(id);
    },
  };
}

function makeEmptyErrorSummary() {
  return {
    total: 0,
    forbidden: 0,
    unauthorized: 0,
    notFound: 0,
    timeout: 0,
    nonImage: 0,
    other: 0,
  };
}

function randomId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

module.exports = {
  createJobStore,
};

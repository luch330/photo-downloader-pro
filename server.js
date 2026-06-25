const path = require('path');
const os = require('os');
const fs = require('fs/promises');

const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const morgan = require('morgan');

const { downloadImage } = require('./src/downloader');
const { buildZip } = require('./src/zipBuilder');
const {
  formatBytes,
  formatDuration,
  sanitizeFileName,
  detectExtension,
  uniqueName,
} = require('./src/utils');

const app = express();
const PORT = Number(process.env.PORT || 3000);

const DEFAULT_SETTINGS = {
  timeoutMs: 45000,
  retries: 2,
  concurrency: 4,
  browserFallback: true,
};

const jobs = new Map();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(morgan('dev'));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'photo-downloader-pro', time: new Date().toISOString() });
});

app.post('/api/start', async (req, res) => {
  try {
    const body = req.body || {};
    const fileName = String(body.fileName || 'catalog.xlsx');
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const referer = String(body.referer || '').trim();
    const settings = {
      timeoutMs: clampInt(body?.settings?.timeoutMs, 5000, 180000, DEFAULT_SETTINGS.timeoutMs),
      retries: clampInt(body?.settings?.retries, 0, 5, DEFAULT_SETTINGS.retries),
      concurrency: clampInt(body?.settings?.concurrency, 1, 10, DEFAULT_SETTINGS.concurrency),
      browserFallback: body?.settings?.browserFallback === false ? false : true,
    };

    if (!rows.length) {
      return res.status(400).json({ ok: false, message: 'Please upload a file with at least one header row.' });
    }

    const job = await createJob({
      fileName,
      rows,
      referer,
      settings,
    });

    res.json({ ok: true, jobId: job.id });

    setImmediate(() => {
      processJob(job.id).catch((err) => {
        updateJob(job.id, {
          status: 'error',
          error: err?.message || String(err),
          message: 'Processing failed.',
          updatedAt: Date.now(),
        });
        logJob(job.id, `ERROR: ${err?.stack || err?.message || String(err)}`);
      });
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err?.message || String(err) });
  }
});

app.get('/api/status/:jobId', (req, res) => {
  const snap = snapshotJob(req.params.jobId);
  if (!snap) {
    return res.status(404).json({ ok: false, message: 'Job not found.' });
  }
  res.json({ ok: true, ...snap });
});

app.get('/api/download/:jobId', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.zipPath) {
    return res.status(404).send('Not ready');
  }

  try {
    await fs.access(job.zipPath);
    res.download(job.zipPath, job.downloadName || path.basename(job.zipPath));
  } catch {
    res.status(404).send('File not available');
  }
});

app.use((_req, res) => {
  res.status(404).send('Not found');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Photo downloader running on port ${PORT}`);
});

async function createJob({ fileName, rows, referer, settings }) {
  const jobId = randomId();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-downloader-'));

  const job = {
    id: jobId,
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

  jobs.set(jobId, job);
  return job;
}

function updateJob(jobId, patch) {
  const job = jobs.get(jobId);
  if (!job) return;

  Object.assign(job, patch, {
    updatedAt: Date.now(),
  });
}

function logJob(jobId, message) {
  const job = jobs.get(jobId);
  if (!job) return;

  job.logs.push(String(message));
  if (job.logs.length > 200) {
    job.logs.splice(0, job.logs.length - 200);
  }
  job.updatedAt = Date.now();
}

function snapshotJob(jobId) {
  const job = jobs.get(jobId);
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
}

async function processJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  const rows = Array.isArray(job.rows) ? job.rows : [];
  if (rows.length < 1) {
    updateJob(jobId, {
      status: 'error',
      message: 'No rows found.',
      error: 'No rows found.',
    });
    return;
  }

  const preview = rows.slice(0, 6);
  const dataRows = rows.slice(1).filter((row) => {
    const a = String(row?.[0] || '').trim();
    const b = String(row?.[1] || '').trim();
    return Boolean(a || b);
  });

  if (!dataRows.length) {
    updateJob(jobId, {
      status: 'error',
      message: 'The file contains only a header row.',
      error: 'The file contains only a header row.',
      preview,
      total: 0,
    });
    return;
  }

  const tempDir = job.tempDir;
  const usedNames = {};
  const downloaded = [];
  const failedRows = [];
  const reportLines = [];
  const startedAt = Date.now();

  let done = 0;
  let ready = 0;
  let failed = 0;

  updateJob(jobId, {
    status: 'processing',
    preview,
    total: dataRows.length,
    done,
    ready,
    failed,
    progress: 0,
    message: 'Processing started.',
    current: 'Preparing tasks...',
    startedAt,
    errorSummary: makeEmptyErrorSummary(),
    failedRows: [],
    etaMs: 0,
  });

  reportLines.push('Photo downloader report');
  reportLines.push(`Source file: ${job.fileName}`);
  reportLines.push(`Generated: ${new Date().toLocaleString()}`);
  reportLines.push(`Rows (excluding header): ${dataRows.length}`);
  reportLines.push(`Referer: ${job.referer || '(none)'}`);
  reportLines.push(
    `Settings: timeout=${job.settings.timeoutMs}ms, retries=${job.settings.retries}, concurrency=${job.settings.concurrency}, browserFallback=${job.settings.browserFallback}`
  );
  reportLines.push('');
  reportLines.push('Header row skipped automatically.');
  reportLines.push('');

  const tasks = dataRows.map((row, index) => ({
    row,
    index,
    rowNumber: index + 2,
  }));

  const concurrency = Math.min(job.settings.concurrency || DEFAULT_SETTINGS.concurrency, tasks.length);
  let cursor = 0;

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const current = cursor;
      cursor += 1;
      if (current >= tasks.length) return;
      await processRowTask(tasks[current]);
    }
  });

  await Promise.all(workers);

  reportLines.push('');
  reportLines.push('Summary');
  reportLines.push(`Success: ${ready}`);
  reportLines.push(`Failed: ${failed}`);
  reportLines.push(`Total rows: ${dataRows.length}`);
  reportLines.push(`Elapsed: ${formatDuration(Date.now() - startedAt)}`);

  const zipName = `${sanitizeFileName(job.fileName.replace(/\.[^.]+$/, '')) || 'images'}.zip`;
  const zipPath = path.join(tempDir, zipName);
  const reportText = reportLines.join('\n');
  const failedCsv = createFailedRowsCsv(failedRows);

  await buildZip({
    zipPath,
    entries: downloaded.sort((a, b) => a.order - b.order),
    reportText,
    failedCsv,
  });

  const zipStats = await fs.stat(zipPath);

  updateJob(jobId, {
    status: 'done',
    progress: 100,
    done: dataRows.length,
    ready,
    failed,
    current: 'ZIP ready',
    message: 'ZIP file is ready.',
    zipPath,
    downloadName: zipName,
    zipSizeBytes: zipStats.size,
    zipSizeText: formatBytes(zipStats.size),
    reportText,
    failedCsv,
    failedRows,
    errorSummary: summarizeFailures(failedRows),
    etaMs: 0,
  });

  logJob(jobId, `ZIP ready: ${zipName} (${formatBytes(zipStats.size)})`);

  async function processRowTask(task) {
    const row = task.row || [];
    const itemName = String(row[0] || '').trim();
    const imageUrl = String(row[1] || '').trim();
    const rowNumber = task.rowNumber;

    if (!itemName && !imageUrl) {
      done += 1;
      updateProgress('Skipping blank row');
      return;
    }

    updateJob(jobId, {
      current: itemName || imageUrl || `Row ${rowNumber}`,
      message: `Downloading row ${rowNumber}...`,
    });
    logJob(jobId, `Downloading row ${rowNumber}: ${itemName || '(empty)'}`);

    if (!itemName || !imageUrl) {
      const error = 'missing item name or URL';
      failed += 1;
      const record = makeFailedRow(rowNumber, itemName, imageUrl, error, '');
      failedRows.push(record);
      reportLines.push(`FAIL | Row ${rowNumber}: ${itemName || '(empty)'} -> ${error}`);
      logJob(jobId, `FAIL: ${itemName || '(empty)'} -> ${error}`);

      done += 1;
      updateProgress(`Failed row ${rowNumber}`);
      return;
    }

    try {
      const result = await downloadImage(imageUrl, {
        referer: job.referer,
        timeoutMs: job.settings.timeoutMs,
        retries: job.settings.retries,
        browserFallback: job.settings.browserFallback,
      });

      const ext = detectExtension(result.buffer, result.contentType, result.finalUrl || imageUrl);
      if (!ext) {
        throw new Error(`unsupported content type (${result.contentType || 'unknown'})`);
      }

      const safeBase = sanitizeFileName(itemName) || `item_${rowNumber}`;
      const filename = uniqueName(safeBase, ext, usedNames);
      const filePath = path.join(tempDir, filename);
      await fs.writeFile(filePath, result.buffer);

      downloaded.push({
        order: task.index,
        filePath,
        filename,
        rowNumber,
        itemName,
        imageUrl,
        method: result.method,
      });

      ready += 1;
      reportLines.push(`OK   | ${rowNumber} | ${itemName} | ${filename} | ${result.method}`);
      logJob(jobId, `OK: ${itemName} -> ${filename} (${result.method})`);
    } catch (err) {
      failed += 1;
      const error = err?.message || String(err);
      const record = makeFailedRow(rowNumber, itemName, imageUrl, error, '');
      failedRows.push(record);
      reportLines.push(`FAIL | Row ${rowNumber}: ${itemName} -> ${error}`);
      logJob(jobId, `FAIL: ${itemName} -> ${error}`);
    }

    done += 1;
    updateProgress(`Processed row ${rowNumber}`);
  }

  function updateProgress(currentLabel) {
    const progress = dataRows.length ? Math.round((done / dataRows.length) * 100) : 0;
    const elapsed = Date.now() - startedAt;
    const etaMs = progress > 0 && progress < 100 ? Math.round((elapsed * (100 - progress)) / progress) : 0;

    updateJob(jobId, {
      done,
      ready,
      failed,
      progress,
      current: currentLabel,
      etaMs,
    });
  }
}

function makeFailedRow(rowNumber, itemName, imageUrl, error, method) {
  return {
    rowNumber: Number(rowNumber || 0),
    itemName: String(itemName || ''),
    imageUrl: String(imageUrl || ''),
    error: String(error || ''),
    method: String(method || ''),
    errorType: categorizeError(String(error || '')),
  };
}

function summarizeFailures(failedRows) {
  const summary = makeEmptyErrorSummary();

  failedRows.forEach((row) => {
    summary.total += 1;
    const type = row?.errorType || categorizeError(row?.error || '');
    if (type === 'forbidden') summary.forbidden += 1;
    else if (type === 'unauthorized') summary.unauthorized += 1;
    else if (type === 'notFound') summary.notFound += 1;
    else if (type === 'timeout') summary.timeout += 1;
    else if (type === 'nonImage') summary.nonImage += 1;
    else summary.other += 1;
  });

  return summary;
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

function categorizeError(errorText) {
  const text = String(errorText || '').toLowerCase();

  if (text.includes('403') || text.includes('forbidden')) return 'forbidden';
  if (text.includes('401') || text.includes('unauthorized')) return 'unauthorized';
  if (text.includes('404') || text.includes('not found')) return 'notFound';
  if (text.includes('timeout') || text.includes('timed out') || text.includes('etimedout') || text.includes('aborted')) return 'timeout';
  if (
    text.includes('non-image') ||
    text.includes('unsupported content type') ||
    text.includes('blocked content type') ||
    text.includes('text/html') ||
    text.includes('html response') ||
    text.includes('image not found')
  ) {
    return 'nonImage';
  }

  return 'other';
}

function createFailedRowsCsv(rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Excel row', 'Item name', 'URL', 'Error', 'Method', 'Error type']];

  rows.forEach((row) => {
    lines.push([
      row.rowNumber,
      row.itemName,
      row.imageUrl,
      row.error,
      row.method || '',
      row.errorType || '',
    ]);
  });

  return lines.map((r) => r.map(esc).join(',')).join('\n');
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function randomId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

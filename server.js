const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');

const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const morgan = require('morgan');

const { downloadImage, closeDownloaderResources } = require('./src/downloader');
const { buildZip } = require('./src/zipBuilder');
const {
  processOutputImage,
  normalizeOutputImageMode,
  OUTPUT_IMAGE_MODES,
} = require('./src/imageProcessor');
const {
  formatBytes,
  formatDuration,
  sanitizeFileName,
  detectExtension,
  uniqueName,
} = require('./src/utils');

const APP_NAME = 'PicCatch';
const SERVICE_NAME = 'piccatch';
const API_BODY_LIMIT = '25mb';
const MAX_ROWS_PER_JOB = 50000;
const JOB_RETENTION_MS = clampInt(process.env.JOB_RETENTION_MS, 15 * 60 * 1000, 24 * 60 * 60 * 1000, 6 * 60 * 60 * 1000);
const JOB_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const LOG_LIMIT = 220;
const SNAPSHOT_LOG_LIMIT = 140;
const MAX_LOG_LINE_LENGTH = 2500;
const MAX_REPORT_ERROR_LENGTH = 1200;
const HISTORY_LIMIT = clampInt(process.env.HISTORY_LIMIT, 1, 100, 12);

const app = express();
const PORT = Number(process.env.PORT || 3000);

const DEFAULT_SETTINGS = {
  timeoutMs: 45000,
  retries: 2,
  concurrency: 4,
  browserFallback: true,
  htmlImageDiscovery: false,
  outputImageMode: OUTPUT_IMAGE_MODES.ORIGINAL,
  maxSide: 3000,
  quality: 92,
};

const jobs = new Map();
const history = [];

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.disable('etag');

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(assignRequestId);
morgan.token('id', (req) => req.id || '-');
app.use(morgan(':id :method :url :status :res[content-length] - :response-time ms'));
app.use(express.json({ limit: API_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: API_BODY_LIMIT }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  },
}));

app.use('/api', (req, res, next) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });

  if (req.method === 'HEAD') {
    return res
      .status(405)
      .set({
        Allow: 'GET, POST, OPTIONS',
        'Content-Type': 'text/plain; charset=utf-8',
      })
      .end();
  }

  next();
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: SERVICE_NAME,
    name: APP_NAME,
    version: process.env.npm_package_version || '4.0.0',
    time: new Date().toISOString(),
    runtime: getRuntimeInfo(),
  });
});

app.get('/api', (_req, res) => {
  res.json(getApiInfoPayload());
});

app.all('/api', (_req, res) => {
  res.status(405).json({
    ok: false,
    message: 'Method not allowed.',
    allowedMethods: ['GET'],
  });
});

app.get('/api/info', (_req, res) => {
  res.json(getApiInfoPayload());
});

function getApiInfoPayload() {
  return {
    ok: true,
    service: SERVICE_NAME,
    name: APP_NAME,
    version: process.env.npm_package_version || '4.0.0',
    runtime: getRuntimeInfo(),
    jobs: {
      total: jobs.size,
      active: Array.from(jobs.values()).filter((job) => job.status === 'processing' || job.status === 'queued').length,
      done: Array.from(jobs.values()).filter((job) => job.status === 'done').length,
      error: Array.from(jobs.values()).filter((job) => job.status === 'error').length,
    },
    history: {
      total: history.length,
      limit: HISTORY_LIMIT,
    },
  };
}

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
      htmlImageDiscovery: body?.settings?.htmlImageDiscovery === true,
      outputImageMode: normalizeOutputImageMode(body?.settings?.outputImageMode || DEFAULT_SETTINGS.outputImageMode),
      maxSide: clampInt(body?.settings?.maxSide, 256, 8000, DEFAULT_SETTINGS.maxSide),
      quality: clampInt(body?.settings?.quality, 50, 100, DEFAULT_SETTINGS.quality),
    };

    if (!rows.length) {
      return res.status(400).json({
        ok: false,
        message: 'Please upload a file with at least one header row.',
      });
    }

    if (rows.length > MAX_ROWS_PER_JOB) {
      return res.status(413).json({
        ok: false,
        message: `This file has too many rows. Please keep each job under ${MAX_ROWS_PER_JOB.toLocaleString()} rows.`,
      });
    }

    const job = await createJob({
      fileName,
      rows,
      referer,
      settings,
    });

    res.status(200).json({ ok: true, jobId: job.id });

    setImmediate(() => {
      processJob(job.id).catch((err) => {
        const error = compactError(err, MAX_REPORT_ERROR_LENGTH);
        updateJob(job.id, {
          status: 'error',
          message: 'Processing failed.',
          error,
          current: 'Error',
        });
        appendLog(job.id, `ERROR: ${error}`);
      });
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      message: String(err?.message || err || 'Start failed'),
    });
  }
});

app.get('/api/status/:jobId', (req, res) => {
  const snapshot = snapshotJob(req.params.jobId);
  if (!snapshot) {
    return res.status(404).json({
      ok: false,
      message: 'Job not found.',
    });
  }

  return res.status(200).json({ ok: true, ...snapshot });
});

app.get('/api/history', (req, res) => {
  const limit = clampInt(req.query.limit, 1, HISTORY_LIMIT, HISTORY_LIMIT);
  return res.status(200).json({
    ok: true,
    limit,
    history: getHistoryPayload(limit),
  });
});

app.get('/api/report/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  const entry = history.find((item) => item.jobId === req.params.jobId);

  if (!job && !entry) {
    return res.status(404).json({
      ok: false,
      message: 'Report not found.',
    });
  }

  const source = job || entry;
  const downloadReady = Boolean(job?.zipPath && job.status === 'done');
  const reportText = source.reportText || buildFallbackReport(source);
  return res.status(200).json({
    ok: true,
    jobId: source.id || source.jobId,
    fileName: source.fileName || 'catalog.xlsx',
    status: source.status || 'unknown',
    ready: Number(source.ready || 0),
    failed: Number(source.failed || 0),
    zipSizeBytes: Number(source.zipSizeBytes || 0),
    zipSizeText: source.zipSizeText || '—',
    finishedAt: source.finishedAt || null,
    reportText,
    failedCsv: source.failedCsv || '',
    downloadReady,
    downloadUrl: downloadReady ? `/api/download/${job.id}` : null,
  });
});

app.get('/api/download/:jobId', async (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      ok: false,
      message: 'Job not found.',
    });
  }

  if (job.status !== 'done' || !job.zipPath) {
    return res.status(409).json({
      ok: false,
      message: 'ZIP is not ready yet.',
    });
  }

  try {
    await fs.access(job.zipPath);
    job.lastDownloadedAt = Date.now();
    res.set({
      'Content-Type': 'application/zip',
      'X-Download-Options': 'noopen',
    });
    return res.download(job.zipPath, job.downloadName || path.basename(job.zipPath), (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({
          ok: false,
          message: 'Could not stream ZIP file.',
        });
      }
    });
  } catch {
    return res.status(404).json({
      ok: false,
      message: 'File not available.',
    });
  }
});

app.use((req, res, next) => {
  if (isApiPath(req.path)) {
    return res.status(404).json({
      ok: false,
      message: 'Not found.',
    });
  }
  next();
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({
      ok: false,
      message: 'Invalid JSON body.',
    });
  }

  const isApi = isApiPath(req.path) || isApiPath(req.originalUrl || '');
  const status = err?.type === 'entity.too.large'
    ? 413
    : clampInt(err?.status || err?.statusCode, 400, 599, 500);
  const message = status === 413
    ? `Request body is too large. Limit is ${API_BODY_LIMIT}.`
    : process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : String(err?.message || err || 'Internal server error');

  console.error({
    level: 'error',
    message: 'Unhandled request error',
    error: String(err?.stack || err?.message || err),
  });

  if (isApi) {
    return res.status(status).json({
      ok: false,
      message,
    });
  }

  res.status(status).json({
    ok: false,
    message,
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚀 ${APP_NAME} started successfully
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Port: ${PORT}
Mode: ${process.env.NODE_ENV || 'development'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
});

const cleanupTimer = setInterval(() => {
  cleanupExpiredJobs().catch((err) => {
    console.error({
      level: 'error',
      message: 'Job cleanup failed',
      error: String(err?.message || err),
    });
  });
}, JOB_CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

async function createJob({ fileName, rows, referer, settings }) {
  const id = randomId();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piccatch-'));
  const now = Date.now();

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

    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    expiresAt: now + JOB_RETENTION_MS,
    lastDownloadedAt: null,

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
  upsertHistoryEntry(job);
  return job;
}

function snapshotJob(id) {
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
    logs: job.logs.slice(-SNAPSHOT_LOG_LIMIT),
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

function updateJob(id, patch = {}) {
  const job = jobs.get(id);
  if (!job) return null;

  const updatedAt = Date.now();
  const nextPatch = { ...patch };
  if (isFinalStatus(nextPatch.status) && !job.finishedAt) {
    nextPatch.finishedAt = updatedAt;
  }
  if (isFinalStatus(nextPatch.status) && !Object.prototype.hasOwnProperty.call(nextPatch, 'rows')) {
    nextPatch.rows = [];
  }

  Object.assign(job, nextPatch, {
    updatedAt,
    expiresAt: updatedAt + JOB_RETENTION_MS,
  });

  upsertHistoryEntry(job);
  return job;
}

function upsertHistoryEntry(job) {
  if (!job || !job.id) return null;

  const existingIndex = history.findIndex((item) => item.jobId === job.id);
  const existing = existingIndex >= 0 ? history[existingIndex] : {};
  const entry = {
    ...existing,
    jobId: job.id,
    fileName: job.fileName || 'catalog.xlsx',
    status: job.status || 'unknown',
    ready: Number(job.ready || 0),
    failed: Number(job.failed || 0),
    total: Number(job.total || 0),
    zipSizeBytes: Number(job.zipSizeBytes || 0),
    zipSizeText: job.zipSizeText || '—',
    startedAt: job.startedAt || existing.startedAt || Date.now(),
    updatedAt: job.updatedAt || Date.now(),
    finishedAt: job.finishedAt || (isFinalStatus(job.status) ? job.updatedAt : null),
    downloadName: job.downloadName || existing.downloadName || null,
    message: job.message || existing.message || '',
    error: job.error || existing.error || '',
    reportText: job.reportText || existing.reportText || '',
    failedCsv: job.failedCsv || existing.failedCsv || '',
  };

  if (existingIndex >= 0) {
    history.splice(existingIndex, 1);
  }

  history.unshift(entry);
  if (history.length > HISTORY_LIMIT) {
    history.splice(HISTORY_LIMIT);
  }

  return entry;
}

function getHistoryPayload(limit = HISTORY_LIMIT) {
  const max = clampInt(limit, 1, HISTORY_LIMIT, HISTORY_LIMIT);
  return history.slice(0, max).map((entry) => {
    const job = jobs.get(entry.jobId);
    const source = job || entry;
    const downloadReady = Boolean(job?.zipPath && job.status === 'done');
    const status = source.status || entry.status || 'unknown';
    const reportReady = isFinalStatus(status) || Boolean(source.reportText || entry.reportText);

    return {
      jobId: entry.jobId,
      fileName: source.fileName || entry.fileName || 'catalog.xlsx',
      status,
      ready: Number(source.ready ?? entry.ready ?? 0),
      failed: Number(source.failed ?? entry.failed ?? 0),
      total: Number(source.total ?? entry.total ?? 0),
      zipSizeBytes: Number(source.zipSizeBytes ?? entry.zipSizeBytes ?? 0),
      zipSizeText: source.zipSizeText || entry.zipSizeText || '—',
      startedAt: source.startedAt || entry.startedAt || null,
      updatedAt: source.updatedAt || entry.updatedAt || null,
      finishedAt: source.finishedAt || entry.finishedAt || null,
      downloadName: source.downloadName || entry.downloadName || null,
      downloadReady,
      downloadUrl: downloadReady ? `/api/download/${entry.jobId}` : null,
      reportReady,
      reportUrl: reportReady ? `/api/report/${entry.jobId}` : null,
    };
  });
}

function isFinalStatus(status) {
  return status === 'done' || status === 'error';
}

function buildFallbackReport(source = {}) {
  return [
    `${APP_NAME} Processing Report`,
    `Source file: ${source.fileName || 'catalog.xlsx'}`,
    `Status: ${source.status || 'unknown'}`,
    `Success: ${Number(source.ready || 0)}`,
    `Failed: ${Number(source.failed || 0)}`,
    `ZIP size: ${source.zipSizeText || '—'}`,
    `Finished: ${source.finishedAt ? new Date(source.finishedAt).toLocaleString() : '(not finished)'}`,
    '',
    source.error || source.message || 'A detailed report has not been generated for this run yet.',
  ].join('\n');
}

function appendLog(id, message) {
  const job = jobs.get(id);
  if (!job) return null;

  const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  job.logs.push(`[${stamp}] ${truncateText(message, MAX_LOG_LINE_LENGTH)}`);
  if (job.logs.length > LOG_LIMIT) {
    job.logs.splice(0, job.logs.length - LOG_LIMIT);
  }

  job.updatedAt = Date.now();
  job.expiresAt = job.updatedAt + JOB_RETENTION_MS;
  return job;
}

async function processJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  const rows = Array.isArray(job.rows) ? job.rows : [];
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
      current: 'No data',
      etaMs: 0,
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
    etaMs: 0,
    errorSummary: makeEmptyErrorSummary(),
    failedRows: [],
  });

  reportLines.push(`${APP_NAME} Processing Report`);
  reportLines.push(`Source file: ${job.fileName}`);
  reportLines.push(`Generated: ${new Date().toLocaleString()}`);
  reportLines.push(`Rows (excluding header): ${dataRows.length}`);
  reportLines.push(`Referer: ${job.referer || '(none)'}`);
  reportLines.push(
    `Settings: timeout=${job.settings.timeoutMs}ms, retries=${job.settings.retries}, concurrency=${job.settings.concurrency}, browserFallback=${job.settings.browserFallback ? 'on' : 'off'}, htmlImageDiscovery=${job.settings.htmlImageDiscovery ? 'on' : 'off'}, outputImageMode=${job.settings.outputImageMode || OUTPUT_IMAGE_MODES.ORIGINAL}, maxSide=${job.settings.maxSide}, quality=${job.settings.quality}`
  );
  reportLines.push('');
  reportLines.push('Header row skipped automatically.');
  reportLines.push('OK format: Excel row | Item name | Filename | Method | Final URL');
  reportLines.push('FAIL format: Excel row | Item name | Error');
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

      const task = tasks[current];
      await processRowTask(task);
    }
  });

  await Promise.all(workers);

  reportLines.push('');
  reportLines.push('Processing Summary');
  reportLines.push(`Success: ${ready}`);
  reportLines.push(`Failed: ${failed}`);
  reportLines.push(`Total rows: ${dataRows.length}`);
  reportLines.push(`Elapsed: ${formatDuration(Date.now() - startedAt)}`);

  const zipBase = sanitizeFileName(job.fileName.replace(/\.[^.]+$/, '')) || 'images';
  const zipName = `${zipBase}.zip`;
  const zipPath = path.join(tempDir, zipName);
  const reportText = reportLines.join('\n');
  const failedCsv = createFailedRowsCsv(failedRows);
  const errorSummary = summarizeFailures(failedRows);

  const zipResult = await buildZip({
    zipPath,
    entries: downloaded.sort((a, b) => a.order - b.order),
    reportText,
    failedCsv,
  });

  const zipStats = await fs.stat(zipPath);
  await cleanupIntermediateFiles(downloaded);

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
    errorSummary,
    etaMs: 0,
  });

  appendLog(jobId, `ZIP ready: ${zipName} (${formatBytes(zipStats.size)}, ${zipResult.entries} files)`);

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
    appendLog(jobId, `Downloading row ${rowNumber}: ${itemName || '(empty)'}`);

    if (!itemName || !imageUrl) {
      const error = 'missing item name or URL';
      failed += 1;
      const record = makeFailedRow(rowNumber, itemName, imageUrl, error, '');
      failedRows.push(record);
      reportLines.push(`FAIL | Row ${rowNumber}: ${itemName || '(empty)'} -> ${error}`);
      appendLog(jobId, `FAIL: ${itemName || '(empty)'} -> ${error}`);

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
        htmlImageDiscovery: job.settings.htmlImageDiscovery,
        preserveOriginal: true,
        maxSide: job.settings.maxSide,
        quality: job.settings.quality,
      });

      const output = await processOutputImage(result.buffer, {
        outputImageMode: job.settings.outputImageMode,
        contentType: result.contentType,
        sourceUrl: result.finalUrl || imageUrl,
      });
      const outputBuffer = output.buffer;
      const outputContentType = output.contentType;
      const resizedOutput = output.outputImageMode === OUTPUT_IMAGE_MODES.RESIZE_2016_1512;
      const outputMethod = resizedOutput ? `${result.method}+${output.method}` : result.method;
      const outputLog = formatOutputImageLog(output);

      const ext = resizedOutput ? 'jpg' : (detectExtension(outputBuffer, outputContentType, result.finalUrl || imageUrl) || 'jpg');
      const safeBase = sanitizeFileName(itemName) || `item_${rowNumber}`;
      const filename = uniqueName(safeBase, ext, usedNames);
      const filePath = path.join(tempDir, filename);

      await fs.writeFile(filePath, outputBuffer);

      downloaded.push({
        order: task.index,
        filePath,
        filename,
        rowNumber,
        itemName,
        imageUrl,
        finalUrl: result.finalUrl || imageUrl,
        method: outputMethod,
      });

      ready += 1;
      reportLines.push(`OK   | ${rowNumber} | ${itemName} | ${filename} | ${outputMethod} | ${result.finalUrl || imageUrl}`);
      appendLog(jobId, `OK: ${itemName} -> ${filename} (${outputMethod}; ${outputLog})`);
    } catch (err) {
      failed += 1;
      const error = compactError(err, MAX_REPORT_ERROR_LENGTH);
      const record = makeFailedRow(rowNumber, itemName, imageUrl, error, '');
      failedRows.push(record);
      reportLines.push(`FAIL | Row ${rowNumber}: ${itemName} -> ${error}`);
      appendLog(jobId, `FAIL: ${itemName} -> ${error}`);
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
      truncateText(row.error, MAX_REPORT_ERROR_LENGTH),
      row.method || '',
      row.errorType || '',
    ]);
  });

  return lines.map((r) => r.map(esc).join(',')).join('\n');
}

function assignRequestId(req, res, next) {
  req.id = randomId();
  res.setHeader('X-Request-Id', req.id);
  next();
}

function isApiPath(value) {
  const pathName = String(value || '').split('?')[0];
  return pathName === '/api' || pathName.startsWith('/api/');
}

async function cleanupIntermediateFiles(entries = []) {
  const filePaths = Array.from(new Set(
    entries
      .map((entry) => entry?.filePath)
      .filter(Boolean)
  ));
  if (!filePaths.length) return;

  const results = await Promise.allSettled(filePaths.map((filePath) => fs.rm(filePath, { force: true })));
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length) {
    console.warn({
      level: 'warn',
      message: 'Some intermediate image files could not be removed',
      count: failed.length,
    });
  }
}

async function cleanupExpiredJobs() {
  const now = Date.now();
  const removals = [];

  for (const job of jobs.values()) {
    if (isActiveJob(job)) continue;
    if ((job.expiresAt || 0) > now) continue;
    removals.push(cleanupJob(job, 'expired'));
  }

  await Promise.allSettled(removals);
}

async function cleanupJob(job, reason) {
  if (!job || !job.id) return;
  jobs.delete(job.id);

  if (job.tempDir) {
    await fs.rm(job.tempDir, { recursive: true, force: true });
  }

  console.log({
    level: 'info',
    message: 'Cleaned up job artifacts',
    jobId: job.id,
    reason,
  });
}

function isActiveJob(job) {
  return job?.status === 'queued' || job?.status === 'processing';
}

function compactError(err, maxLength = MAX_REPORT_ERROR_LENGTH) {
  const raw = String(err?.message || err || 'download failed');
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const important = [];
  for (const line of lines) {
    if (
      important.length < 8 &&
      (/^(image download failed|HTTP Status|Content-Type|Final URL|Redirect Chain|Retry strategy|Protocol used|Browser used|Last error)/i.test(line) ||
        important.length === 0)
    ) {
      important.push(line);
    }
  }

  return truncateText(important.length ? important.join(' | ') : raw, maxLength);
}

function truncateText(value, maxLength) {
  const text = String(value ?? '');
  const limit = Number(maxLength || 0);
  if (!limit || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function formatOutputImageLog(output) {
  if (!output || output.outputImageMode === OUTPUT_IMAGE_MODES.ORIGINAL) {
    return `output=original${formatDimensions(output?.width, output?.height)}`;
  }

  const before = formatDimensions(output.originalWidth, output.originalHeight);
  const after = formatDimensions(output.width, output.height);
  return `output=resized${before ? ` from ${before.trim()}` : ''}${after ? ` to ${after.trim()}` : ''}`;
}

function formatDimensions(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return '';
  return ` ${Math.round(w)}x${Math.round(h)}`;
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

function getRuntimeInfo() {
  const mem = process.memoryUsage();
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    uptimeSec: Math.round(process.uptime()),
    memory: {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
    },
  };
}

function shutdown(signal) {
  console.log({
    level: 'info',
    message: 'Shutting down',
    signal,
  });

  clearInterval(cleanupTimer);

  let closed = false;
  const finishShutdown = async () => {
    if (closed) return;
    closed = true;
    const removals = Array.from(jobs.values()).map((job) => cleanupJob(job, 'shutdown'));
    await Promise.allSettled(removals);
    await closeDownloaderResources().catch((err) => {
      console.error({
        level: 'error',
        message: 'Downloader resource cleanup failed',
        error: String(err?.message || err),
      });
    });
    process.exit(0);
  };

  server.close((err) => {
    if (err) {
      console.error({
        level: 'error',
        message: 'HTTP server close failed',
        error: String(err?.message || err),
      });
    }
    finishShutdown().catch(() => process.exit(1));
  });

  server.closeIdleConnections?.();

  const forceCloseTimer = setTimeout(() => {
    server.closeAllConnections?.();
  }, 2500);
  forceCloseTimer.unref?.();

  setTimeout(() => process.exit(1), 10000).unref();
}

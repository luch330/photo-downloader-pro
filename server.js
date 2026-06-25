const path = require('path');
const fs = require('fs/promises');
const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const morgan = require('morgan');

const { createJobStore } = require('./src/state');
const { downloadImage } = require('./src/downloader');
const { buildZip } = require('./src/zipBuilder');
const {
  formatBytes,
  formatDuration,
  sanitizeFileName,
  detectExtension,
  uniqueName,
  sleep,
} = require('./src/utils');

const app = express();
const store = createJobStore();
const PORT = Number(process.env.PORT || 3000);
const DEFAULT_SETTINGS = {
  timeoutMs: 45000,
  retries: 2,
  concurrency: 4,
  browserFallback: true,
};

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

    const job = await store.create({ fileName, rows, referer, settings });
    res.json({ ok: true, jobId: job.id });

    setImmediate(() => {
      processJob(job.id).catch((err) => {
        store.update(job.id, {
          status: 'error',
          error: err?.message || String(err),
          message: 'Processing failed.',
          updatedAt: Date.now(),
        });
        store.log(job.id, `ERROR: ${err?.stack || err?.message || String(err)}`);
      });
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err?.message || String(err) });
  }
});

app.get('/api/status/:jobId', (req, res) => {
  const job = store.snapshot(req.params.jobId);
  if (!job) {
    return res.status(404).json({ ok: false, message: 'Job not found.' });
  }
  res.json({ ok: true, ...job });
});

app.get('/api/download/:jobId', async (req, res) => {
  const job = store.get(req.params.jobId);
  if (!job || !job.zipPath) {
    return res.status(404).send('Not ready');
  }

  try {
    await fs.access(job.zipPath);
    res.download(job.zipPath, job.downloadName || path.basename(job.zipPath));
  } catch (err) {
    res.status(404).send('File not available');
  }
});

app.use((_req, res) => {
  res.status(404).send('Not found');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Photo downloader running on port ${PORT}`);
});

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function processJob(jobId) {
  const job = store.get(jobId);
  if (!job) return;

  const rows = Array.isArray(job.rows) ? job.rows : [];
  if (rows.length < 1) {
    store.update(jobId, {
      status: 'error',
      message: 'No rows found.',
      error: 'No rows found.',
      updatedAt: Date.now(),
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
    store.update(jobId, {
      status: 'error',
      message: 'The file contains only a header row.',
      error: 'The file contains only a header row.',
      preview,
      total: 0,
      updatedAt: Date.now(),
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

  store.update(jobId, {
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
    updatedAt: Date.now(),
  });

  reportLines.push('Photo downloader report');
  reportLines.push(`Source file: ${job.fileName}`);
  reportLines.push(`Generated: ${new Date().toLocaleString()}`);
  reportLines.push(`Rows (excluding header): ${dataRows.length}`);
  reportLines.push(`Referer: ${job.referer || '(none)'}`);
  reportLines.push(`Settings: timeout=${job.settings.timeoutMs}ms, retries=${job.settings.retries}, concurrency=${job.settings.concurrency}, browserFallback=${job.settings.browserFallback}`);
  reportLines.push('');
  reportLines.push('Header row skipped automatically.');
  reportLines.push('');

  const tasks = dataRows.map((row, index) => ({
    row,
    index,
    rowNumber: index + 2,
  }));

  const concurrency = Math.min(job.settings.concurrency || 4, tasks.length);
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

  store.update(jobId, {
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
    updatedAt: Date.now(),
  });
  store.log(jobId, `ZIP ready: ${zipName} (${formatBytes(zipStats.size)})`);

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

    store.update(jobId, {
      current: itemName || imageUrl || `Row ${rowNumber}`,
      message: `Downloading row ${rowNumber}...`,
      updatedAt: Date.now(),
    });
    store.log(jobId, `Downloading row ${rowNumber}: ${itemName || '(empty)'}`);

    if (!itemName || !imageUrl) {
      const error = 'missing item name or URL';
      failed += 1;
      failedRows.push([rowNumber, itemName, imageUrl, error, '']);
      reportLines.push(`FAIL | Row ${rowNumber}: ${itemName || '(empty)'} -> ${error}`);
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
      store.log(jobId, `OK: ${itemName} -> ${filename} (${result.method})`);
    } catch (err) {
      failed += 1;
      const error = err?.message || String(err);
      failedRows.push([rowNumber, itemName, imageUrl, error, '']);
      reportLines.push(`FAIL | Row ${rowNumber}: ${itemName} -> ${error}`);
      store.log(jobId, `FAIL: ${itemName} -> ${error}`);
    }

    done += 1;
    updateProgress(`Processed row ${rowNumber}`);
  }

  function updateProgress(currentLabel) {
    const progress = dataRows.length ? Math.round((done / dataRows.length) * 100) : 0;
    const elapsed = Date.now() - startedAt;
    const eta = progress > 0 && progress < 100 ? Math.round((elapsed * (100 - progress)) / progress) : 0;
    store.update(jobId, {
      done,
      ready,
      failed,
      progress,
      current: currentLabel,
      etaMs: eta,
      updatedAt: Date.now(),
    });
  }
}

function createFailedRowsCsv(rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Excel row', 'Item name', 'URL', 'Error', 'Method']];
  for (const row of rows) lines.push(row);
  return lines.map((r) => r.map(esc).join(',')).join('\n');
}
const crypto = require('crypto');
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
  browserFallback: false,
  maxSide: 3000,
  quality: 92,
};

const jobs = new Map();

app.disable('x-powered-by');
app.disable('etag');

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(morgan('dev'));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', (_req, res, next) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
  next();
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'photo-downloader-pro',
    time: new Date().toISOString(),
  });
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
      maxSide: clampInt(body?.settings?.maxSide, 256, 8000, DEFAULT_SETTINGS.maxSide),
      quality: clampInt(body?.settings?.quality, 50, 100, DEFAULT_SETTINGS.quality),
    };

    if (!rows.length) {
      return res.status(400).json({
        ok: false,
        message: 'Please upload a file with at least one header row.',
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
        const error = String(err?.message || err || 'processing failed');
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
    return res.download(job.zipPath, job.downloadName || path.basename(job.zipPath));
  } catch {
    return res.status(404).json({
      ok: false,
      message: 'File not available.',
    });
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      ok: false,
      message: 'Not found.',
    });
  }
  next();
});

app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({
      ok: false,
      message: 'Invalid JSON body.',
    });
  }

  console.error(err);
  res.status(500).json({
    ok: false,
    message: String(err?.message || err || 'Internal server error'),
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Photo downloader running on port ${PORT}`);
});

async function createJob({ fileName, rows, referer, settings }) {
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

function updateJob(id, patch = {}) {
  const job = jobs.get(id);
  if (!job) return null;

  Object.assign(job, patch, {
    updatedAt: Date.now(),
  });

  return job;
}

function appendLog(id, message) {
  const job = jobs.get(id);
  if (!job) return null;

  job.logs.push(String(message));
  if (job.logs.length > 200) {
    job.logs.splice(0, job.logs.length - 200);
  }

  job.updatedAt = Date.now();
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

  reportLines.push('Photo downloader report');
  reportLines.push(`Source file: ${job.fileName}`);
  reportLines.push(`Generated: ${new Date().toLocaleString()}`);
  reportLines.push(`Rows (excluding header): ${dataRows.length}`);
  reportLines.push(`Referer: ${job.referer || '(none)'}`);
  reportLines.push(
    `Settings: timeout=${job.settings.timeoutMs}ms, retries=${job.settings.retries}, concurrency=${job.settings.concurrency}, maxSide=${job.settings.maxSide}, quality=${job.settings.quality}`
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

  const zipBase = sanitizeFileName(job.fileName.replace(/\.[^.]+$/, '')) || 'images';
  const zipName = `${zipBase}.zip`;
  const zipPath = path.join(tempDir, zipName);
  const reportText = reportLines.join('\n');
  const failedCsv = createFailedRowsCsv(failedRows);
  const errorSummary = summarizeFailures(failedRows);

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
    errorSummary,
    etaMs: 0,
  });

  appendLog(jobId, `ZIP ready: ${zipName} (${formatBytes(zipStats.size)})`);

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
        maxSide: job.settings.maxSide,
        quality: job.settings.quality,
      });

      const ext = detectExtension(result.buffer, result.contentType, result.finalUrl || imageUrl) || 'jpg';
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
      appendLog(jobId, `OK: ${itemName} -> ${filename} (${result.method})`);
    } catch (err) {
      failed += 1;
      const error = String(err?.message || err || 'download failed');
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
function extractImageCandidates(html, baseUrl) {
  const candidates = [];
  const add = (value) => {
    if (!value) return;
    const v = String(value).trim();
    if (!v) return;
    candidates.push(resolveUrl(v, baseUrl));
  };

  const metaRegexes = [
    /<meta[^>]+property=["']og:image(?:\:url)?["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+name=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+property=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+name=["']twitter:image(?:\:src)?["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<link[^>]+rel=["'][^"']*image_src[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>/gi,
  ];

  metaRegexes.forEach((regex) => {
    let match;
    while ((match = regex.exec(html))) {
      add(match[1]);
    }
  });

  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(html))) {
    add(imgMatch[1]);
  }

  const lazyRegexes = [
    /data-src=["']([^"']+)["']/gi,
    /data-lazy-src=["']([^"']+)["']/gi,
    /data-original=["']([^"']+)["']/gi,
    /data-full=["']([^"']+)["']/gi,
    /data-srcset=["']([^"']+)["']/gi,
  ];

  lazyRegexes.forEach((regex) => {
    let match;
    while ((match = regex.exec(html))) {
      const val = match[1];
      if (regex.source.includes('srcset')) {
        String(val)
          .split(',')
          .map((s) => s.trim().split(' ')[0])
          .filter(Boolean)
          .forEach(add);
      } else {
        add(val);
      }
    }
  });

  const srcsetRegex = /srcset=["']([^"']+)["']/gi;
  let srcsetMatch;
  while ((srcsetMatch = srcsetRegex.exec(html))) {
    String(srcsetMatch[1])
      .split(',')
      .map((s) => s.trim().split(' ')[0])
      .filter(Boolean)
      .forEach(add);
  }

  const sourceRegex = /<source[^>]+(?:src|srcset)=["']([^"']+)["'][^>]*>/gi;
  let sourceMatch;
  while ((sourceMatch = sourceRegex.exec(html))) {
    const val = sourceMatch[1];
    if (String(sourceMatch[0]).includes('srcset=')) {
      String(val)
        .split(',')
        .map((s) => s.trim().split(' ')[0])
        .filter(Boolean)
        .forEach(add);
    } else {
      add(val);
    }
  }

  const bgRegex = /background(?:-image)?\s*:\s*url\((['"]?)([^'")]+)\1\)/gi;
  let bgMatch;
  while ((bgMatch = bgRegex.exec(html))) {
    add(bgMatch[2]);
  }

  const jsonLdBlocks = extractJsonLdBlocks(html);
  jsonLdBlocks.forEach((block) => {
    const urls = extractUrlsFromJsonLd(block, baseUrl);
    urls.forEach(add);
  });

  const urlRegex = /https?:\/\/[^"'\\\s>]+?\.(?:jpg|jpeg|png|webp|gif|bmp|svg|avif|heic|heif|tiff?)(?:\?[^"'\\\s>]*)?/gi;
  let urlMatch;
  while ((urlMatch = urlRegex.exec(html))) {
    add(urlMatch[0]);
  }

  return Array.from(new Set(candidates));
}

function extractJsonLdBlocks(html) {
  const blocks = [];
  const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html))) {
    const txt = String(match[1] || '').trim();
    if (txt) blocks.push(txt);
  }
  return blocks;
}

function extractUrlsFromJsonLd(block, baseUrl) {
  const out = [];
  const seen = new Set();

  const push = (value) => {
    const v = String(value || '').trim();
    if (!v) return;
    const resolved = resolveUrl(v, baseUrl);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  };

  const walk = (node) => {
    if (!node) return;

    if (typeof node === 'string') {
      if (looksLikeImageUrl(node)) push(node);
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (typeof node !== 'object') return;

    for (const [key, value] of Object.entries(node)) {
      const lower = String(key || '').toLowerCase();
      if (
        lower === 'image' ||
        lower === 'thumbnailurl' ||
        lower === 'contenturl' ||
        lower === 'url' ||
        lower === 'src' ||
        lower === 'poster'
      ) {
        walk(value);
      } else {
        walk(value);
      }
    }
  };

  try {
    const parsed = JSON.parse(block);
    walk(parsed);
  } catch {
    const matches = String(block).match(/https?:\/\/[^"'\\\s>]+?\.(?:jpg|jpeg|png|webp|gif|bmp|svg|avif|heic|heif|tiff?)(?:\?[^"'\\\s>]*)?/gi);
    if (matches) matches.forEach(push);
  }

  return out;
}

function looksLikeImageUrl(value) {
  return /\.(jpg|jpeg|png|webp|gif|bmp|svg|avif|heic|heif|tiff?)(\?|#|$)/i.test(String(value || ''));
}

function decodeDataUrl(dataUrl) {
  const match = String(dataUrl).match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
  if (!match) {
    throw new Error('invalid data url');
  }

  const contentType = match[1] || 'application/octet-stream';
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || '';
  const buffer = isBase64
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');

  if (!looksLikeImage(buffer, contentType)) {
    throw new Error(`unsupported data url content (${contentType})`);
  }

  return {
    buffer,
    contentType,
    finalUrl: dataUrl,
  };
}

function isDataUrl(value) {
  return /^data:/i.test(String(value || '').trim());
}

function looksLikeHtml(contentType, bufferOrText) {
  const ct = String(contentType || '').toLowerCase();
  const txt = Buffer.isBuffer(bufferOrText)
    ? bufferOrText.toString('utf8', 0, Math.min(bufferOrText.length, 1024)).toLowerCase()
    : String(bufferOrText || '').toLowerCase();

  return (
    ct.includes('text/html') ||
    ct.includes('application/xhtml') ||
    /<!doctype html|<html|<head|<meta|<body/i.test(txt)
  );
}

function looksLikeTextResponse(contentType, buffer) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.startsWith('text/')) return true;
  if (ct.includes('json') || ct.includes('xml') || ct.includes('javascript')) return true;
  if (!buffer || !buffer.length) return false;
  const sample = buffer.toString('utf8', 0, Math.min(buffer.length, 256));
  return /[<>{}\[\]a-zA-Z]/.test(sample);
}

function looksLikeImage(buffer, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.startsWith('image/')) return true;

  if (!buffer || !buffer.length) return false;

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  if (buffer.length >= 8 && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return true;
  if (buffer.length >= 6) {
    const head = buffer.subarray(0, 6).toString('ascii');
    if (head === 'GIF87a' || head === 'GIF89a') return true;
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return true;
  if (
    buffer.length >= 4 &&
    ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
      (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a))
  ) {
    return true;
  }

  if (buffer.length >= 12) {
    const head = buffer.subarray(0, 12).toString('ascii');
    if (head.startsWith('RIFF') && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return true;
  }

  const sample = buffer.toString('utf8', 0, Math.min(buffer.length, 512)).toLowerCase();
  if (sample.includes('<svg') || (sample.includes('<?xml') && sample.includes('<svg'))) return true;

  return false;
}
function requestWithRedirects(url, options) {
  return requestWithRedirectsImpl(url, options, 0);
}

async function requestWithRedirectsImpl(url, options, redirectCount) {
  if (redirectCount > MAX_REDIRECTS) {
    throw new Error('too many redirects');
  }

  const response = await requestOnce(url, options);

  options.jar?.setFromResponse(response.headers?.['set-cookie'], response.finalUrl || url);

  if (isRedirectStatus(response.status) && response.headers?.location) {
    const nextUrl = resolveUrl(firstHeader(response.headers.location), response.finalUrl || url);
    const nextMethod =
      response.status === 303 || ((response.status === 301 || response.status === 302) && options.method !== 'HEAD')
        ? 'GET'
        : options.method;

    const nextOptions = {
      ...options,
      method: nextMethod,
      referer: response.finalUrl || options.referer || url,
    };

    return requestWithRedirectsImpl(nextUrl, nextOptions, redirectCount + 1);
  }

  return response;
}

async function requestOnce(url, options) {
  const parsed = safeUrl(url);
  if (!parsed) {
    throw new Error('invalid url');
  }

  const useHttp2 = Boolean(options.allowHttp2 !== false && parsed.protocol === 'https:');
  const transports = useHttp2 ? ['http2', 'http1'] : ['http1'];

  let lastErr = null;

  for (const transport of transports) {
    try {
      if (transport === 'http2') {
        return await requestHttp2(parsed, options);
      }
      return await requestHttp1(parsed, options);
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error('request failed');
}

async function requestHttp1(parsedUrl, options) {
  const isHttps = parsedUrl.protocol === 'https:';
  const lib = isHttps ? https : http;
  const headers = buildRequestHeaders({
    url: parsedUrl.toString(),
    referer: options.referer,
    profile: options.profile,
    accept: options.accept,
    jar: options.jar,
    method: options.method,
    mode: options.mode,
    useHttp2: false,
  });

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        method: options.method,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || undefined,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        headers,
      },
      (res) => {
        collectResponse(res, parsedUrl.toString())
          .then(resolve)
          .catch(reject);
      }
    );

    req.on('error', reject);
    req.setTimeout(options.timeoutMs, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function requestHttp2(parsedUrl, options) {
  const headers = buildRequestHeaders({
    url: parsedUrl.toString(),
    referer: options.referer,
    profile: options.profile,
    accept: options.accept,
    jar: options.jar,
    method: options.method,
    mode: options.mode,
    useHttp2: true,
  });

  const authority = parsedUrl.port ? `${parsedUrl.hostname}:${parsedUrl.port}` : parsedUrl.hostname;
  const client = http2.connect(parsedUrl.origin);

  return new Promise((resolve, reject) => {
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        client.close();
      } catch {
        // ignore
      }
      reject(new Error('timeout'));
    }, options.timeoutMs);

    client.on('error', (err) => {
      clearTimeout(timer);
      try {
        client.close();
      } catch {
        // ignore
      }
      reject(err);
    });

    const req = client.request({
      ':method': options.method,
      ':path': `${parsedUrl.pathname}${parsedUrl.search}`,
      ':scheme': parsedUrl.protocol.replace(':', ''),
      ':authority': authority,
      ...headers,
    });

    const chunks = [];
    let responseHeaders = {};
    let status = 0;

    req.on('response', (headers) => {
      responseHeaders = normalizeResponseHeaders(headers);
      status = Number(responseHeaders[':status'] || headers[':status'] || 0);
    });

    req.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk));
    });

    req.on('end', async () => {
      clearTimeout(timer);
      try {
        client.close();
      } catch {
        // ignore
      }

      if (timedOut) return;

      const rawBody = Buffer.concat(chunks);
      const body = decodeEncodedBody(rawBody, responseHeaders['content-encoding']);
      const contentType = responseHeaders['content-type'] || '';
      const bodyText = looksLikeTextResponse(contentType, body)
        ? body.toString('utf8')
        : '';

      resolve({
        status,
        headers: responseHeaders,
        buffer: body,
        contentType,
        bodyText,
        finalUrl: parsedUrl.toString(),
        httpVersion: '2',
      });
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      try {
        client.close();
      } catch {
        // ignore
      }
      reject(err);
    });

    req.end();
  });
}

async function collectResponse(res, finalUrl) {
  const rawChunks = [];
  for await (const chunk of res) {
    rawChunks.push(Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(rawChunks);
  const headers = normalizeResponseHeaders(res.headers || {});
  const status = Number(res.statusCode || headers[':status'] || 0);
  const body = decodeEncodedBody(rawBody, headers['content-encoding']);
  const contentType = headers['content-type'] || '';
  const bodyText = looksLikeTextResponse(contentType, body)
    ? body.toString('utf8')
    : '';

  return {
    status,
    headers,
    buffer: body,
    contentType,
    bodyText,
    finalUrl,
    httpVersion: res.httpVersion || '1.1',
  };
}

function buildRequestHeaders({
  url,
  referer,
  profile,
  accept,
  jar,
  method,
  mode,
  useHttp2,
}) {
  const origin = getOrigin(referer) || getOrigin(url);
  const headers = {
    'user-agent': profile.userAgent,
    accept,
    'accept-language': profile.acceptLanguage,
    'accept-encoding': 'gzip, deflate, br',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    dnt: '1',
    'upgrade-insecure-requests': mode === 'document' ? '1' : '0',
    'sec-fetch-site': getSecFetchSite(url, referer),
    'sec-fetch-mode': mode === 'document' ? 'navigate' : 'no-cors',
    'sec-fetch-dest': mode === 'document' ? 'document' : 'image',
    ...profile.extraHeaders,
  };

  if (referer) {
    headers.referer = referer;
    if (origin) {
      headers.origin = origin;
    }
  }

  const cookieHeader = jar?.getHeader(url);
  if (cookieHeader) {
    headers.cookie = cookieHeader;
  }

  if (!useHttp2 && method !== 'HEAD') {
    headers.connection = 'keep-alive';
  }

  return headers;
}

function normalizeResponseHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = String(key).toLowerCase();
    if (Array.isArray(value)) {
      out[lower] = lower === 'set-cookie' ? value : value.join(', ');
    } else {
      out[lower] = value;
    }
  }
  return out;
}

function decodeEncodedBody(buffer, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  if (!buffer || !buffer.length) {
    return buffer;
  }

  try {
    if (enc.includes('br') && zlib.brotliDecompressSync) {
      return zlib.brotliDecompressSync(buffer);
    }
    if (enc.includes('gzip')) {
      return zlib.gunzipSync(buffer);
    }
    if (enc.includes('deflate')) {
      try {
        return zlib.inflateSync(buffer);
      } catch {
        return zlib.inflateRawSync(buffer);
      }
    }
  } catch {
    return buffer;
  }

  return buffer;
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(Number(status));
}

class CookieJar {
  constructor() {
    this.cookies = [];
  }

  setFromResponse(setCookie, requestUrl) {
    const list = Array.isArray(setCookie)
      ? setCookie
      : setCookie
        ? [setCookie]
        : [];

    const host = safeHostname(requestUrl);
    if (!host) return;

    for (const raw of list) {
      const parsed = parseSetCookie(raw, host);
      if (!parsed) continue;

      this.cookies = this.cookies.filter((cookie) => {
        return !(
          cookie.name === parsed.name &&
          cookie.domain === parsed.domain &&
          cookie.path === parsed.path
        );
      });

      if (!parsed.expired) {
        this.cookies.push(parsed);
      }
    }
  }

  getHeader(requestUrl) {
    const u = safeUrl(requestUrl);
    if (!u) return '';

    const now = Date.now();
    const host = u.hostname.toLowerCase();
    const path = u.pathname || '/';
    const isSecure = u.protocol === 'https:';

    const parts = this.cookies
      .filter((cookie) => {
        if (cookie.expires && cookie.expires <= now) return false;
        if (cookie.secure && !isSecure) return false;
        if (!domainMatches(host, cookie.domain, cookie.hostOnly)) return false;
        if (!path.startsWith(cookie.path)) return false;
        return true;
      })
      .map((cookie) => `${cookie.name}=${cookie.value}`);

    return parts.join('; ');
  }
}

function parseSetCookie(raw, defaultHost) {
  const text = String(raw || '').trim();
  if (!text) return null;

  const segments = text.split(';').map((s) => s.trim());
  const [nameValue, ...attrs] = segments;
  const eqIndex = nameValue.indexOf('=');
  if (eqIndex <= 0) return null;

  const name = nameValue.slice(0, eqIndex).trim();
  const value = nameValue.slice(eqIndex + 1).trim();
  if (!name) return null;

  const cookie = {
    name,
    value,
    domain: defaultHost.toLowerCase(),
    hostOnly: true,
    path: '/',
    secure: false,
    expires: null,
    expired: false,
  };

  for (const attr of attrs) {
    const [kRaw, ...rest] = attr.split('=');
    const k = kRaw.trim().toLowerCase();
    const v = rest.join('=').trim();

    if (k === 'domain' && v) {
      cookie.domain = v.replace(/^\./, '').toLowerCase();
      cookie.hostOnly = false;
    } else if (k === 'path' && v) {
      cookie.path = v.startsWith('/') ? v : `/${v}`;
    } else if (k === 'secure') {
      cookie.secure = true;
    } else if (k === 'expires' && v) {
      const expires = Date.parse(v);
      if (Number.isFinite(expires)) {
        cookie.expires = expires;
      }
    } else if (k === 'max-age' && v) {
      const seconds = Number.parseInt(v, 10);
      if (Number.isFinite(seconds)) {
        cookie.expires = Date.now() + seconds * 1000;
      }
    }
  }

  if (cookie.expires && cookie.expires <= Date.now()) {
    cookie.expired = true;
  }

  return cookie;
}

function domainMatches(host, domain, hostOnly) {
  const h = String(host || '').toLowerCase();
  const d = String(domain || '').toLowerCase();
  if (!h || !d) return false;

  if (hostOnly) {
    return h === d;
  }

  return h === d || h.endsWith(`.${d}`);
}

function safeHostname(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function safeUrl(value) {
  try {
    return new URL(String(value || ''));
  } catch {
    return null;
  }
}

function getOrigin(value) {
  try {
    return new URL(String(value || '')).origin;
  } catch {
    return '';
  }
}

function getSecFetchSite(url, referer) {
  const target = getOrigin(url);
  const ref = getOrigin(referer);

  if (!ref) return 'none';
  if (ref === target) return 'same-origin';
  return 'cross-site';
}

function resolveUrl(candidate, baseUrl) {
  const value = String(candidate || '').trim();
  if (!value) return value;

  if (/^https?:\/\//i.test(value)) return value;
  if (/^\/\//.test(value)) {
    const proto = String(baseUrl || '').startsWith('https:') ? 'https:' : 'http:';
    return `${proto}${value}`;
  }

  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function normalizeError(err) {
  const message = String(err?.message || err || 'download failed').toLowerCase();

  if (
    message.includes('aborted') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('etimedout')
  ) {
    return 'timeout';
  }

  return String(err?.message || err || 'download failed');
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function firstHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

function looksLikeImageUrl(value) {
  return /\.(jpg|jpeg|png|webp|gif|bmp|svg|avif|heic|heif|tiff?)(\?|#|$)/i.test(String(value || ''));
}

module.exports = {
  downloadImage,
};

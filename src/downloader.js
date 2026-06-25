const { chromium } = require('playwright');
const { sleep, isImageContentType, getOrigin } = require('./utils');

const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const DEFAULT_ACCEPT = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8';
const DEFAULT_LANG = 'en-US,en;q=0.9,bg;q=0.8';

async function downloadImage(url, options = {}) {
  const {
    referer = '',
    timeoutMs = 45000,
    retries = 2,
    browserFallback = true,
    userAgent = DEFAULT_UA,
  } = options;

  const refCandidates = uniqueList([referer, getOrigin(url), '']);
  let lastError = new Error('download failed');

  for (const ref of refCandidates) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const headers = {
          'User-Agent': userAgent,
          Accept: DEFAULT_ACCEPT,
          'Accept-Language': DEFAULT_LANG,
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        };
        if (ref) headers.Referer = ref;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
        const response = await fetch(url, {
          method: 'GET',
          headers,
          redirect: 'follow',
          signal: controller.signal,
        });
        clearTimeout(timer);

        const contentType = response.headers.get('content-type') || '';
        const buffer = Buffer.from(await response.arrayBuffer());

        if (response.ok && isImageContentType(contentType)) {
          return {
            buffer,
            contentType,
            finalUrl: response.url,
            method: `fetch:${ref || 'no-referer'}`,
          };
        }

        if (response.ok && looksLikeImageBytes(buffer)) {
          return {
            buffer,
            contentType,
            finalUrl: response.url,
            method: `fetch-bytes:${ref || 'no-referer'}`,
          };
        }

        lastError = new Error(`HTTP ${response.status} (${contentType || 'no content-type'})`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (/aborted|timeout/i.test(lastError.message)) {
          // let it retry with other referers / methods
        }
      }
      await sleep(250 + attempt * 250);
    }
  }

  if (browserFallback) {
    try {
      return await downloadWithBrowser(url, { referer, timeoutMs, userAgent });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError;
}

async function downloadWithBrowser(url, options = {}) {
  const { referer = '', timeoutMs = 45000, userAgent = DEFAULT_UA } = options;
  const origin = getOrigin(url);
  const ref = referer || origin || undefined;
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      userAgent,
      locale: 'en-US',
      viewport: { width: 1440, height: 1080 },
      extraHTTPHeaders: {
        Accept: DEFAULT_ACCEPT,
        'Accept-Language': DEFAULT_LANG,
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    });

    const page = await context.newPage();
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
      referer: ref,
    });

    if (!response) {
      throw new Error('browser returned no response');
    }

    const contentType = response.headers()['content-type'] || '';
    const buffer = await response.body();
    if (!(response.ok() && (isImageContentType(contentType) || looksLikeImageBytes(buffer)))) {
      throw new Error(`non-image response (${contentType || 'unknown'})`);
    }

    return {
      buffer,
      contentType,
      finalUrl: response.url(),
      method: 'playwright',
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

function uniqueList(items) {
  const out = [];
  for (const item of items) {
    if (item && !out.includes(item)) out.push(item);
  }
  return out;
}

function looksLikeImageBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return true;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true;
  const head = buffer.subarray(0, 64).toString('utf8').toLowerCase();
  if (head.includes('<svg')) return true;
  if (head.startsWith('gif87a') || head.startsWith('gif89a')) return true;
  if (head.startsWith('bm')) return true;
  if (head.startsWith('riff') && head.includes('webp')) return true;
  return false;
}

module.exports = { downloadImage };

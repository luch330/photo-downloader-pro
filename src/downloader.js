const { Buffer } = require('buffer');
const { normalizeImage } = require('./imageProcessor');

let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch {
  chromium = null;
}

const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_RETRIES = 2;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ACCEPT =
  'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
const LANG = 'en-US,en;q=0.9,bg;q=0.8';

async function downloadImage(url, options = {}) {
  const inputUrl = String(url || '').trim();
  if (!inputUrl) {
    throw new Error('empty url');
  }

  const referer = String(options.referer || '').trim();
  const timeoutMs = clampInt(options.timeoutMs, 3000, 180000, DEFAULT_TIMEOUT_MS);
  const retries = clampInt(options.retries, 0, 5, DEFAULT_RETRIES);
  const browserFallback = options.browserFallback !== false;
  const maxSide = clampInt(options.maxSide, 256, 8000, 3000);
  const quality = clampInt(options.quality, 50, 100, 92);

  if (isDataUrl(inputUrl)) {
    const decoded = decodeDataUrl(inputUrl);
    const normalized = await normalizeImage(decoded.buffer, {
      contentType: decoded.contentType,
      sourceUrl: inputUrl,
      maxSide,
      quality,
    });

    return {
      buffer: normalized.buffer,
      contentType: normalized.contentType,
      finalUrl: decoded.finalUrl,
      method: normalized.method,
    };
  }

  const direct = await fetchWithRetries(inputUrl, {
    referer,
    timeoutMs,
    retries,
  });

  if (direct?.buffer && looksLikeImage(direct.buffer, direct.contentType)) {
    const normalized = await normalizeImage(direct.buffer, {
      contentType: direct.contentType,
      sourceUrl: direct.finalUrl || inputUrl,
      maxSide,
      quality,
    });

    return {
      buffer: normalized.buffer,
      contentType: normalized.contentType,
      finalUrl: direct.finalUrl,
      method: `direct-${normalized.method}`,
    };
  }

  if (direct?.bodyText && looksLikeHtml(direct.contentType, direct.bodyText)) {
    const candidates = extractImageCandidates(direct.bodyText, direct.finalUrl || inputUrl);

    for (const candidate of candidates) {
      try {
        const nested = await fetchWithRetries(candidate, {
          referer: direct.finalUrl || referer || inputUrl,
          timeoutMs,
          retries: 1,
        });

        if (nested?.buffer && looksLikeImage(nested.buffer, nested.contentType)) {
          const normalized = await normalizeImage(nested.buffer, {
            contentType: nested.contentType,
            sourceUrl: nested.finalUrl || candidate,
            maxSide,
            quality,
          });

          return {
            buffer: normalized.buffer,
            contentType: normalized.contentType,
            finalUrl: nested.finalUrl,
            method: `html-meta-${normalized.method}`,
          };
        }
      } catch {
        // keep trying other candidates
      }
    }
  }

  if (browserFallback && chromium) {
    const browserResult = await tryBrowserFallback(inputUrl, {
      referer,
      timeoutMs,
    });

    if (browserResult?.buffer && looksLikeImage(browserResult.buffer, browserResult.contentType)) {
      const normalized = await normalizeImage(browserResult.buffer, {
        contentType: browserResult.contentType,
        sourceUrl: browserResult.finalUrl || inputUrl,
        maxSide,
        quality,
      });

      return {
        buffer: normalized.buffer,
        contentType: normalized.contentType,
        finalUrl: browserResult.finalUrl,
        method: `browser-${normalized.method}`,
      };
    }
  }

  if (direct?.buffer && direct.buffer.length && looksLikeImage(direct.buffer, direct.contentType)) {
    const normalized = await normalizeImage(direct.buffer, {
      contentType: direct.contentType,
      sourceUrl: direct.finalUrl || inputUrl,
      maxSide,
      quality,
    });

    return {
      buffer: normalized.buffer,
      contentType: normalized.contentType,
      finalUrl: direct.finalUrl || inputUrl,
      method: `direct-heuristic-${normalized.method}`,
    };
  }

  const statusText = direct?.status ? `HTTP ${direct.status}` : 'unknown response';
  const ct = direct?.contentType || 'unknown content type';
  throw new Error(`unsupported or non-image response (${statusText}, ${ct})`);
}

async function fetchWithRetries(url, { referer, timeoutMs, retries }) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchOnce(url, { referer, timeoutMs });
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await sleep(250 + attempt * 250);
      }
    }
  }

  throw lastError || new Error('download failed');
}

async function fetchOnce(url, { referer, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

  try {
    const headers = {
      'User-Agent': UA,
      Accept: ACCEPT,
      'Accept-Language': LANG,
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    };

    if (referer) {
      headers.Referer = referer;
    }

    const response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type') || '';
    const finalUrl = response.url || url;
    const status = response.status;
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let bodyText = '';
    if (looksLikeTextResponse(contentType, buffer)) {
      bodyText = buffer.toString('utf8');
    }

    return {
      buffer,
      contentType,
      finalUrl,
      status,
      bodyText,
    };
  } catch (err) {
    throw new Error(normalizeError(err));
  } finally {
    clearTimeout(timer);
  }
}

async function tryBrowserFallback(url, { referer, timeoutMs }) {
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      userAgent: UA,
      locale: 'en-US',
      viewport: { width: 1400, height: 1000 },
      extraHTTPHeaders: {
        Accept: ACCEPT,
        'Accept-Language': LANG,
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    });

    const page = await context.newPage();

    if (referer) {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
        referer,
      });
    } else {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });
    }

    await page.waitForTimeout(800);

    const candidates = await page.evaluate(() => {
      const out = [];
      const push = (value) => {
        if (!value) return;
        const v = String(value).trim();
        if (!v) return;
        out.push(v);
      };

      const metaSelectors = [
        'meta[property="og:image"]',
        'meta[property="og:image:url"]',
        'meta[name="og:image"]',
        'meta[name="twitter:image"]',
        'meta[property="twitter:image"]',
        'meta[property="og:image:secure_url"]',
        'meta[name="twitter:image:src"]',
      ];

      metaSelectors.forEach((sel) => {
        document.querySelectorAll(sel).forEach((el) => {
          push(el.getAttribute('content'));
        });
      });

      document.querySelectorAll('link[rel~="image_src"]').forEach((el) => {
        push(el.getAttribute('href'));
      });

      document.querySelectorAll('img').forEach((img) => {
        push(img.currentSrc);
        push(img.src);
        push(img.getAttribute('data-src'));
        push(img.getAttribute('data-lazy-src'));
        push(img.getAttribute('data-original'));

        const srcset = img.getAttribute('srcset');
        if (srcset) {
          const parts = srcset.split(',').map((s) => s.trim().split(' ')[0]).filter(Boolean);
          parts.forEach(push);
        }
      });

      document.querySelectorAll('source').forEach((source) => {
        const srcset = source.getAttribute('srcset');
        if (srcset) {
          const parts = srcset.split(',').map((s) => s.trim().split(' ')[0]).filter(Boolean);
          parts.forEach(push);
        }
        push(source.getAttribute('src'));
      });

      document.querySelectorAll('[style]').forEach((node) => {
        const style = node.getAttribute('style') || '';
        const matches = style.match(/url\((['"]?)([^'")]+)\1\)/gi);
        if (matches) {
          matches.forEach((m) => {
            const inner = m.replace(/^url\((['"]?)/i, '').replace(/(['"]?)\)$/i, '');
            push(inner);
          });
        }
      });

      document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
        const txt = script.textContent || '';
        const matches = txt.match(/https?:\/\/[^"'\\\s>]+?\.(?:jpg|jpeg|png|webp|gif|bmp|svg|avif|heic|heif)(?:\?[^"'\\\s>]*)?/gi);
        if (matches) matches.forEach(push);
      });

      return Array.from(new Set(out));
    });

    for (const candidate of candidates) {
      try {
        const resolved = resolveUrl(candidate, page.url());
        const result = await fetchOnce(resolved, {
          referer: page.url(),
          timeoutMs,
        });

        if (result?.buffer && looksLikeImage(result.buffer, result.contentType)) {
          await browser.close();
          return {
            buffer: result.buffer,
            contentType: result.contentType,
            finalUrl: result.finalUrl,
            method: 'browser-dom',
          };
        }
      } catch {
        // continue
      }
    }

    const finalPageUrl = page.url();
    if (finalPageUrl && finalPageUrl !== url) {
      try {
        const result = await fetchOnce(finalPageUrl, {
          referer: page.url(),
          timeoutMs,
        });

        if (result?.buffer && looksLikeImage(result.buffer, result.contentType)) {
          await browser.close();
          return {
            buffer: result.buffer,
            contentType: result.contentType,
            finalUrl: result.finalUrl,
            method: 'browser-final-url',
          };
        }
      } catch {
        // ignore
      }
    }

    await browser.close();
    return null;
  } catch {
    try {
      await browser.close();
    } catch {
      // ignore
    }
    return null;
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

  const attrs = [
    /<meta[^>]+property=["']og:image(?:\:url)?["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+name=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+property=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+name=["']twitter:image(?:\:src)?["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<link[^>]+rel=["'][^"']*image_src[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>/gi,
  ];

  attrs.forEach((regex) => {
    let match;
    while ((match = regex.exec(html))) {
      add(match[1]);
    }
  });

  const srcsetRegex = /srcset=["']([^"']+)["']/gi;
  let srcsetMatch;
  while ((srcsetMatch = srcsetRegex.exec(html))) {
    const parts = String(srcsetMatch[1]).split(',').map((s) => s.trim().split(' ')[0]).filter(Boolean);
    parts.forEach(add);
  }

  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(html))) {
    add(imgMatch[1]);
  }

  const lazyAttrs = [
    /data-src=["']([^"']+)["']/gi,
    /data-lazy-src=["']([^"']+)["']/gi,
    /data-original=["']([^"']+)["']/gi,
  ];

  lazyAttrs.forEach((regex) => {
    let match;
    while ((match = regex.exec(html))) {
      add(match[1]);
    }
  });

  const bgRegex = /background-image\s*:\s*url\((['"]?)([^'")]+)\1\)/gi;
  let bgMatch;
  while ((bgMatch = bgRegex.exec(html))) {
    add(bgMatch[2]);
  }

  const urlRegex = /https?:\/\/[^"'\\\s>]+?\.(?:jpg|jpeg|png|webp|gif|bmp|svg|avif|heic|heif)(?:\?[^"'\\\s>]*)?/gi;
  let urlMatch;
  while ((urlMatch = urlRegex.exec(html))) {
    add(urlMatch[0]);
  }

  return Array.from(new Set(candidates));
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
    method: 'data-url',
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

  return ct.includes('text/html') || ct.includes('application/xhtml') || /<!doctype html|<html|<head|<meta|<body/i.test(txt);
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
  if (buffer.length >= 4 && (
    (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
    (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)
  )) return true;

  if (buffer.length >= 12) {
    const head = buffer.subarray(0, 12).toString('ascii');
    if (head.startsWith('RIFF') && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return true;
  }

  const sample = buffer.toString('utf8', 0, Math.min(buffer.length, 512)).toLowerCase();
  if (sample.includes('<svg') || (sample.includes('<?xml') && sample.includes('<svg'))) return true;

  return false;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  downloadImage,
};

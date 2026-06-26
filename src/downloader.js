const { Buffer } = require('buffer');
const { normalizeImage } = require('./imageProcessor');

const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_RETRIES = 2;
const DEFAULT_MAX_SIDE = 3000;
const DEFAULT_QUALITY = 92;

const ACCEPT_IMAGE =
  'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
const ACCEPT_DOCUMENT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';

const LANGUAGE_PROFILES = [
  'bg-BG,bg;q=0.9,en-US;q=0.8,en;q=0.7',
  'en-US,en;q=0.9,bg;q=0.8',
  'bg;q=0.9,en;q=0.8',
];

const UA_PROFILES = [
  {
    id: 'chrome',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    extraHeaders: {
      'sec-ch-ua':
        '"Chromium";v="124", "Google Chrome";v="124", "Not A(Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    },
  },
  {
    id: 'edge',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
    extraHeaders: {
      'sec-ch-ua':
        '"Chromium";v="124", "Microsoft Edge";v="124", "Not A(Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    },
  },
  {
    id: 'safari',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    extraHeaders: {},
  },
  {
    id: 'firefox',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0',
    extraHeaders: {},
  },
];

async function downloadImage(url, options = {}) {
  const inputUrl = String(url || '').trim();
  if (!inputUrl) {
    throw new Error('empty url');
  }

  const referer = String(options.referer || '').trim();
  const timeoutMs = clampInt(options.timeoutMs, 3000, 180000, DEFAULT_TIMEOUT_MS);
  const retries = clampInt(options.retries, 0, 5, DEFAULT_RETRIES);
  const maxSide = clampInt(options.maxSide, 256, 8000, DEFAULT_MAX_SIDE);
  const quality = clampInt(options.quality, 50, 100, DEFAULT_QUALITY);

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
      method: `data-url-${normalized.method}`,
    };
  }

  const refererVariants = buildRefererVariants(inputUrl, referer);
  const profiles = buildRequestProfiles();

  let lastError = null;

  for (const profile of profiles) {
    for (const ref of refererVariants) {
      try {
        const result = await fetchAndInspect(inputUrl, {
          profile,
          referer: ref,
          timeoutMs,
          retries,
          maxSide,
          quality,
          depth: 0,
          visited: new Set(),
        });

        if (result) {
          return result;
        }
      } catch (err) {
        lastError = err;
      }
    }
  }

  const statusText = lastError?.message || 'unknown response';
  throw new Error(`unsupported or non-image response (${statusText})`);
}

function buildRequestProfiles() {
  return UA_PROFILES.map((profile, index) => ({
    ...profile,
    acceptLanguage: LANGUAGE_PROFILES[index % LANGUAGE_PROFILES.length],
  }));
}

function buildRefererVariants(inputUrl, referer) {
  const out = [];

  const push = (value) => {
    const v = String(value || '').trim();
    if (!v) return;
    if (!out.includes(v)) out.push(v);
  };

  push(referer);
  push(getOrigin(referer));
  push(getOrigin(inputUrl));
  push('');

  return out;
}

async function fetchAndInspect(url, context) {
  const resource = await fetchWithRetries(url, {
    profile: context.profile,
    referer: context.referer,
    timeoutMs: context.timeoutMs,
    retries: context.retries,
  });

  return inspectResource(resource, {
    ...context,
    url,
  });
}

async function fetchWithRetries(url, { profile, referer, timeoutMs, retries }) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchOnce(url, { profile, referer, timeoutMs });
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await sleep(250 + attempt * 250);
      }
    }
  }

  throw lastError || new Error('download failed');
}

async function fetchOnce(url, { profile, referer, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

  try {
    const headers = {
      'User-Agent': profile.userAgent,
      Accept: ACCEPT_IMAGE,
      'Accept-Language': profile.acceptLanguage,
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      DNT: '1',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Site': getSecFetchSite(url, referer),
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Dest': 'image',
      ...profile.extraHeaders,
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
      headers: response.headers,
    };
  } catch (err) {
    throw new Error(normalizeError(err));
  } finally {
    clearTimeout(timer);
  }
}
async function inspectResource(resource, context) {
  if (!resource) return null;

  const fingerprint = [
    context.url || '',
    resource.finalUrl || '',
    resource.status || '',
    context.referer || '',
    context.profile?.id || '',
  ].join('|');

  if (context.visited?.has(fingerprint)) {
    return null;
  }
  if (context.visited) {
    context.visited.add(fingerprint);
  }

  if (resource.buffer && looksLikeImage(resource.buffer, resource.contentType)) {
    const normalized = await normalizeImage(resource.buffer, {
      contentType: resource.contentType,
      sourceUrl: resource.finalUrl || context.url,
      maxSide: context.maxSide,
      quality: context.quality,
    });

    return {
      buffer: normalized.buffer,
      contentType: normalized.contentType,
      finalUrl: resource.finalUrl || context.url,
      method: `${context.profile.id}-${normalized.method}`,
    };
  }

  const canParseHtml =
    looksLikeHtml(resource.contentType, resource.bodyText) ||
    (resource.bodyText && resource.bodyText.length > 0 && resource.status >= 400);

  if (!canParseHtml) {
    return null;
  }

  const pageUrl = resource.finalUrl || context.url;
  const candidates = extractImageCandidates(resource.bodyText || '', pageUrl);

  if (!candidates.length) {
    return null;
  }

  const candidateReferers = buildCandidateReferers(pageUrl, context.referer);

  for (const candidate of candidates) {
    for (const ref of candidateReferers) {
      const candidateKey = `${candidate}|${ref}|${context.profile.id}`;
      if (context.visited?.has(candidateKey)) {
        continue;
      }
      if (context.visited) {
        context.visited.add(candidateKey);
      }

      try {
        const next = await fetchWithRetries(candidate, {
          profile: context.profile,
          referer: ref,
          timeoutMs: context.timeoutMs,
          retries: 1,
        });

        const result = await inspectResource(next, {
          ...context,
          url: candidate,
          referer: ref,
          depth: (context.depth || 0) + 1,
        });

        if (result) {
          return result;
        }
      } catch {
        // keep trying
      }
    }
  }

  return null;
}

function buildCandidateReferers(pageUrl, originalReferer) {
  const out = [];
  const push = (value) => {
    const v = String(value || '').trim();
    if (!v) return;
    if (!out.includes(v)) out.push(v);
  };

  push(pageUrl);
  push(originalReferer);
  push(getOrigin(pageUrl));
  push('');

  return out;
}

function extractImageCandidates(html, baseUrl) {
  const candidates = [];
  const add = (value) => {
    if (!value) return;
    const v = String(value).trim();
    if (!v) return;
    candidates.push(resolveUrl(v, baseUrl));
  };

  const attrRegexes = [
    /<meta[^>]+property=["']og:image(?:\:url)?["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+name=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+property=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+name=["']twitter:image(?:\:src)?["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<link[^>]+rel=["'][^"']*image_src[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>/gi,
  ];

  attrRegexes.forEach((regex) => {
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
  ];

  lazyRegexes.forEach((regex) => {
    let match;
    while ((match = regex.exec(html))) {
      add(match[1]);
    }
  });

  const srcsetRegex = /srcset=["']([^"']+)["']/gi;
  let srcsetMatch;
  while ((srcsetMatch = srcsetRegex.exec(html))) {
    const parts = String(srcsetMatch[1])
      .split(',')
      .map((s) => s.trim().split(' ')[0])
      .filter(Boolean);
    parts.forEach(add);
  }

  const sourceRegex = /<source[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let sourceMatch;
  while ((sourceMatch = sourceRegex.exec(html))) {
    add(sourceMatch[1]);
  }

  const bgRegex = /background-image\s*:\s*url\((['"]?)([^'")]+)\1\)/gi;
  let bgMatch;
  while ((bgMatch = bgRegex.exec(html))) {
    add(bgMatch[2]);
  }

  const urlRegex = /https?:\/\/[^"'\\\s>]+?\.(?:jpg|jpeg|png|webp|gif|bmp|svg|avif|heic|heif|tiff?)(?:\?[^"'\\\s>]*)?/gi;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  downloadImage,
};

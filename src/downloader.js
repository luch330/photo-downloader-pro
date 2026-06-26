const { Buffer } = require('buffer');
const http = require('http');
const https = require('https');
const http2 = require('http2');
const zlib = require('zlib');

const { normalizeImage } = require('./imageProcessor');

const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_RETRIES = 2;
const DEFAULT_MAX_SIDE = 3000;
const DEFAULT_QUALITY = 92;
const MAX_HTML_DEPTH = 2;
const MAX_REDIRECTS = 6;

const ACCEPT_IMAGE =
  'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
const ACCEPT_DOCUMENT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ACCEPT_LANGUAGE = 'en-US,en;q=0.9,bg;q=0.8';

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

  const jar = new CookieJar();
  const refererVariants = buildRefererVariants(inputUrl, referer);

  let lastError = null;

  for (const ref of refererVariants) {
    try {
      const result = await tryDownload(inputUrl, {
        jar,
        referer: ref,
        timeoutMs,
        retries,
        maxSide,
        quality,
      });

      if (result) return result;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    `unsupported or non-image response (${lastError?.message || 'unknown response'})`
  );
}

async function tryDownload(url, { jar, referer, timeoutMs, retries, maxSide, quality }) {
  let lastResource = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const resource = await fetchWithFallbacks(url, {
        jar,
        referer,
        timeoutMs,
      });

      lastResource = resource;

      const result = await inspectResource(resource, {
        url,
        referer,
        jar,
        timeoutMs,
        maxSide,
        quality,
        depth: 0,
        visited: new Set(),
      });

      if (result) return result;
    } catch (err) {
      lastResource = { error: err };
      if (attempt < retries) {
        await sleep(250 + attempt * 250);
      }
    }
  }

  if (lastResource?.error) {
    throw lastResource.error;
  }

  return null;
}

async function inspectResource(resource, context) {
  if (!resource) return null;

  const fingerprint = [
    context.url || '',
    resource.finalUrl || '',
    resource.status || '',
    context.referer || '',
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
      method: normalized.method,
    };
  }

  const looksHtml =
    looksLikeHtml(resource.contentType, resource.bodyText) ||
    (resource.bodyText && resource.bodyText.length > 0) ||
    resource.status >= 400;

  if (!looksHtml) {
    return null;
  }

  if ((context.depth || 0) >= MAX_HTML_DEPTH) {
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
      const key = `${candidate}|${ref}`;
      if (context.visited?.has(key)) continue;
      if (context.visited) context.visited.add(key);

      try {
        const next = await fetchWithFallbacks(candidate, {
          jar: context.jar,
          referer: ref,
          timeoutMs: context.timeoutMs,
        });

        const result = await inspectResource(next, {
          ...context,
          url: candidate,
          referer: ref,
          depth: (context.depth || 0) + 1,
        });

        if (result) return result;
      } catch {
        // keep trying other candidates
      }
    }
  }

  return null;
}

async function fetchWithFallbacks(url, { jar, referer, timeoutMs }) {
  const parsed = safeUrl(url);
  if (!parsed) {
    throw new Error('invalid url');
  }

  const transports = parsed.protocol === 'https:' ? ['http2', 'http1'] : ['http1'];

  let lastErr = null;

  for (const transport of transports) {
    try {
      if (transport === 'http2') {
        return await fetchWithHttp2(parsed, { jar, referer, timeoutMs });
      }
      return await fetchWithHttp1(parsed, { jar, referer, timeoutMs });
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error('request failed');
}

async function fetchWithHttp1(parsedUrl, { jar, referer, timeoutMs }) {
  const isHttps = parsedUrl.protocol === 'https:';
  const lib = isHttps ? https : http;

  const headers = buildHeaders({
    url: parsedUrl.toString(),
    referer,
    accept: ACCEPT_IMAGE,
    jar,
    mode: 'image',
  });

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        method: 'GET',
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || undefined,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        headers,
      },
      (res) => {
        collectResponse(res, parsedUrl.toString())
          .then((result) => {
            jar.setFromResponse(result.headers['set-cookie'], parsedUrl.toString());
            resolve(result);
          })
          .catch(reject);
      }
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function fetchWithHttp2(parsedUrl, { jar, referer, timeoutMs }) {
  const headers = buildHeaders({
    url: parsedUrl.toString(),
    referer,
    accept: ACCEPT_IMAGE,
    jar,
    mode: 'image',
    http2: true,
  });

  const authority = parsedUrl.port ? `${parsedUrl.hostname}:${parsedUrl.port}` : parsedUrl.hostname;
  const client = http2.connect(parsedUrl.origin);

  return new Promise((resolve, reject) => {
    let closed = false;

    const timer = setTimeout(() => {
      closed = true;
      try {
        client.close();
      } catch {
        // ignore
      }
      reject(new Error('timeout'));
    }, timeoutMs);

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
      ':method': 'GET',
      ':path': `${parsedUrl.pathname}${parsedUrl.search}`,
      ':scheme': parsedUrl.protocol.replace(':', ''),
      ':authority': authority,
      ...headers,
    });

    const chunks = [];
    let responseHeaders = {};
    let status = 0;

    req.on('response', (hdrs) => {
      responseHeaders = normalizeHeaders(hdrs);
      status = Number(responseHeaders[':status'] || hdrs[':status'] || 0);
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

      if (closed) return;

      const rawBody = Buffer.concat(chunks);
      const body = decodeEncodedBody(rawBody, responseHeaders['content-encoding']);
      const contentType = responseHeaders['content-type'] || '';
      const bodyText = looksLikeTextResponse(contentType, body)
        ? body.toString('utf8')
        : '';

      jar.setFromResponse(responseHeaders['set-cookie'], parsedUrl.toString());

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
  const chunks = [];
  for await (const chunk of res) {
    chunks.push(Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks);
  const headers = normalizeHeaders(res.headers || {});
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

function buildHeaders({ url, referer, accept, jar, mode, http2 }) {
  const origin = getOrigin(referer) || getOrigin(url);
  const headers = {
    'user-agent': USER_AGENT,
    accept,
    'accept-language': ACCEPT_LANGUAGE,
    'accept-encoding': 'gzip, deflate, br',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    dnt: '1',
    'upgrade-insecure-requests': mode === 'document' ? '1' : '0',
    'sec-fetch-site': getSecFetchSite(url, referer),
    'sec-fetch-mode': mode === 'document' ? 'navigate' : 'no-cors',
    'sec-fetch-dest': mode === 'document' ? 'document' : 'image',
  };

  if (referer) {
    headers.referer = referer;
    if (origin) headers.origin = origin;
  }

  const cookieHeader = jar?.getHeader(url);
  if (cookieHeader) {
    headers.cookie = cookieHeader;
  }

  if (!http2) {
    headers.connection = 'keep-alive';
  }

  return headers;
}

function buildRefererVariants(inputUrl, referer) {
  const out = [];
  const push = (value) => {
    const v = String(value || '').trim();
    if (!v) return;
    if (!out.includes(v)) out.push(v);
  };

  [referer, getOrigin(referer), getOrigin(inputUrl), ''].forEach((v) => {
    push(v);
    alternateOriginVariants(v).forEach(push);
  });

  return out;
}

function alternateOriginVariants(value) {
  const origin = getOrigin(value);
  if (!origin) return [];

  try {
    const u = new URL(origin);
    const host = u.hostname;

    if (host.startsWith('www.')) {
      u.hostname = host.replace(/^www\./, '');
      return [u.origin];
    }

    u.hostname = `www.${host}`;
    return [u.origin];
  } catch {
    return [];
  }
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

  const regexes = [
    /<meta[^>]+property=["']og:image(?:\:url)?["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+name=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+property=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+name=["']twitter:image(?:\:src)?["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<link[^>]+rel=["'][^"']*image_src[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>/gi,
  ];

  regexes.forEach((regex) => {
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
    extractUrlsFromJsonLd(block, baseUrl).forEach(add);
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
    walk(JSON.parse(block));
  } catch {
    const matches = String(block).match(/https?:\/\/[^"'\\\s>]+?\.(?:jpg|jpeg|png|webp|gif|bmp|svg|avif|heic|heif|tiff?)(?:\?[^"'\\\s>]*)?/gi);
    if (matches) matches.forEach(push);
  }

  return out;
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

function normalizeHeaders(headers) {
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

function safeUrl(value) {
  try {
    return new URL(String(value || ''));
  } catch {
    return null;
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(Number(status));
}

function alternateOriginVariants(value) {
  const origin = getOrigin(value);
  if (!origin) return [];

  try {
    const u = new URL(origin);
    const host = u.hostname;

    if (host.startsWith('www.')) {
      u.hostname = host.replace(/^www\./, '');
      return [u.origin];
    }

    u.hostname = `www.${host}`;
    return [u.origin];
  } catch {
    return [];
  }
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

function buildHeadersForCookieAwareRequest(url, referer, jar, mode) {
  const origin = getOrigin(referer) || getOrigin(url);
  const headers = {
    'user-agent': USER_AGENT,
    accept: mode === 'document' ? ACCEPT_DOCUMENT : ACCEPT_IMAGE,
    'accept-language': ACCEPT_LANGUAGE,
    'accept-encoding': 'gzip, deflate, br',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    dnt: '1',
    'upgrade-insecure-requests': mode === 'document' ? '1' : '0',
    'sec-fetch-site': getSecFetchSite(url, referer),
    'sec-fetch-mode': mode === 'document' ? 'navigate' : 'no-cors',
    'sec-fetch-dest': mode === 'document' ? 'document' : 'image',
  };

  if (referer) {
    headers.referer = referer;
    if (origin) headers.origin = origin;
  }

  const cookieHeader = jar?.getHeader(url);
  if (cookieHeader) {
    headers.cookie = cookieHeader;
  }

  return headers;
}

function domainMatches(host, domain, hostOnly) {
  const h = String(host || '').toLowerCase();
  const d = String(domain || '').toLowerCase();
  if (!h || !d) return false;

  if (hostOnly) return h === d;
  return h === d || h.endsWith(`.${d}`);
}

function safeHostname(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
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
      if (Number.isFinite(expires)) cookie.expires = expires;
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

module.exports = {
  downloadImage,
};

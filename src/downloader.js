const { Buffer } = require('buffer');
const http = require('http');
const https = require('https');
const http2 = require('http2');
const zlib = require('zlib');

const { normalizeImage } = require('./imageProcessor');
const {
  discoverMainImageCandidates: discoverIntelligentImageCandidates,
  selectMainImageCandidate,
  scoreCandidate: scoreIntelligentImageCandidate,
} = require('./imageCandidateSelector');
const { parseSrcsetDetailed } = require('./imageCandidateExtractor');
const { sharedMerchantLearningEngine } = require('./merchantLearningEngine');

const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_RETRIES = 2;
const DEFAULT_MAX_SIDE = 3000;
const DEFAULT_QUALITY = 92;
const DEFAULT_MAX_BYTES = 96 * 1024 * 1024;
const MAX_HTML_DEPTH = 2;
const MAX_HTML_CANDIDATES = 40;
const MAX_REDIRECTS = 12;
const HTTP2_IDLE_MS = 10000;
const MAX_COOKIES = 500;
const MAX_COOKIES_PER_DOMAIN = 80;

const ACCEPT_IMAGE =
  'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
const ACCEPT_DOCUMENT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
const ACCEPT_ANY = '*/*';
const ACCEPT_LANGUAGE = 'en-US,en;q=0.9,bg;q=0.8';

const IMAGE_URL_RE =
  /\.(?:jpe?g|png|gif|bmp|webp|svg|avif|heic|heif|tiff?|ico)(?:[?#]|$)/i;

const META_IMAGE_KEYS = new Set([
  'og:image',
  'og:image:url',
  'og:image:secure_url',
  'twitter:image',
  'twitter:image:src',
  'twitter:image:url',
  'thumbnail',
  'thumbnailurl',
  'msapplication-tileimage',
  'image',
]);

const LAZY_IMAGE_ATTRIBUTES = [
  'src',
  'href',
  'data-src',
  'data-lazy-src',
  'data-original',
  'data-full',
  'data-full-src',
  'data-large_image',
  'data-large-file',
  'data-medium-file',
  'data-orig-file',
  'data-zoom-image',
  'data-image',
  'data-image-src',
  'data-hires',
  'data-thumb',
  'data-thumbnail',
  'data-bg',
  'data-bg-src',
  'data-background',
  'data-background-image',
  'data-pin-media',
  'poster',
];

const SRCSET_ATTRIBUTES = [
  'srcset',
  'data-srcset',
  'data-lazy-srcset',
  'data-bgset',
  'imagesrcset',
];

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 16,
  scheduling: 'lifo',
  timeout: 60000,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 16,
  scheduling: 'lifo',
  timeout: 60000,
});

const http2Sessions = new Map();
let sharedCookieJar;
let browserRotationSeed = 0;

const BROWSER_PROFILES = [
  {
    id: 'chrome',
    label: 'Chrome',
    family: 'chromium',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    secChUa: '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
    secChUaMobile: '?0',
    secChUaPlatform: '"Windows"',
  },
  {
    id: 'firefox',
    label: 'Firefox',
    family: 'firefox',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0',
  },
  {
    id: 'edge',
    label: 'Edge',
    family: 'chromium',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
    secChUa: '"Not/A)Brand";v="8", "Chromium";v="126", "Microsoft Edge";v="126"',
    secChUaMobile: '?0',
    secChUaPlatform: '"Windows"',
  },
  {
    id: 'safari',
    label: 'Safari',
    family: 'safari',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  },
  {
    id: 'mobile-chrome',
    label: 'Mobile Chrome',
    family: 'chromium',
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    secChUa: '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
    secChUaMobile: '?1',
    secChUaPlatform: '"Android"',
  },
  {
    id: 'mobile-safari',
    label: 'Mobile Safari',
    family: 'safari',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  },
];

async function downloadImage(url, options = {}) {
  const inputUrl = String(url || '').trim();
  if (!inputUrl) {
    throw new Error('empty url');
  }

  const config = {
    referer: String(options.referer || '').trim(),
    timeoutMs: clampInt(options.timeoutMs, 3000, 180000, DEFAULT_TIMEOUT_MS),
    retries: clampInt(options.retries, 0, 8, DEFAULT_RETRIES),
    maxSide: clampInt(options.maxSide, 256, 8000, DEFAULT_MAX_SIDE),
    quality: clampInt(options.quality, 50, 100, DEFAULT_QUALITY),
    preserveOriginal: options.preserveOriginal === true || options.normalizeOutput === false,
    maxBytes: clampInt(options.maxBytes, 1024 * 1024, 512 * 1024 * 1024, DEFAULT_MAX_BYTES),
    browserFallback: Boolean(options.browserFallback),
    htmlImageDiscovery: Boolean(
      options.htmlImageDiscovery ||
        options.htmlMainImageDiscovery ||
        options.useHtmlMainImageExtraction
    ),
  };

  const diagnostics = createDiagnostics(inputUrl);
  const jar = options.cookieJar instanceof CookieJar ? options.cookieJar : sharedCookieJar;

  if (isDataUrl(inputUrl)) {
    return normalizeDataUrl(inputUrl, config, diagnostics);
  }

  if (!safeUrl(inputUrl)) {
    throw new Error(`invalid url: ${inputUrl}`);
  }

  const strategies = buildRetryStrategies(inputUrl, config);
  const visited = new Set();
  let lastError = null;

  for (let index = 0; index < strategies.length; index += 1) {
    const strategy = strategies[index];

    try {
      const resource = await fetchStrategy(inputUrl, {
        strategy,
        jar,
        diagnostics,
        timeoutMs: config.timeoutMs,
        maxBytes: config.maxBytes,
        htmlImageDiscovery: config.htmlImageDiscovery,
      });

      const result = await inspectResource(resource, {
        inputUrl,
        jar,
        diagnostics,
        timeoutMs: config.timeoutMs,
        maxBytes: config.maxBytes,
        maxSide: config.maxSide,
        quality: config.quality,
        preserveOriginal: config.preserveOriginal,
        visited,
        depth: 0,
        strategy,
        htmlImageDiscovery: config.htmlImageDiscovery,
        learningEngine: options.learningEngine,
      });

      if (result) {
        result.diagnostics = diagnostics;
        return result;
      }
    } catch (err) {
      lastError = err;
      recordAttempt(diagnostics, {
        retryStrategy: strategy.name,
        browser: strategy.browser.label,
        protocol: strategy.transportOrder.join('>'),
        finalUrl: inputUrl,
        elapsedMs: 0,
        cookieCount: jar.count(),
        error: err,
      });
    }

    if (index < strategies.length - 1) {
      await sleep(getRetryDelay(index, lastError));
    }
  }

  throw buildDownloadError(inputUrl, diagnostics, lastError);
}

async function normalizeDataUrl(dataUrl, config, diagnostics) {
  const decoded = decodeDataUrl(dataUrl);
  const imageInfo = detectImage(decoded.buffer, decoded.contentType, dataUrl);
  if (!imageInfo) {
    throw new Error(`data url is not a supported image (${decoded.contentType || 'unknown content type'})`);
  }

  const output = config.preserveOriginal
    ? { buffer: decoded.buffer, contentType: imageInfo.contentType, method: 'original' }
    : await normalizeImage(decoded.buffer, {
        contentType: imageInfo.contentType,
        sourceUrl: dataUrl,
        maxSide: config.maxSide,
        quality: config.quality,
      });

  recordAttempt(diagnostics, {
    retryStrategy: 'data-url',
    browser: 'n/a',
    protocol: 'data',
    status: 200,
    contentType: imageInfo.contentType,
    finalUrl: dataUrl,
    responseSize: decoded.buffer.length,
    elapsedMs: 0,
    cookieCount: 0,
  });

  return {
    buffer: output.buffer,
    contentType: output.contentType,
    finalUrl: dataUrl,
    method: `data-url:${output.method}`,
    diagnostics,
  };
}

async function fetchStrategy(url, context) {
  const { strategy, jar, diagnostics, timeoutMs, maxBytes } = context;

  if (strategy.kind === 'browser') {
    return fetchWithBrowser(url, context);
  }

  if (strategy.preflightHead) {
    try {
      await fetchResource(url, {
        strategy,
        jar,
        diagnostics,
        timeoutMs,
        maxBytes,
        method: 'HEAD',
        mode: strategy.mode,
      });
    } catch (err) {
      recordAttempt(diagnostics, {
        retryStrategy: `${strategy.name}:HEAD`,
        browser: strategy.browser.label,
        protocol: strategy.transportOrder.join('>'),
        finalUrl: url,
        elapsedMs: 0,
        cookieCount: jar.count(),
        error: err,
      });
    }
  }

  return fetchResource(url, {
    strategy,
    jar,
    diagnostics,
    timeoutMs,
    maxBytes,
    method: 'GET',
    mode: strategy.mode,
  });
}

async function fetchResource(url, context) {
  const { strategy, jar, diagnostics, timeoutMs, maxBytes, method, mode } = context;
  const parsed = safeUrl(url);
  if (!parsed) throw new Error(`invalid url: ${url}`);

  const transports = getTransports(parsed, strategy.transportOrder);
  let lastError = null;

  for (const transport of transports) {
    const startedAt = Date.now();
    const requestHeaders = buildHeaders({
      url,
      referer: strategy.referer,
      mode,
      method,
      browser: strategy.browser,
      jar,
      http2: transport === 'http2',
      accept: strategy.accept,
      headerVariant: strategy.headerVariant,
    });

    try {
      const resource = await requestWithRedirects(url, {
        method,
        mode,
        transport,
        strategy,
        jar,
        timeoutMs,
        maxBytes,
        requestHeaders,
      });

      resource.elapsedMs = Date.now() - startedAt;
      resource.retryStrategy = method === 'HEAD' ? `${strategy.name}:HEAD` : strategy.name;
      resource.browser = strategy.browser.label;
      resource.requestHeaders = requestHeaders;

      recordAttempt(diagnostics, resource);
      return resource;
    } catch (err) {
      lastError = err;
      recordAttempt(diagnostics, {
        retryStrategy: method === 'HEAD' ? `${strategy.name}:HEAD` : strategy.name,
        browser: strategy.browser.label,
        protocol: transport,
        finalUrl: url,
        elapsedMs: Date.now() - startedAt,
        cookieCount: jar.count(),
        error: err,
      });
    }
  }

  throw lastError || new Error('request failed');
}

async function requestWithRedirects(url, options) {
  let currentUrl = url;
  let currentMethod = options.method;
  let requestHeaders = options.requestHeaders;
  const redirectChain = [];

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const parsed = safeUrl(currentUrl);
    if (!parsed) throw new Error(`invalid redirected url: ${currentUrl}`);

    const effectiveTransport =
      parsed.protocol === 'https:' && options.transport === 'http2' ? 'http2' : 'http1';

    const resource =
      effectiveTransport === 'http2'
        ? await requestOnceHttp2(parsed, {
            ...options,
            method: currentMethod,
            requestHeaders,
          })
        : await requestOnceHttp1(parsed, {
            ...options,
            method: currentMethod,
            requestHeaders,
          });

    resource.redirectChain = redirectChain.slice();
    resource.startUrl = url;

    const setCookie = resource.headers['set-cookie'];
    jarSetFromResponse(options.jar, setCookie, currentUrl);

    const location = firstHeader(resource.headers.location);
    if (isRedirectStatus(resource.status) && location) {
      const nextUrl = resolveUrl(location, currentUrl);
      redirectChain.push({
        status: resource.status,
        from: currentUrl,
        to: nextUrl,
      });

      currentUrl = nextUrl;
      currentMethod = getRedirectMethod(currentMethod, resource.status);
      const nextTransport = nextUrl.startsWith('https:') && options.transport === 'http2' ? 'http2' : 'http1';
      requestHeaders = buildHeaders({
        url: currentUrl,
        referer: options.strategy.referer,
        mode: options.mode,
        method: currentMethod,
        browser: options.strategy.browser,
        jar: options.jar,
        http2: nextTransport === 'http2',
        accept: options.strategy.accept,
        headerVariant: options.strategy.headerVariant,
      });
      continue;
    }

    resource.redirectChain = redirectChain.slice();
    resource.finalUrl = currentUrl;
    resource.cookieCount = options.jar.count();
    return resource;
  }

  throw new Error(`too many redirects (${MAX_REDIRECTS})`);
}

async function requestOnceHttp1(parsedUrl, options) {
  const isHttps = parsedUrl.protocol === 'https:';
  const lib = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    const req = lib.request(
      {
        method: options.method,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || undefined,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        headers: options.requestHeaders,
        agent: isHttps ? httpsAgent : httpAgent,
      },
      async (res) => {
        try {
          const resource = await collectResponseBody(res, {
            method: options.method,
            maxBytes: options.maxBytes,
          });

          if (settled) return;
          settled = true;
          resolve({
            ...resource,
            finalUrl: parsedUrl.toString(),
            protocol: `http/${res.httpVersion || '1.1'}`,
          });
        } catch (err) {
          if (settled) return;
          settled = true;
          reject(err);
        }
      }
    );

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    req.on('socket', (socket) => {
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 60000);
      socket.setTimeout(options.timeoutMs);
    });

    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new Error(`timeout after ${options.timeoutMs}ms`));
    });

    req.end();
  });
}

async function requestOnceHttp2(parsedUrl, options) {
  const authority = parsedUrl.port ? `${parsedUrl.hostname}:${parsedUrl.port}` : parsedUrl.hostname;
  const session = getHttp2Session(parsedUrl.origin);
  retainHttp2Session(session);

  return new Promise((resolve, reject) => {
    let settled = false;
    let responseHeaders = {};
    let status = 0;
    const chunks = [];
    let rawBytes = 0;
    let streamError = null;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        req.close(http2.constants.NGHTTP2_CANCEL);
      } catch {
        // ignore close races
      }
      releaseHttp2Session(session);
      reject(new Error(`timeout after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    let req;
    try {
      req = session.client.request({
        ':method': options.method,
        ':path': `${parsedUrl.pathname}${parsedUrl.search}`,
        ':scheme': parsedUrl.protocol.replace(':', ''),
        ':authority': authority,
        ...options.requestHeaders,
      });
    } catch (err) {
      settled = true;
      clearTimeout(timer);
      releaseHttp2Session(session);
      reject(err);
      return;
    }

    req.on('response', (headers) => {
      responseHeaders = normalizeHeaders(headers);
      status = Number(responseHeaders[':status'] || headers[':status'] || 0);
    });

    req.on('data', (chunk) => {
      rawBytes += chunk.length;
      if (rawBytes > options.maxBytes) {
        streamError = new Error(`response too large (${formatBytes(rawBytes)})`);
        req.close(http2.constants.NGHTTP2_CANCEL);
        return;
      }
      chunks.push(Buffer.from(chunk));
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      releaseHttp2Session(session);

      try {
        if (streamError) {
          throw streamError;
        }

        const rawBody = options.method === 'HEAD' ? Buffer.alloc(0) : Buffer.concat(chunks);
        if (rawBytes > options.maxBytes) {
          throw new Error(`response too large (${formatBytes(rawBytes)})`);
        }

        const body = decodeEncodedBody(rawBody, responseHeaders['content-encoding'], options.maxBytes);
        const contentType = firstHeader(responseHeaders['content-type']) || '';
        const bodyText = looksLikeTextResponse(contentType, body) ? decodeText(body) : '';

        resolve({
          status,
          headers: responseHeaders,
          buffer: body,
          rawSize: rawBody.length,
          responseSize: body.length,
          contentType,
          bodyText,
          finalUrl: parsedUrl.toString(),
          protocol: 'http/2',
        });
      } catch (err) {
        reject(err);
      }
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      releaseHttp2Session(session);
      reject(err);
    });

    req.on('close', () => {
      if (settled || !streamError) return;
      settled = true;
      clearTimeout(timer);
      releaseHttp2Session(session);
      reject(streamError);
    });

    if (typeof req.setTimeout === 'function') {
      req.setTimeout(options.timeoutMs, () => {
        if (settled) return;
        streamError = new Error(`timeout after ${options.timeoutMs}ms`);
        req.close(http2.constants.NGHTTP2_CANCEL);
      });
    }

    req.end();
  });
}

async function collectResponseBody(res, options) {
  const headers = normalizeHeaders(res.headers || {});
  const status = Number(res.statusCode || headers[':status'] || 0);
  const rawBody = options.method === 'HEAD' ? Buffer.alloc(0) : await collectRaw(res, options.maxBytes);
  const body = decodeEncodedBody(rawBody, headers['content-encoding'], options.maxBytes);
  const contentType = firstHeader(headers['content-type']) || '';
  const bodyText = looksLikeTextResponse(contentType, body) ? decodeText(body) : '';

  return {
    status,
    headers,
    buffer: body,
    rawSize: rawBody.length,
    responseSize: body.length,
    contentType,
    bodyText,
  };
}

async function collectRaw(stream, maxBytes) {
  const chunks = [];
  let total = 0;

  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error(`response too large (${formatBytes(total)})`);
    }
    chunks.push(Buffer.from(chunk));
  }

  return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
}

function decodeEncodedBody(buffer, encoding, maxBytes = DEFAULT_MAX_BYTES) {
  const enc = String(encoding || '').toLowerCase().trim();
  if (!buffer || !buffer.length || !enc) {
    return buffer || Buffer.alloc(0);
  }

  let decoded = buffer;
  try {
    if (enc.includes('br') && zlib.brotliDecompressSync) {
      decoded = zlib.brotliDecompressSync(buffer);
    } else if (enc.includes('gzip')) {
      decoded = zlib.gunzipSync(buffer);
    } else if (enc.includes('deflate')) {
      try {
        decoded = zlib.inflateSync(buffer);
      } catch {
        decoded = zlib.inflateRawSync(buffer);
      }
    }
  } catch (err) {
    throw new Error(`failed to decode ${enc}: ${err.message}`);
  }

  if (decoded.length > maxBytes) {
    throw new Error(`decoded response too large (${formatBytes(decoded.length)})`);
  }

  return decoded;
}

async function inspectResource(resource, context) {
  if (!resource) return null;

  context.diagnostics.lastResource = summarizeResource(resource);

  const fingerprint = [
    resource.finalUrl || context.inputUrl || '',
    resource.status || '',
    resource.retryStrategy || '',
    resource.browser || '',
  ].join('|');

  if (context.visited.has(fingerprint)) {
    return null;
  }
  context.visited.add(fingerprint);

  const imageInfo = detectImage(resource.buffer, resource.contentType, resource.finalUrl);
  if (imageInfo && isUsableImageStatus(resource.status)) {
    if (context.preserveOriginal) {
      return {
        buffer: resource.buffer,
        contentType: imageInfo.contentType,
        finalUrl: resource.finalUrl || context.inputUrl,
        method: `original:${resource.protocol || 'unknown'}:${resource.browser || 'browser'}`,
      };
    }

    const normalized = await normalizeImage(resource.buffer, {
      contentType: imageInfo.contentType,
      sourceUrl: resource.finalUrl || context.inputUrl,
      maxSide: context.maxSide,
      quality: context.quality,
    });

    return {
      buffer: normalized.buffer,
      contentType: normalized.contentType,
      finalUrl: resource.finalUrl || context.inputUrl,
      method: `${normalized.method}:${resource.protocol || 'unknown'}:${resource.browser || 'browser'}`,
    };
  }

  const htmlText = getHtmlText(resource);
  if (!htmlText || (context.depth || 0) >= MAX_HTML_DEPTH) {
    return null;
  }

  const pageUrl = resource.finalUrl || context.inputUrl;
  const learningEngine = context.learningEngine === undefined
    ? sharedMerchantLearningEngine
    : context.learningEngine;
  const selection = context.htmlImageDiscovery
    ? selectMainImageCandidate(htmlText, pageUrl, {
        rendered: resource.protocol === 'browser',
        learningEngine,
      })
    : null;
  const mainCandidates = selection?.candidates || [];
  const candidates = context.htmlImageDiscovery
    ? mainCandidates.slice(0, MAX_HTML_CANDIDATES)
    : extractImageCandidates(htmlText, pageUrl).slice(0, MAX_HTML_CANDIDATES);
  context.diagnostics.htmlRecoveries.push({
    pageUrl,
    status: resource.status,
    candidateCount: candidates.length,
    mode: context.htmlImageDiscovery ? 'main-image-scoring' : 'legacy',
    selectedCandidate: context.htmlImageDiscovery && selection?.selected
      ? {
          url: selection.selected.url,
          score: selection.selected.score,
          source: selection.selected.source,
          confidence: selection.selected.confidence,
          confidenceLabel: selection.selected.confidenceLabel,
          reasons: selection.selected.reasons,
          learning: selection.selected.learning || null,
        }
      : null,
    rankingDebug: selection?.debug || null,
    preview: htmlText.slice(0, 500),
  });

  if (!candidates.length) {
    return null;
  }

  for (const candidateEntry of candidates) {
    const candidate = typeof candidateEntry === 'string' ? candidateEntry : candidateEntry?.url;
    if (!candidate || context.visited.has(candidate)) continue;
    context.visited.add(candidate);

    const candidateStrategies = buildCandidateStrategies(pageUrl, context.strategy, context.diagnostics.inputUrl);

    for (const strategy of candidateStrategies) {
      try {
        const next = await fetchStrategy(candidate, {
          strategy,
          jar: context.jar,
          diagnostics: context.diagnostics,
          timeoutMs: context.timeoutMs,
            maxBytes: context.maxBytes,
            htmlImageDiscovery: context.htmlImageDiscovery,
          });

        const result = await inspectResource(next, {
          ...context,
          inputUrl: candidate,
          strategy,
          depth: (context.depth || 0) + 1,
          htmlImageDiscovery: context.htmlImageDiscovery,
          learningEngine,
        });

        if (result) {
          if (context.htmlImageDiscovery && learningEngine && typeof candidateEntry === 'object') {
            learningEngine.recordSuccess(pageUrl, candidateEntry, {
              confidence: candidateEntry.confidence,
              confidenceLabel: candidateEntry.confidenceLabel,
            });
            result.intelligence = {
              selectedUrl: candidateEntry.url,
              confidence: candidateEntry.confidence,
              confidenceLabel: candidateEntry.confidenceLabel,
              reasons: candidateEntry.reasons || [],
              learning: candidateEntry.learning || null,
              attemptedCandidates: candidates.length,
            };
          }
          return result;
        }
      } catch (err) {
        recordAttempt(context.diagnostics, {
          retryStrategy: strategy.name,
          browser: strategy.browser.label,
          protocol: strategy.transportOrder.join('>'),
          finalUrl: candidate,
          elapsedMs: 0,
          cookieCount: context.jar.count(),
          error: err,
        });
      }
    }
  }

  return null;
}

async function fetchWithBrowser(url, context) {
  const { strategy, jar, diagnostics, timeoutMs, maxBytes, htmlImageDiscovery } = context;
  const startedAt = Date.now();
  let chromium;

  try {
    ({ chromium } = require('playwright'));
  } catch (err) {
    throw new Error(`browser fallback unavailable: ${err.message}`);
  }

  let browser;
  let browserContext;

  try {
    browser = await getSharedBrowser(chromium);
    browserContext = await browser.newContext({
      userAgent: strategy.browser.userAgent,
      extraHTTPHeaders: buildBrowserExtraHeaders(url, strategy),
      ignoreHTTPSErrors: true,
      javaScriptEnabled: true,
      viewport: strategy.browser.id.startsWith('mobile')
        ? { width: 390, height: 844 }
        : { width: 1440, height: 960 },
      isMobile: strategy.browser.id.startsWith('mobile'),
      hasTouch: strategy.browser.id.startsWith('mobile'),
    });

    const cookies = jar.toPlaywrightCookies(url);
    if (cookies.length) {
      await browserContext.addCookies(cookies);
    }

    const page = await browserContext.newPage();
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });

    if (!response) {
      throw new Error('browser fallback produced no response');
    }

    let body = await response.body();
    if (body.length > maxBytes) {
      throw new Error(`response too large (${formatBytes(body.length)})`);
    }

    const headers = normalizeHeaders(response.headers());
    const contentType = firstHeader(headers['content-type']) || '';
    let bodyText = looksLikeTextResponse(contentType, body) ? decodeText(body) : '';

    if (htmlImageDiscovery && looksLikeHtml(contentType, body)) {
      await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 5000) }).catch(() => {});
      const renderedHtml = await page.content().catch(() => '');
      if (renderedHtml) {
        const renderedBody = Buffer.from(renderedHtml, 'utf8');
        if (renderedBody.length <= maxBytes) {
          body = renderedBody;
          bodyText = renderedHtml;
        }
      }
    }

    const browserCookies = await browserContext.cookies();
    jar.setFromPlaywrightCookies(browserCookies);

    const resource = {
      status: response.status(),
      headers,
      buffer: body,
      rawSize: body.length,
      responseSize: body.length,
      contentType,
      bodyText,
      finalUrl: response.url(),
      startUrl: url,
      redirectChain: await getBrowserRedirectChain(response),
      protocol: 'browser',
      retryStrategy: strategy.name,
      browser: strategy.browser.label,
      elapsedMs: Date.now() - startedAt,
      cookieCount: jar.count(),
      requestHeaders: buildBrowserExtraHeaders(url, strategy),
    };

    recordAttempt(diagnostics, resource);
    return resource;
  } finally {
    if (browserContext) {
      await browserContext.close().catch(() => {});
    }
  }
}

let sharedBrowserPromise = null;

function getSharedBrowser(chromium) {
  if (!sharedBrowserPromise) {
    sharedBrowserPromise = chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ],
    })
      .then((browser) => {
        browser.on?.('disconnected', () => {
          sharedBrowserPromise = null;
        });
        return browser;
      })
      .catch((err) => {
        sharedBrowserPromise = null;
        throw err;
      });
  }

  return sharedBrowserPromise.then((browser) => {
    if (typeof browser.isConnected === 'function' && !browser.isConnected()) {
      sharedBrowserPromise = null;
      return getSharedBrowser(chromium);
    }
    return browser;
  });
}

async function getBrowserRedirectChain(response) {
  const chain = [];
  let request = response.request();

  while (request?.redirectedFrom()) {
    const previous = request.redirectedFrom();
    const previousResponse = await previous.response().catch(() => null);
    chain.unshift({
      status: previousResponse?.status() || 0,
      from: previous.url(),
      to: request.url(),
    });
    request = previous;
  }

  return chain;
}

function buildRetryStrategies(inputUrl, config) {
  const referers = buildRefererVariants(inputUrl, config.referer);
  const profiles = rotateBrowserProfiles(inputUrl);
  const sameOrigin = getOrigin(inputUrl);
  const providedReferer = referers[0] || '';
  const sameOriginReferer = sameOrigin || providedReferer;
  const base = [
    {
      name: 'GET image with referer',
      mode: 'image',
      accept: ACCEPT_IMAGE,
      referer: providedReferer || sameOriginReferer,
      browser: profiles[0],
      transportOrder: ['http2', 'http1'],
    },
    {
      name: 'GET image without referer',
      mode: 'image',
      accept: ACCEPT_IMAGE,
      referer: '',
      browser: profiles[1],
      transportOrder: ['http2', 'http1'],
      headerVariant: 'minimal-origin',
    },
    {
      name: 'GET image same-origin referer',
      mode: 'image',
      accept: ACCEPT_IMAGE,
      referer: sameOriginReferer,
      browser: profiles[2],
      transportOrder: ['http2', 'http1'],
    },
    {
      name: 'HEAD preflight then GET',
      mode: 'image',
      accept: ACCEPT_IMAGE,
      referer: providedReferer || sameOriginReferer,
      browser: profiles[3],
      transportOrder: ['http2', 'http1'],
      preflightHead: true,
    },
    {
      name: 'GET document headers',
      mode: 'document',
      accept: ACCEPT_DOCUMENT,
      referer: providedReferer || sameOriginReferer,
      browser: profiles[4],
      transportOrder: ['http2', 'http1'],
    },
    {
      name: 'GET image HTTP/1.1 forced',
      mode: 'image',
      accept: ACCEPT_IMAGE,
      referer: providedReferer || sameOriginReferer,
      browser: profiles[5],
      transportOrder: ['http1'],
    },
    {
      name: 'GET broad accept mobile',
      mode: 'image',
      accept: ACCEPT_ANY,
      referer: '',
      browser: profiles[6] || profiles[0],
      transportOrder: ['http1', 'http2'],
      headerVariant: 'broad',
    },
  ];

  for (const referer of referers) {
    if (!referer || base.some((strategy) => strategy.referer === referer)) continue;
    base.push({
      name: `GET alternate referer ${base.length}`,
      mode: 'image',
      accept: ACCEPT_IMAGE,
      referer,
      browser: profiles[base.length % profiles.length],
      transportOrder: ['http2', 'http1'],
    });
  }

  if (config.browserFallback || config.htmlImageDiscovery) {
    base.push({
      kind: 'browser',
      name: config.browserFallback ? 'Playwright browser fallback' : 'Playwright HTML discovery fallback',
      mode: 'document',
      accept: ACCEPT_DOCUMENT,
      referer: providedReferer || sameOriginReferer,
      browser: profiles[(base.length + 1) % profiles.length],
      transportOrder: ['browser'],
    });
  }

  return base;
}

function buildCandidateStrategies(pageUrl, parentStrategy, originalUrl) {
  const sameOrigin = getOrigin(pageUrl);
  const originalOrigin = getOrigin(originalUrl);
  return [
    {
      name: 'HTML candidate with page referer',
      mode: 'image',
      accept: ACCEPT_IMAGE,
      referer: pageUrl,
      browser: parentStrategy.browser || getBrowser('chrome'),
      transportOrder: ['http2', 'http1'],
    },
    {
      name: 'HTML candidate same-origin',
      mode: 'image',
      accept: ACCEPT_IMAGE,
      referer: sameOrigin || originalOrigin,
      browser: getBrowser('edge'),
      transportOrder: ['http2', 'http1'],
    },
    {
      name: 'HTML candidate without referer',
      mode: 'image',
      accept: ACCEPT_ANY,
      referer: '',
      browser: getBrowser('firefox'),
      transportOrder: ['http2', 'http1'],
      headerVariant: 'broad',
    },
  ];
}

function buildHeaders({ url, referer, mode, method, browser, jar, http2: isHttp2, accept, headerVariant }) {
  const profile = browser || getBrowser('chrome');
  const headers = {
    'user-agent': profile.userAgent,
    accept: accept || (mode === 'document' ? ACCEPT_DOCUMENT : ACCEPT_IMAGE),
    'accept-language': ACCEPT_LANGUAGE,
    'accept-encoding': 'gzip, deflate, br',
  };

  if (headerVariant !== 'broad') {
    headers['cache-control'] = 'no-cache';
    headers.pragma = 'no-cache';
  }

  if (profile.family === 'chromium') {
    headers['sec-ch-ua'] = profile.secChUa;
    headers['sec-ch-ua-mobile'] = profile.secChUaMobile;
    headers['sec-ch-ua-platform'] = profile.secChUaPlatform;
  }

  if (mode === 'document') {
    headers['upgrade-insecure-requests'] = '1';
  }

  if (profile.family !== 'firefox') {
    headers['sec-fetch-site'] = getSecFetchSite(url, referer);
    headers['sec-fetch-mode'] = mode === 'document' ? 'navigate' : 'no-cors';
    headers['sec-fetch-dest'] = mode === 'document' ? 'document' : 'image';
    if (mode === 'document') headers['sec-fetch-user'] = '?1';
  }

  if (referer) {
    headers.referer = referer;
  }

  if (method === 'HEAD') {
    headers.accept = ACCEPT_ANY;
  }

  const cookieHeader = jar?.getHeader(url);
  if (cookieHeader) {
    headers.cookie = cookieHeader;
  }

  if (!isHttp2) {
    headers.connection = 'keep-alive';
  }

  return headers;
}

function buildBrowserExtraHeaders(url, strategy) {
  const headers = buildHeaders({
    url,
    referer: strategy.referer,
    mode: strategy.mode,
    method: 'GET',
    browser: strategy.browser,
    jar: null,
    http2: false,
    accept: strategy.accept,
    headerVariant: strategy.headerVariant,
  });

  delete headers.connection;
  delete headers.cookie;
  delete headers['user-agent'];
  return headers;
}

function getTransports(parsedUrl, transportOrder) {
  if (parsedUrl.protocol !== 'https:') return ['http1'];
  const order = Array.isArray(transportOrder) && transportOrder.length
    ? transportOrder
    : ['http2', 'http1'];
  return order.filter((transport) => transport === 'http1' || transport === 'http2');
}

function getHttp2Session(origin) {
  const existing = http2Sessions.get(origin);
  if (existing && !existing.closed && !existing.destroyed && !existing.client.destroyed) {
    return existing;
  }

  const client = http2.connect(origin);
  const session = {
    client,
    origin,
    active: 0,
    idleTimer: null,
    closed: false,
    destroyed: false,
  };

  const close = () => {
    session.closed = true;
    http2Sessions.delete(origin);
  };

  client.on('error', () => {
    session.destroyed = true;
    http2Sessions.delete(origin);
  });
  client.on('close', close);
  client.on('goaway', () => {
    session.closed = true;
    http2Sessions.delete(origin);
  });
  client.setTimeout(90000, () => {
    session.closed = true;
    http2Sessions.delete(origin);
    try {
      client.close();
    } catch {
      // ignore stale session close races
    }
  });
  if (typeof client.unref === 'function') {
    client.unref();
  }

  http2Sessions.set(origin, session);
  return session;
}

function retainHttp2Session(session) {
  session.active += 1;
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  if (typeof session.client.ref === 'function') {
    session.client.ref();
  }
}

function releaseHttp2Session(session) {
  session.active = Math.max(0, session.active - 1);
  if (session.active > 0 || session.closed || session.destroyed) return;

  if (typeof session.client.unref === 'function') {
    session.client.unref();
  }

  session.idleTimer = setTimeout(() => {
    try {
      session.client.close();
    } catch {
      // ignore idle close races
    }
  }, HTTP2_IDLE_MS);

  if (typeof session.idleTimer.unref === 'function') {
    session.idleTimer.unref();
  }
}

function detectImage(buffer, contentType, sourceUrl) {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const ct = normalizeContentType(contentType);
  const url = String(sourceUrl || '').toLowerCase();

  if (!input.length) return null;
  if (!ct.startsWith('image/') && looksLikeHtml(ct, input)) return null;

  const magic = detectImageByMagic(input);
  if (magic) return magic;

  if (ct.startsWith('image/')) {
    if (ct.includes('jpeg') || ct.includes('jpg')) return { contentType: 'image/jpeg', extension: 'jpg' };
    if (ct.includes('png')) return { contentType: 'image/png', extension: 'png' };
    if (ct.includes('gif')) return { contentType: 'image/gif', extension: 'gif' };
    if (ct.includes('bmp')) return { contentType: 'image/bmp', extension: 'bmp' };
    if (ct.includes('webp')) return { contentType: 'image/webp', extension: 'webp' };
    if (ct.includes('svg')) return { contentType: 'image/svg+xml', extension: 'svg' };
    if (ct.includes('avif')) return { contentType: 'image/avif', extension: 'avif' };
    if (ct.includes('heic')) return { contentType: 'image/heic', extension: 'heic' };
    if (ct.includes('heif')) return { contentType: 'image/heif', extension: 'heif' };
    if (ct.includes('tiff') || ct.includes('tif')) return { contentType: 'image/tiff', extension: 'tiff' };
    if (ct.includes('icon') || ct.includes('ico')) return { contentType: 'image/x-icon', extension: 'ico' };

    return { contentType: ct || 'image/*', extension: extensionFromUrl(url) || 'img' };
  }

  const ext = extensionFromUrl(url);
  if (ext && !looksLikeTextResponse(ct, input)) {
    return { contentType: contentTypeFromExtension(ext), extension: ext };
  }

  return null;
}

function detectImageByMagic(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { contentType: 'image/jpeg', extension: 'jpg' };
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return { contentType: 'image/png', extension: 'png' };
  }
  if (buffer.length >= 6) {
    const head = buffer.subarray(0, 6).toString('ascii');
    if (head === 'GIF87a' || head === 'GIF89a') {
      return { contentType: 'image/gif', extension: 'gif' };
    }
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { contentType: 'image/bmp', extension: 'bmp' };
  }
  if (
    buffer.length >= 4 &&
    ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
      (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a) ||
      (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2b && buffer[3] === 0x00))
  ) {
    return { contentType: 'image/tiff', extension: 'tiff' };
  }
  if (buffer.length >= 4 && buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) {
    return { contentType: 'image/x-icon', extension: 'ico' };
  }
  if (buffer.length >= 12) {
    const head = buffer.subarray(0, 12).toString('ascii');
    if (head.startsWith('RIFF') && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
      return { contentType: 'image/webp', extension: 'webp' };
    }
    if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
      const brands = buffer.subarray(8, Math.min(buffer.length, 64)).toString('ascii');
      if (brands.includes('avif') || brands.includes('avis')) {
        return { contentType: 'image/avif', extension: 'avif' };
      }
      if (/(heic|heix|hevc|hevx|heis|heim|hevm|hevs)/.test(brands)) {
        return { contentType: 'image/heic', extension: 'heic' };
      }
      if (/(mif1|msf1|heif|heim|heis)/.test(brands)) {
        return { contentType: 'image/heif', extension: 'heif' };
      }
    }
  }

  const sample = decodeText(buffer.subarray(0, Math.min(buffer.length, 1024))).trimStart().toLowerCase();
  if (/<svg(?:\s|>)/i.test(sample) && !/<html(?:\s|>)/i.test(sample)) {
    return { contentType: 'image/svg+xml', extension: 'svg' };
  }

  return null;
}

function getHtmlText(resource) {
  if (!resource) return '';
  if (looksLikeHtml(resource.contentType, resource.buffer)) {
    return resource.bodyText || decodeText(resource.buffer);
  }
  if (resource.bodyText && looksLikeHtml(resource.contentType, resource.bodyText)) {
    return resource.bodyText;
  }
  return '';
}

function looksLikeHtml(contentType, bufferOrText) {
  const ct = normalizeContentType(contentType);
  if (ct.includes('text/html') || ct.includes('application/xhtml')) return true;

  const txt = Buffer.isBuffer(bufferOrText)
    ? decodeText(bufferOrText.subarray(0, Math.min(bufferOrText.length, 1024))).toLowerCase()
    : String(bufferOrText || '').slice(0, 1024).toLowerCase();

  return /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]|<meta[\s>]|<title[\s>]/i.test(txt);
}

function looksLikeTextResponse(contentType, buffer) {
  const ct = normalizeContentType(contentType);
  if (ct.startsWith('text/')) return true;
  if (ct.includes('json') || ct.includes('xml') || ct.includes('javascript')) return true;
  if (!buffer || !buffer.length) return false;

  const sample = buffer.subarray(0, Math.min(buffer.length, 512));
  if (sample.includes(0x00)) return false;

  const text = decodeText(sample);
  const printable = text.replace(/[\t\r\n -~\u00a0-\uffff]/g, '').length;
  return printable / Math.max(1, text.length) < 0.08 && /[<>{}\[\]a-zA-Z]/.test(text);
}

function extractImageCandidates(html, baseUrl) {
  const candidates = [];
  const seen = new Set();

  const add = (value, source = 'html') => {
    const values = Array.isArray(value) ? value : [value];
    for (const raw of values) {
      const decoded = normalizeEscapedUrl(String(raw || '').trim());
      if (!decoded) continue;
      const resolved = resolveUrl(decoded, baseUrl);
      if (!resolved || seen.has(resolved)) continue;
      if (!isDataUrl(resolved) && !safeUrl(resolved)) continue;
      seen.add(resolved);
      candidates.push({ url: resolved, source });
    }
  };

  for (const tag of matchTags(html, 'meta')) {
    const attrs = parseAttributes(tag);
    const key = String(attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (META_IMAGE_KEYS.has(key)) {
      add(attrs.content, key);
    }
  }

  for (const tag of matchTags(html, 'link')) {
    const attrs = parseAttributes(tag);
    const rel = String(attrs.rel || '').toLowerCase();
    const as = String(attrs.as || '').toLowerCase();
    if (rel.includes('image_src') || (rel.includes('preload') && as === 'image')) {
      add(attrs.href, 'link');
      add(parseSrcset(attrs.imagesrcset || attrs.srcset), 'link-srcset');
    }
  }

  for (const tagName of ['img', 'source']) {
    for (const tag of matchTags(html, tagName)) {
      const attrs = parseAttributes(tag);
      for (const attr of LAZY_IMAGE_ATTRIBUTES) {
        add(attrs[attr], attr);
      }
      for (const attr of SRCSET_ATTRIBUTES) {
        add(parseSrcset(attrs[attr]), attr);
      }
      add(extractCssUrls(attrs.style), 'inline-style');
    }
  }

  for (const attr of LAZY_IMAGE_ATTRIBUTES) {
    const lazyAttrRegex = new RegExp(`\\s${escapeRegExp(attr)}=["']([^"']+)["']`, 'gi');
    let lazyMatch;
    while ((lazyMatch = lazyAttrRegex.exec(html))) {
      add(lazyMatch[1], attr);
    }
  }

  for (const attr of SRCSET_ATTRIBUTES) {
    const srcsetAttrRegex = new RegExp(`\\s${escapeRegExp(attr)}=["']([^"']+)["']`, 'gi');
    let srcsetMatch;
    while ((srcsetMatch = srcsetAttrRegex.exec(html))) {
      add(parseSrcset(srcsetMatch[1]), attr);
    }
  }

  add(extractCssUrls(html), 'background-image');

  for (const block of extractJsonLdBlocks(html)) {
    add(extractUrlsFromJsonLd(block, baseUrl), 'json-ld');
  }

  const urlRegex =
    /https?:\/\/[^"'\\\s>)]+?\.(?:jpe?g|png|webp|gif|bmp|svg|avif|heic|heif|tiff?|ico)(?:\?[^"'\\\s>)]*)?/gi;
  let urlMatch;
  while ((urlMatch = urlRegex.exec(html))) {
    add(urlMatch[0], 'url-regex');
  }

  return candidates
    .sort((a, b) => scoreCandidate(b, baseUrl) - scoreCandidate(a, baseUrl))
    .map((candidate) => candidate.url);
}

function scoreCandidate(candidate, baseUrl) {
  let score = 0;
  if (IMAGE_URL_RE.test(candidate.url)) score += 8;
  if (candidate.url.startsWith(getOrigin(baseUrl))) score += 3;
  if (/og:image|twitter:image|json-ld/.test(candidate.source)) score += 4;
  if (/srcset|large|full/i.test(candidate.source + candidate.url)) score += 2;
  if (/logo|icon|sprite|avatar|placeholder/i.test(candidate.url)) score -= 3;
  return score;
}

function matchTags(html, tagName) {
  const out = [];
  const regex = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  let match;
  while ((match = regex.exec(html))) {
    out.push(match[0]);
  }
  return out;
}

function parseAttributes(tag) {
  const attrs = {};
  const regex = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = regex.exec(tag))) {
    const key = String(match[1] || '').toLowerCase();
    if (!key || key.startsWith('<')) continue;
    attrs[key] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function parseSrcset(value) {
  return normalizeEscapedUrl(String(value || ''))
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function extractCssUrls(cssText) {
  const out = [];
  const regex = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^'")]+?))\s*\)/gi;
  let match;
  while ((match = regex.exec(String(cssText || '')))) {
    const value = match[1] || match[2] || match[3] || '';
    if (value && !/^data:font\//i.test(value)) out.push(value.trim());
  }
  return out;
}

function extractJsonLdBlocks(html) {
  const blocks = [];
  const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html))) {
    const text = String(match[1] || '').trim();
    if (text) blocks.push(text);
  }
  return blocks;
}

function extractUrlsFromJsonLd(block, baseUrl) {
  const out = [];
  const seen = new Set();

  const push = (value, force = false) => {
    const text = String(value || '').trim();
    if (!text) return;
    if (!force && !looksLikeImageUrl(text)) return;
    const resolved = resolveUrl(text, baseUrl);
    if (!isDataUrl(resolved) && !safeUrl(resolved)) return;
    if (!seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  };

  const walk = (node, forceImage = false) => {
    if (!node) return;
    if (typeof node === 'string') {
      push(normalizeEscapedUrl(node), forceImage);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, forceImage));
      return;
    }
    if (typeof node !== 'object') return;

    for (const [key, value] of Object.entries(node)) {
      const lower = String(key || '').toLowerCase();
      if (
        lower === 'image' ||
        lower === 'thumbnailurl' ||
        lower === 'contenturl' ||
        lower === 'src' ||
        lower === 'poster' ||
        lower.includes('image')
      ) {
        walk(value, true);
      } else if (lower === 'url' && forceImage) {
        walk(value, true);
      } else if (typeof value === 'object') {
        walk(value, forceImage);
      } else if (typeof value === 'string' && looksLikeImageUrl(value)) {
        push(normalizeEscapedUrl(value));
      }
    }
  };

  try {
    walk(JSON.parse(block));
  } catch {
    const matches = String(block).match(
      /https?:\/\/[^"'\\\s>]+?\.(?:jpe?g|png|webp|gif|bmp|svg|avif|heic|heif|tiff?|ico)(?:\?[^"'\\\s>]*)?/gi
    );
    if (matches) matches.forEach(push);
  }

  return out;
}

function buildRefererVariants(inputUrl, referer) {
  const out = [];
  const push = (value) => {
    const v = String(value || '').trim();
    if (!v || out.includes(v)) return;
    out.push(v);
  };

  [referer, getOrigin(referer), getOrigin(inputUrl), ''].forEach((value) => {
    push(value);
    alternateOriginVariants(value).forEach(push);
  });

  if (!out.length) out.push('');
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

function buildDownloadError(inputUrl, diagnostics, cause) {
  const last = diagnostics.lastResource || lastResponseAttempt(diagnostics) || {};
  const attempts = diagnostics.attempts.slice(-10).map(formatAttempt).join(' || ') || 'none';
  const redirectChain = formatRedirectChain(last.redirectChain);
  const htmlPreview = last.htmlPreview || getLastHtmlPreview(diagnostics);

  const lines = [
    `image download failed for ${inputUrl}`,
    `HTTP Status: ${last.status || 'n/a'}`,
    `Content-Type: ${last.contentType || 'n/a'}`,
    `Final URL: ${last.finalUrl || inputUrl}`,
    `Redirect Chain: ${redirectChain}`,
    `Headers: ${formatHeaders(last.headers)}`,
    `Response size: ${formatBytes(last.responseSize || 0)}`,
    `Retry strategy: ${last.retryStrategy || 'n/a'}`,
    `Elapsed time: ${formatDuration(last.elapsedMs || diagnostics.elapsedMs())}`,
    `Browser used: ${last.browser || 'n/a'}`,
    `Protocol used: ${last.protocol || 'n/a'}`,
    `Cookie count: ${last.cookieCount ?? 'n/a'}`,
    `Attempts: ${attempts}`,
  ];

  if (htmlPreview) {
    lines.push(`HTML preview (first 500 chars): ${oneLine(htmlPreview.slice(0, 500))}`);
  }

  if (cause?.message) {
    lines.push(`Last error: ${cause.message}`);
  }

  const err = new Error(lines.join('\n'));
  err.name = 'DownloadError';
  err.diagnostics = diagnostics;
  err.cause = cause;
  return err;
}

function createDiagnostics(inputUrl) {
  const startedAt = Date.now();
  return {
    inputUrl,
    attempts: [],
    htmlRecoveries: [],
    lastResource: null,
    startedAt,
    elapsedMs: () => Date.now() - startedAt,
  };
}

function recordAttempt(diagnostics, details) {
  diagnostics.attempts.push(summarizeResource(details));
  if (diagnostics.attempts.length > 80) {
    diagnostics.attempts.splice(0, diagnostics.attempts.length - 80);
  }
}

function summarizeResource(resource) {
  const bodyText = resource.bodyText || '';
  return {
    status: resource.status,
    contentType: resource.contentType || firstHeader(resource.headers?.['content-type']) || '',
    finalUrl: resource.finalUrl,
    redirectChain: resource.redirectChain || [],
    headers: resource.headers || {},
    responseSize: resource.responseSize || resource.buffer?.length || 0,
    rawSize: resource.rawSize || 0,
    retryStrategy: resource.retryStrategy || '',
    elapsedMs: resource.elapsedMs || 0,
    browser: resource.browser || '',
    protocol: resource.protocol || '',
    cookieCount: resource.cookieCount ?? 0,
    error: resource.error ? String(resource.error.message || resource.error) : '',
    htmlPreview: looksLikeHtml(resource.contentType, bodyText || resource.buffer)
      ? String(bodyText || decodeText(resource.buffer || Buffer.alloc(0))).slice(0, 500)
      : '',
  };
}

function lastResponseAttempt(diagnostics) {
  for (let index = diagnostics.attempts.length - 1; index >= 0; index -= 1) {
    if (diagnostics.attempts[index].status) return diagnostics.attempts[index];
  }
  return diagnostics.attempts[diagnostics.attempts.length - 1] || null;
}

function getLastHtmlPreview(diagnostics) {
  const recovery = diagnostics.htmlRecoveries[diagnostics.htmlRecoveries.length - 1];
  return recovery?.preview || '';
}

function formatAttempt(attempt) {
  if (attempt.error) {
    return `${attempt.retryStrategy || 'request'} ${attempt.protocol || ''} ${attempt.browser || ''}: ERROR ${oneLine(attempt.error)}`;
  }

  return [
    attempt.retryStrategy || 'request',
    attempt.protocol || 'protocol?',
    attempt.browser || 'browser?',
    `status=${attempt.status || 'n/a'}`,
    `ct=${attempt.contentType || 'n/a'}`,
    `size=${formatBytes(attempt.responseSize || 0)}`,
  ].join(' ');
}

function formatRedirectChain(chain) {
  if (!Array.isArray(chain) || !chain.length) return '(none)';
  return chain.map((item) => `${item.status}: ${item.from} -> ${item.to}`).join(' | ');
}

function formatHeaders(headers) {
  const entries = Object.entries(headers || {})
    .filter(([key]) => !String(key).startsWith(':'))
    .slice(0, 16)
    .map(([key, value]) => `${key}=${sanitizeHeaderValue(key, value)}`);

  return entries.length ? entries.join('; ') : '(none)';
}

function sanitizeHeaderValue(key, value) {
  const lower = String(key || '').toLowerCase();
  if (lower === 'set-cookie') {
    const list = Array.isArray(value) ? value : value ? [value] : [];
    return `[${list.length} cookie${list.length === 1 ? '' : 's'}]`;
  }
  if (lower.includes('cookie') || lower === 'authorization') return '[redacted]';
  return oneLine(Array.isArray(value) ? value.join(', ') : String(value ?? '')).slice(0, 240);
}

function getBrowser(id) {
  return BROWSER_PROFILES.find((browser) => browser.id === id) || BROWSER_PROFILES[0];
}

function rotateBrowserProfiles(seedValue) {
  const offset = Math.abs(hashString(`${seedValue}:${browserRotationSeed}`)) % BROWSER_PROFILES.length;
  browserRotationSeed = (browserRotationSeed + 1) % 1000000;
  return BROWSER_PROFILES.map((_, index) => BROWSER_PROFILES[(offset + index) % BROWSER_PROFILES.length]);
}

function hashString(value) {
  let hash = 0;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  return hash;
}

function jarSetFromResponse(jar, setCookie, requestUrl) {
  if (!jar || !setCookie) return;
  jar.setFromResponse(setCookie, requestUrl);
}

function getRedirectMethod(method, status) {
  const current = String(method || 'GET').toUpperCase();
  if (status === 303 && current !== 'HEAD') return 'GET';
  if ((status === 301 || status === 302) && current === 'POST') return 'GET';
  return current;
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(Number(status));
}

function isUsableImageStatus(status) {
  const code = Number(status || 0);
  return (code >= 200 && code < 300) || code === 304;
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

function firstHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeContentType(contentType) {
  return String(firstHeader(contentType) || '').split(';')[0].trim().toLowerCase();
}

function getSecFetchSite(url, referer) {
  const target = getOrigin(url);
  const ref = getOrigin(referer);
  if (!ref) return 'none';
  if (ref === target) return 'same-origin';
  return 'cross-site';
}

function getOrigin(value) {
  try {
    return new URL(String(value || '')).origin;
  } catch {
    return '';
  }
}

function resolveUrl(candidate, baseUrl) {
  const value = String(candidate || '').trim();
  if (!value) return value;
  if (isDataUrl(value)) return value;

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
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch {
    return null;
  }
}

function isDataUrl(value) {
  return /^data:/i.test(String(value || '').trim());
}

function decodeDataUrl(dataUrl) {
  const match = String(dataUrl).match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
  if (!match) throw new Error('invalid data url');

  const contentType = match[1] || 'application/octet-stream';
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || '';
  const buffer = isBase64
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');

  return { buffer, contentType };
}

function looksLikeImageUrl(value) {
  const text = String(value || '').trim();
  return isDataUrl(text) || IMAGE_URL_RE.test(text);
}

function extensionFromUrl(url) {
  const clean = String(url || '').split('?')[0].split('#')[0].toLowerCase();
  const match = clean.match(/\.([a-z0-9]+)$/i);
  if (!match) return '';

  const ext = match[1] === 'jpeg' ? 'jpg' : match[1] === 'tif' ? 'tiff' : match[1];
  return ['jpg', 'png', 'gif', 'bmp', 'webp', 'svg', 'avif', 'heic', 'heif', 'tiff', 'ico'].includes(ext)
    ? ext
    : '';
}

function contentTypeFromExtension(ext) {
  const map = {
    jpg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    bmp: 'image/bmp',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    avif: 'image/avif',
    heic: 'image/heic',
    heif: 'image/heif',
    tiff: 'image/tiff',
    ico: 'image/x-icon',
  };
  return map[ext] || 'application/octet-stream';
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCharCode(Number.parseInt(n, 16)));
}

function normalizeEscapedUrl(value) {
  return decodeHtmlEntities(String(value || ''))
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u002f/gi, '/');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeText(buffer) {
  if (!buffer) return '';
  return Buffer.isBuffer(buffer) ? buffer.toString('utf8').replace(/^\uFEFF/, '') : String(buffer);
}

function oneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelay(index, err) {
  const base = err && /timeout|econnreset|socket|network/i.test(String(err.message || err)) ? 350 : 180;
  const jitter = Math.floor(Math.random() * 120);
  return Math.min(1800, base * (index + 1) + jitter);
}

function formatDuration(ms) {
  const n = Number(ms || 0);
  if (!Number.isFinite(n) || n < 1000) return `${Math.max(0, Math.round(n))}ms`;
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}s`;
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / Math.pow(1024, idx);
  return `${value >= 10 || idx === 0 ? Math.round(value) : value.toFixed(1)} ${units[idx]}`;
}

function safeHostname(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function defaultCookiePath(requestUrl) {
  try {
    const pathname = new URL(String(requestUrl || '')).pathname || '/';
    if (!pathname || pathname[0] !== '/') return '/';
    if (pathname === '/') return '/';
    const index = pathname.lastIndexOf('/');
    return index <= 0 ? '/' : pathname.slice(0, index);
  } catch {
    return '/';
  }
}

function domainMatches(host, domain, hostOnly) {
  const h = String(host || '').toLowerCase();
  const d = String(domain || '').replace(/^\./, '').toLowerCase();
  if (!h || !d) return false;
  if (hostOnly) return h === d;
  return h === d || h.endsWith(`.${d}`);
}

function splitSetCookieHeader(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;

  const text = String(value);
  const parts = [];
  let start = 0;
  let inExpires = false;

  for (let i = 0; i < text.length; i += 1) {
    const chunk = text.slice(Math.max(0, i - 8), i + 1).toLowerCase();
    if (chunk.endsWith('expires=')) inExpires = true;
    if (inExpires && text[i] === ';') inExpires = false;
    if (!inExpires && text[i] === ',') {
      const next = text.slice(i + 1).trim();
      if (/^[^=;,\s]+=/.test(next)) {
        parts.push(text.slice(start, i).trim());
        start = i + 1;
      }
    }
  }

  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

class CookieJar {
  constructor(initialCookies = []) {
    this.cookies = [];
    initialCookies.forEach((cookie) => this.upsert(cookie));
  }

  setFromResponse(setCookie, requestUrl) {
    const host = safeHostname(requestUrl);
    if (!host) return;

    for (const raw of splitSetCookieHeader(setCookie)) {
      const parsed = parseSetCookie(raw, requestUrl);
      if (!parsed) continue;
      this.upsert(parsed);
    }

    this.pruneExpired();
  }

  setFromPlaywrightCookies(cookies = []) {
    for (const item of cookies) {
      const cookie = {
        name: item.name,
        value: item.value,
        domain: String(item.domain || '').replace(/^\./, '').toLowerCase(),
        hostOnly: !String(item.domain || '').startsWith('.'),
        path: item.path || '/',
        secure: Boolean(item.secure),
        httpOnly: Boolean(item.httpOnly),
        sameSite: item.sameSite || '',
        expires: item.expires && item.expires > 0 ? item.expires * 1000 : null,
        createdAt: Date.now(),
      };
      this.upsert(cookie);
    }
    this.pruneExpired();
  }

  getHeader(requestUrl) {
    const u = safeUrl(requestUrl);
    if (!u) return '';

    this.pruneExpired();

    const host = u.hostname.toLowerCase();
    const path = u.pathname || '/';
    const isSecure = u.protocol === 'https:';

    return this.cookies
      .filter((cookie) => {
        if (cookie.secure && !isSecure) return false;
        if (!domainMatches(host, cookie.domain, cookie.hostOnly)) return false;
        if (!pathMatches(path, cookie.path)) return false;
        return true;
      })
      .sort((a, b) => b.path.length - a.path.length || a.createdAt - b.createdAt)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }

  toPlaywrightCookies(requestUrl) {
    const u = safeUrl(requestUrl);
    if (!u) return [];

    this.pruneExpired();

    const host = u.hostname.toLowerCase();
    return this.cookies
      .filter((cookie) => domainMatches(host, cookie.domain, cookie.hostOnly))
      .map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.hostOnly ? host : `.${cookie.domain}`,
        path: cookie.path || '/',
        expires: cookie.expires ? Math.floor(cookie.expires / 1000) : -1,
        httpOnly: Boolean(cookie.httpOnly),
        secure: Boolean(cookie.secure),
        sameSite: normalizePlaywrightSameSite(cookie.sameSite),
      }));
  }

  count() {
    this.pruneExpired();
    return this.cookies.length;
  }

  upsert(cookie) {
    if (!cookie || !cookie.name || !cookie.domain) return;
    this.cookies = this.cookies.filter((existing) => {
      return !(
        existing.name === cookie.name &&
        existing.domain === cookie.domain &&
        existing.path === cookie.path
      );
    });

    if (!cookie.expired) {
      this.cookies.push({
        ...cookie,
        createdAt: cookie.createdAt || Date.now(),
      });
    }

    this.enforceLimits();
  }

  pruneExpired() {
    const now = Date.now();
    this.cookies = this.cookies.filter((cookie) => !cookie.expires || cookie.expires > now);
  }

  enforceLimits() {
    this.pruneExpired();

    const byDomain = new Map();
    for (const cookie of this.cookies) {
      const list = byDomain.get(cookie.domain) || [];
      list.push(cookie);
      byDomain.set(cookie.domain, list);
    }

    for (const list of byDomain.values()) {
      if (list.length <= MAX_COOKIES_PER_DOMAIN) continue;
      list
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        .slice(0, list.length - MAX_COOKIES_PER_DOMAIN)
        .forEach((cookie) => {
          cookie.expired = true;
        });
    }

    this.cookies = this.cookies.filter((cookie) => !cookie.expired);

    if (this.cookies.length > MAX_COOKIES) {
      this.cookies = this.cookies
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, MAX_COOKIES);
    }
  }
}

function parseSetCookie(raw, requestUrl) {
  const text = String(raw || '').trim();
  if (!text) return null;

  const host = safeHostname(requestUrl);
  if (!host) return null;

  const segments = text.split(';').map((part) => part.trim());
  const [nameValue, ...attrs] = segments;
  const eqIndex = nameValue.indexOf('=');
  if (eqIndex <= 0) return null;

  const cookie = {
    name: nameValue.slice(0, eqIndex).trim(),
    value: nameValue.slice(eqIndex + 1).trim(),
    domain: host,
    hostOnly: true,
    path: defaultCookiePath(requestUrl),
    secure: false,
    httpOnly: false,
    sameSite: '',
    expires: null,
    expired: false,
    createdAt: Date.now(),
  };

  if (!cookie.name) return null;

  for (const attr of attrs) {
    const [keyRaw, ...rest] = attr.split('=');
    const key = String(keyRaw || '').trim().toLowerCase();
    const value = rest.join('=').trim();

    if (key === 'domain' && value) {
      const domain = value.replace(/^\./, '').toLowerCase();
      if (!domainMatches(host, domain, false)) continue;
      cookie.domain = domain;
      cookie.hostOnly = false;
    } else if (key === 'path' && value) {
      cookie.path = value.startsWith('/') ? value : `/${value}`;
    } else if (key === 'secure') {
      cookie.secure = true;
    } else if (key === 'httponly') {
      cookie.httpOnly = true;
    } else if (key === 'samesite') {
      cookie.sameSite = value;
    } else if (key === 'expires' && value) {
      const expires = Date.parse(value);
      if (Number.isFinite(expires)) cookie.expires = expires;
    } else if (key === 'max-age' && value) {
      const seconds = Number.parseInt(value, 10);
      if (Number.isFinite(seconds)) {
        if (seconds <= 0) cookie.expired = true;
        else cookie.expires = Date.now() + seconds * 1000;
      }
    }
  }

  if (cookie.expires && cookie.expires <= Date.now()) {
    cookie.expired = true;
  }

  return cookie;
}

function pathMatches(requestPath, cookiePath) {
  const req = requestPath || '/';
  const cookie = cookiePath || '/';
  if (req === cookie) return true;
  if (!req.startsWith(cookie)) return false;
  if (cookie.endsWith('/')) return true;
  return req[cookie.length] === '/';
}

function normalizePlaywrightSameSite(value) {
  const lower = String(value || '').toLowerCase();
  if (lower === 'strict') return 'Strict';
  if (lower === 'none') return 'None';
  return 'Lax';
}

async function closeDownloaderResources() {
  httpAgent.destroy();
  httpsAgent.destroy();

  for (const session of http2Sessions.values()) {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    try {
      session.client.close();
    } catch {
      try {
        session.client.destroy();
      } catch {
        // ignore shutdown races
      }
    }
  }
  http2Sessions.clear();

  if (sharedBrowserPromise) {
    const browserPromise = sharedBrowserPromise;
    sharedBrowserPromise = null;
    const browser = await browserPromise.catch(() => null);
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

sharedCookieJar = new CookieJar();

module.exports = {
  downloadImage,
  closeDownloaderResources,
  CookieJar,
  _test: {
    discoverMainImageCandidates: discoverIntelligentImageCandidates,
    extractImageCandidates,
    parseSrcsetDetailed,
    scoreMainImageCandidate: scoreIntelligentImageCandidate,
    selectMainImageCandidate,
  },
};

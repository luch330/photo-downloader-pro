const assert = require('assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { downloadImage, _test } = require('../src/downloader');
const { extractAllImageCandidates, normalizeCandidates } = require('../src/imageCandidateExtractor');
const { selectMainImageCandidate } = require('../src/imageCandidateSelector');
const { MerchantLearningEngine } = require('../src/merchantLearningEngine');

const ROOT_DIR = path.resolve(__dirname, '..');
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
);

test('main image scoring prefers product metadata and avoids logos and thumbnails', () => {
  const html = `
    <meta property="og:image" content="/assets/logo-96x96.png">
    <meta property="twitter:image" content="/assets/thumb-120x120.png">
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": "Merchant Bowl",
        "image": {
          "@type": "ImageObject",
          "url": "/assets/product-main-1400x1400.png"
        }
      }
    </script>
    <img src="/assets/icon.png" width="48" height="48" alt="site icon">
    <img src="/assets/thumbnail-220x220.png" width="220" height="220" alt="thumbnail">
  `;

  const candidates = _test.discoverMainImageCandidates(html, 'https://merchant.example/item');

  assert.equal(candidates[0].url, 'https://merchant.example/assets/product-main-1400x1400.png');
  assert.ok(candidates[0].score > candidates.find((item) => item.url.includes('logo')).score);
  assert.ok(candidates[0].score > candidates.find((item) => item.url.includes('thumbnail')).score);
});

test('main image discovery understands srcset and ranks the largest useful candidate first', () => {
  const html = `
    <picture>
      <source srcset="/cdn/thumb-160x160.webp 160w, /cdn/product-gallery-900x900.webp 900w" type="image/webp">
      <img src="/cdn/thumb-160x160.jpg" alt="product gallery image" width="160" height="160">
    </picture>
  `;

  const candidates = _test.discoverMainImageCandidates(html, 'https://merchant.example/products/one');

  assert.equal(candidates[0].url, 'https://merchant.example/cdn/product-gallery-900x900.webp');
  assert.equal(_test.parseSrcsetDetailed('/a.png 320w, /b.png 1024w')[0].url, '/b.png');
});

test('extractor collects metadata, JSON-LD, DOM, srcset, lazy, and CSS candidates before ranking', () => {
  const html = `
    <meta property="og:image" content="/meta-og-1200x1200.jpg">
    <script type="application/ld+json">{"@type":"Product","image":"/json-product-1200x1200.jpg"}</script>
    <main style="background-image:url('/css-background-900x900.jpg')">
      <picture><source srcset="/source-small.jpg 320w, /source-large.jpg 1200w"></picture>
      <img data-src="/lazy-product-1000x1000.jpg" src="/fallback-product-400x400.jpg">
    </main>
  `;

  const raw = extractAllImageCandidates(html, 'https://merchant.example/p/one');
  const urls = normalizeCandidates(raw, 'https://merchant.example/p/one').map((item) => item.url);

  assert.ok(urls.includes('https://merchant.example/meta-og-1200x1200.jpg'));
  assert.ok(urls.includes('https://merchant.example/json-product-1200x1200.jpg'));
  assert.ok(urls.includes('https://merchant.example/css-background-900x900.jpg'));
  assert.ok(urls.includes('https://merchant.example/source-large.jpg'));
  assert.ok(urls.includes('https://merchant.example/lazy-product-1000x1000.jpg'));
});

test('primaryImageOfPage receives top metadata priority', () => {
  const selected = selectMainImageCandidate(`
    <script type="application/ld+json">
      {"@type":"WebPage","primaryImageOfPage":{"@type":"ImageObject","url":"/primaryImageOfPage-1600x1200.jpg"}}
    </script>
    <main><img src="/body-product-900x900.jpg" width="900" height="900" class="product-image"></main>
  `, 'https://merchant.example/item').selected;

  assert.equal(selected.url, 'https://merchant.example/primaryImageOfPage-1600x1200.jpg');
  assert.ok(selected.reasons.some((reason) => /primaryImageOfPage/.test(reason)));
});

test('mainEntity.image is preferred over weak page images', () => {
  const selected = selectMainImageCandidate(`
    <meta property="og:image" content="/brand-logo-120x120.png">
    <script type="application/ld+json">
      {"@type":"WebPage","mainEntity":{"@type":"Product","name":"Merchant Pan","image":"/main-entity-product-1400x1400.jpg"}}
    </script>
  `, 'https://merchant.example/item').selected;

  assert.equal(selected.url, 'https://merchant.example/main-entity-product-1400x1400.jpg');
});

test('Product.image and JSON-LD priority beat generic DOM candidates', () => {
  const selected = selectMainImageCandidate(`
    <script type="application/ld+json">
      {"@type":"Product","name":"Merchant Bowl","image":"/schema-product-1200x1200.jpg"}
    </script>
    <main><img src="/content-image-800x800.jpg" width="800" height="800"></main>
  `, 'https://merchant.example/item').selected;

  assert.equal(selected.url, 'https://merchant.example/schema-product-1200x1200.jpg');
  assert.ok(selected.reasons.some((reason) => /Product\.image/.test(reason)));
});

test('DOM priority prefers main product content over sidebar and footer images', () => {
  const selected = selectMainImageCandidate(`
    <aside class="sidebar"><img src="/sidebar-product-1200x1200.jpg" width="1200" height="1200"></aside>
    <main class="main-content product"><img src="/main-product-1200x1200.jpg" width="1200" height="1200"></main>
    <footer><img src="/footer-product-1200x1200.jpg" width="1200" height="1200"></footer>
  `, 'https://merchant.example/item').selected;

  assert.equal(selected.url, 'https://merchant.example/main-product-1200x1200.jpg');
});

test('gallery logic picks the first large gallery image rather than thumbnails', () => {
  const selected = selectMainImageCandidate(`
    <main class="product-gallery">
      <img src="/thumb-80x80.jpg" width="80" height="80" class="thumbnail">
      <img src="/gallery-main-1000x1000.jpg" width="1000" height="1000" class="gallery-image">
      <img src="/gallery-alt-1000x1000.jpg" width="1000" height="1000" class="gallery-image">
    </main>
  `, 'https://merchant.example/item').selected;

  assert.equal(selected.url, 'https://merchant.example/gallery-main-1000x1000.jpg');
  assert.ok(selected.reasons.some((reason) => /gallery/.test(reason)));
});

test('H1 proximity lifts the nearby product image above an earlier unrelated image', () => {
  const selected = selectMainImageCandidate(`
    <main>
      <img src="/unrelated-product-900x900.jpg" width="900" height="900">
      <section class="product-detail">
        <h1>Blue Merchant Bowl</h1>
        <img src="/blue-merchant-bowl-900x900.jpg" width="900" height="900" alt="Blue Merchant Bowl product photo">
      </section>
    </main>
  `, 'https://merchant.example/item').selected;

  assert.equal(selected.url, 'https://merchant.example/blue-merchant-bowl-900x900.jpg');
  assert.ok(selected.reasons.some((reason) => /H1/.test(reason)));
});

test('large image selection beats small product-like assets', () => {
  const selected = selectMainImageCandidate(`
    <main class="product">
      <img src="/product-small-180x180.jpg" width="180" height="180">
      <img src="/product-large-1400x1400.jpg" width="1400" height="1400">
    </main>
  `, 'https://merchant.example/item').selected;

  assert.equal(selected.url, 'https://merchant.example/product-large-1400x1400.jpg');
});

test('thumbnail, logo, and banner candidates are heavily penalized but not hard-rejected', () => {
  const ranked = selectMainImageCandidate(`
    <main class="product">
      <img src="/logo-800x800.png" width="800" height="800" alt="brand logo">
      <img src="/thumbnail-900x900.jpg" width="900" height="900" class="thumbnail">
      <img src="/promo-banner-1800x260.jpg" width="1800" height="260">
      <img src="/product-main-1000x1000.jpg" width="1000" height="1000" alt="Merchant product photo">
    </main>
  `, 'https://merchant.example/item').candidates;

  assert.equal(ranked[0].url, 'https://merchant.example/product-main-1000x1000.jpg');
  assert.ok(ranked.find((item) => item.url.includes('logo')));
  assert.ok(ranked.find((item) => item.url.includes('banner')).score < ranked[0].score);
});

test('aspect ratio ranking prefers square or slight landscape product images', () => {
  const selected = selectMainImageCandidate(`
    <main class="product">
      <img src="/product-wide-1800x280.jpg" width="1800" height="280" class="product-image">
      <img src="/product-square-900x900.jpg" width="900" height="900" class="product-image">
    </main>
  `, 'https://merchant.example/item').selected;

  assert.equal(selected.url, 'https://merchant.example/product-square-900x900.jpg');
});

test('fallback ordering uses score, then metadata, DOM quality, and resolution', () => {
  const ranked = selectMainImageCandidate(`
    <meta property="twitter:image" content="/metadata-product-1000x1000.jpg">
    <main class="product"><img src="/dom-product-1000x1000.jpg" width="1000" height="1000"></main>
  `, 'https://merchant.example/item').candidates;

  assert.equal(ranked[0].url, 'https://merchant.example/metadata-product-1000x1000.jpg');
});

test('multiple candidate ranking rewards consensus across metadata, JSON-LD, and DOM', () => {
  const selected = selectMainImageCandidate(`
    <meta property="og:image" content="/consensus-product-1200x1200.jpg">
    <script type="application/ld+json">{"@type":"Product","image":"/consensus-product-1200x1200.jpg"}</script>
    <main class="product"><img src="/consensus-product-1200x1200.jpg" width="1200" height="1200"></main>
    <main class="product"><img src="/other-product-1400x1400.jpg" width="1400" height="1400"></main>
  `, 'https://merchant.example/item').selected;

  assert.equal(selected.url, 'https://merchant.example/consensus-product-1200x1200.jpg');
  assert.ok(selected.reasons.some((reason) => /multiple ways/.test(reason)));
});

test('learning cache can be empty and selection still uses the universal engine', () => {
  const learningEngine = new MerchantLearningEngine({ cachePath: tempLearningCachePath('empty') });
  const result = selectMainImageCandidate(`
    <main class="product"><img src="/universal-product-1000x1000.jpg" width="1000" height="1000"></main>
  `, 'https://empty-learning.example/item', { learningEngine });

  assert.equal(result.selected.url, 'https://empty-learning.example/universal-product-1000x1000.jpg');
  assert.equal(result.learningProfile, null);
  assert.ok(result.selected.confidence > 0);
});

test('host learns from a successful image selection and writes a debuggable cache', () => {
  const cachePath = tempLearningCachePath('record');
  const learningEngine = new MerchantLearningEngine({ cachePath });
  const result = selectMainImageCandidate(`
    <script type="application/ld+json">{"@type":"Product","image":"/learned-product-1200x1200.jpg"}</script>
  `, 'https://learn.example/item', { learningEngine });

  const profile = learningEngine.recordSuccess('https://learn.example/item', result.selected, {
    confidence: result.selected.confidence,
  });
  const saved = JSON.parse(fs.readFileSync(cachePath, 'utf8'));

  assert.equal(profile.hostname, 'learn.example');
  assert.equal(saved.hosts['learn.example'].successes, 1);
  assert.ok(saved.hosts['learn.example'].lastStrategy.includes('Product.image'));
});

test('learned host hints influence future ranking without hardcoding a domain', () => {
  const learningEngine = new MerchantLearningEngine({ cachePath: tempLearningCachePath('boost') });
  learningEngine.recordSuccess('https://boost.example/item', {
    url: 'https://boost.example/previous-large.jpg',
    source: 'dom:img:data-src',
    sources: ['dom:img:data-src'],
    sourceType: 'dom',
    sourceTypes: ['dom'],
    domPath: 'main.product > img',
    className: 'product-image',
    width: 1000,
    height: 1000,
    confidence: 90,
  }, { confidence: 90 });

  const result = selectMainImageCandidate(`
    <main class="product">
      <img src="/src-candidate-1000x1000.jpg" width="1000" height="1000" class="product-image">
      <img data-src="/data-src-candidate-1000x1000.jpg" width="1000" height="1000" class="product-image">
    </main>
  `, 'https://boost.example/item-2', { learningEngine });

  assert.equal(result.selected.url, 'https://boost.example/data-src-candidate-1000x1000.jpg');
  assert.ok(result.selected.learning.boost > 0);
  assert.ok(result.selected.reasons.some((reason) => /learned host hint/.test(reason)));
});

test('domain-specific learning remains host-based and generic', () => {
  const learningEngine = new MerchantLearningEngine({ cachePath: tempLearningCachePath('hosts') });
  learningEngine.recordSuccess('https://alpha.example/item', {
    url: 'https://alpha.example/previous.jpg',
    source: 'dom:img:data-src',
    sources: ['dom:img:data-src'],
    sourceType: 'dom',
    sourceTypes: ['dom'],
    domPath: 'main.product > img',
    className: 'product-image',
    width: 1000,
    height: 1000,
    confidence: 92,
  }, { confidence: 92 });

  const alpha = selectMainImageCandidate(`
    <main class="product">
      <img src="/src-candidate-1000x1000.jpg" width="1000" height="1000" class="product-image">
      <img data-src="/data-src-candidate-1000x1000.jpg" width="1000" height="1000" class="product-image">
    </main>
  `, 'https://alpha.example/item-2', { learningEngine });
  const beta = selectMainImageCandidate(`
    <main class="product">
      <img src="/src-candidate-1000x1000.jpg" width="1000" height="1000" class="product-image">
      <img data-src="/data-src-candidate-1000x1000.jpg" width="1000" height="1000" class="product-image">
    </main>
  `, 'https://beta.example/item-2', { learningEngine });

  assert.equal(alpha.selected.url, 'https://alpha.example/data-src-candidate-1000x1000.jpg');
  assert.equal(beta.selected.learning, undefined);
});

test('confidence and explainability output are produced for selected and runner-up candidates', () => {
  const result = selectMainImageCandidate(`
    <meta property="og:image" content="/explain-product-1200x1200.jpg">
    <main><img src="/runner-up-1000x1000.jpg" width="1000" height="1000"></main>
  `, 'https://explain.example/item');

  assert.ok(result.selected.confidence >= 1 && result.selected.confidence <= 99);
  assert.match(result.selected.confidenceLabel, /high|medium|low/);
  assert.ok(result.debug.reasons.length);
  assert.match(result.debug.runnerUpLost, /Runner-up lost/);
  assert.ok(result.debug.closestAlternatives[0].reasons.length);
});

test('corrupted learning cache does not break selection', () => {
  const cachePath = tempLearningCachePath('corrupt');
  fs.writeFileSync(cachePath, '{ definitely not json');
  const learningEngine = new MerchantLearningEngine({ cachePath });
  const result = selectMainImageCandidate(`
    <main class="product"><img src="/safe-product-900x900.jpg" width="900" height="900"></main>
  `, 'https://corrupt-cache.example/item', { learningEngine });

  assert.equal(result.selected.url, 'https://corrupt-cache.example/safe-product-900x900.jpg');
  assert.equal(learningEngine.getProfile('corrupt-cache.example'), null);
});

test('Playwright HTML discovery fallback stays after metadata, JSON-LD, and DOM attempts', () => {
  const downloaderSource = fs.readFileSync(path.join(ROOT_DIR, 'src/downloader.js'), 'utf8');
  assert.match(downloaderSource, /if \(config\.browserFallback \|\| config\.htmlImageDiscovery\)/);
  assert.ok(downloaderSource.indexOf('GET document headers') < downloaderSource.indexOf('Playwright HTML discovery fallback'));
  assert.ok(downloaderSource.indexOf('GET broad accept mobile') < downloaderSource.indexOf('Playwright HTML discovery fallback'));
});

test('downloadImage uses legacy HTML recovery by default and scored main-image recovery when enabled', async () => {
  const server = await startHtmlImageServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const off = await downloadImage(`${baseUrl}/page`, {
      timeoutMs: 5000,
      retries: 0,
      browserFallback: false,
    });
    assert.match(off.finalUrl, /thumb-80x80\.png$/);

    const on = await downloadImage(`${baseUrl}/page`, {
      timeoutMs: 5000,
      retries: 0,
      browserFallback: false,
      htmlImageDiscovery: true,
    });
    assert.match(on.finalUrl, /product-main-1400x1400\.png$/);
  } finally {
    await closeServer(server);
  }
});

test('top-N fallback tries the next ranked HTML candidate when the first candidate fails', async () => {
  const server = await startHtmlImageServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const learningEngine = new MerchantLearningEngine({ cachePath: tempLearningCachePath('fallback') });
    const result = await downloadImage(`${baseUrl}/fallback-page`, {
      timeoutMs: 5000,
      retries: 0,
      browserFallback: false,
      htmlImageDiscovery: true,
      learningEngine,
    });

    assert.match(result.finalUrl, /backup-product-1200x1200\.png$/);
    assert.equal(result.intelligence.attemptedCandidates >= 2, true);
    assert.ok(learningEngine.getProfile(`127.0.0.1:${server.address().port}`) || learningEngine.getProfile('127.0.0.1'));
  } finally {
    await closeServer(server);
  }
});

test('frontend renders, persists, and sends the HTML discovery setting', () => {
  const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'public/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(ROOT_DIR, 'public/app.js'), 'utf8');

  assert.match(indexHtml, /id="htmlDiscoveryInput"/);
  assert.match(indexHtml, /HTML image discovery/);
  assert.match(appJs, /const htmlDiscoveryInput = document\.getElementById\('htmlDiscoveryInput'\)/);
  assert.match(appJs, /htmlDiscoveryInput:\s*false/);
  assert.match(appJs, /saved\.htmlDiscoveryInput/);
  assert.match(appJs, /htmlDiscoveryInput:\s*htmlDiscoveryInput\.checked/);
  assert.match(appJs, /htmlImageDiscovery:\s*htmlDiscoveryInput\.checked/);
});

test('backend receives and respects htmlImageDiscovery job setting', async () => {
  const imageServer = await startHtmlImageServer();
  const appPort = await getFreePort();
  const app = spawn(process.execPath, ['server.js'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(appPort),
      JOB_RETENTION_MS: String(15 * 60 * 1000),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let appOutput = '';
  app.stdout.on('data', (chunk) => {
    appOutput += chunk.toString();
  });
  app.stderr.on('data', (chunk) => {
    appOutput += chunk.toString();
  });

  try {
    const baseUrl = `http://127.0.0.1:${appPort}`;
    const imageBase = `http://127.0.0.1:${imageServer.address().port}`;
    await waitForHealth(baseUrl, app);

    const legacy = await runJob(baseUrl, imageBase, false);
    assert.equal(legacy.ready, 1);
    assert.match(legacy.reportText, /htmlImageDiscovery=off/);
    assert.match(legacy.reportText, /thumb-80x80\.png/);
    assert.doesNotMatch(legacy.reportText, /product-main-1400x1400\.png/);

    const scored = await runJob(baseUrl, imageBase, true);
    assert.equal(scored.ready, 1);
    assert.match(scored.reportText, /htmlImageDiscovery=on/);
    assert.match(scored.reportText, /product-main-1400x1400\.png/);
  } finally {
    await closeServer(imageServer);
    await stopProcess(app, appOutput);
  }
});

function startHtmlImageServer() {
  const server = http.createServer((req, res) => {
    const url = req.url || '';

    if (url === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
        <html>
          <head><title>Product page</title></head>
          <body>
            <main>
              <img src="/assets/thumb-80x80.png" width="80" height="80" alt="thumbnail image" class="thumbnail">
              <img src="/assets/product-main-1400x1400.png" width="1400" height="1400" alt="Main merchant product photo" class="product-main gallery-image">
            </main>
          </body>
        </html>`);
      return;
    }

    if (url === '/fallback-page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
        <html>
          <head>
            <script type="application/ld+json">{"@type":"Product","image":"/assets/missing-primary-1600x1600.png"}</script>
          </head>
          <body>
            <main class="product-gallery">
              <img src="/assets/backup-product-1200x1200.png" width="1200" height="1200" alt="Backup product image">
            </main>
          </body>
        </html>`);
      return;
    }

    if (/^\/assets\/(?:thumb-80x80|product-main-1400x1400|backup-product-1200x1200)\.png$/.test(url)) {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': PNG_1X1.length,
      });
      res.end(PNG_1X1);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

async function runJob(baseUrl, imageBase, htmlImageDiscovery) {
  const startRes = await fetch(`${baseUrl}/api/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: htmlImageDiscovery ? 'html-on.xlsx' : 'html-off.xlsx',
      rows: [
        ['Name', 'Image URL'],
        ['Product', `${imageBase}/page`],
      ],
      settings: {
        timeoutMs: 5000,
        retries: 0,
        concurrency: 1,
        browserFallback: false,
        htmlImageDiscovery,
        maxSide: 3000,
        quality: 92,
      },
    }),
  });
  const start = await startRes.json();

  assert.equal(startRes.status, 200);
  assert.equal(start.ok, true);
  assert.ok(start.jobId);

  return waitForJobDone(baseUrl, start.jobId);
}

function getFreePort() {
  const server = http.createServer();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function waitForHealth(baseUrl, appProcess) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10000) {
    if (appProcess.exitCode !== null) {
      throw new Error(`server exited before health check completed with code ${appProcess.exitCode}`);
    }

    try {
      const res = await fetch(`${baseUrl}/health`);
      const body = await res.json();
      if (res.ok && body.ok) return;
    } catch {
      // server is still starting
    }

    await sleep(150);
  }

  throw new Error('server health check timed out');
}

async function waitForJobDone(baseUrl, jobId) {
  const startedAt = Date.now();
  let lastStatus = null;

  while (Date.now() - startedAt < 20000) {
    const res = await fetch(`${baseUrl}/api/status/${jobId}`, { cache: 'no-store' });
    lastStatus = await res.json();

    if (lastStatus.status === 'done') return lastStatus;
    if (lastStatus.status === 'error') {
      throw new Error(`job failed unexpectedly: ${lastStatus.error || lastStatus.message}`);
    }

    await sleep(250);
  }

  throw new Error(`job did not finish in time: ${JSON.stringify(lastStatus)}`);
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function tempLearningCachePath(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `piccatch-learning-${label}-`));
  return path.join(dir, 'learning-cache.json');
}

function stopProcess(child, output) {
  if (child.exitCode !== null) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server did not stop cleanly:\n${output}`));
    }, 5000);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

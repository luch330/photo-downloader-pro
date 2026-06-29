const assert = require('assert/strict');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const test = require('node:test');

const ROOT_DIR = path.resolve(__dirname, '..');
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
);

test('failed image download does not stop batch processing', async () => {
  const imageServer = await startImageServer();
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
    await waitForHealth(baseUrl, app);

    const imageBase = `http://127.0.0.1:${imageServer.address().port}`;
    const rows = [
      ['Name', 'Image URL'],
      ['Valid 1', `${imageBase}/image-1.png`],
      ['Valid 2', `${imageBase}/image-2.png`],
      ['Invalid', `${imageBase}/missing.png`],
      ['Valid 3', `${imageBase}/image-3.png`],
      ['Valid 4', `${imageBase}/image-4.png`],
    ];

    const startRes = await fetch(`${baseUrl}/api/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: 'batch-failure.xlsx',
        rows,
        settings: {
          timeoutMs: 5000,
          retries: 0,
          concurrency: 3,
          browserFallback: false,
          maxSide: 3000,
          quality: 92,
        },
      }),
    });
    const start = await startRes.json();

    assert.equal(startRes.status, 200);
    assert.equal(start.ok, true);
    assert.ok(start.jobId);

    const status = await waitForJobDone(baseUrl, start.jobId);

    assert.equal(status.status, 'done');
    assert.equal(status.total, 5);
    assert.equal(status.done, 5);
    assert.equal(status.ready, 4);
    assert.equal(status.failed, 1);
    assert.equal(status.downloadReady, true);
    assert.equal(status.failedRows.length, 1);
    assert.equal(status.failedRows[0].itemName, 'Invalid');
    assert.equal(status.errorSummary.total, 1);
    assert.match(status.failedCsv, /Invalid/);

    const downloadRes = await fetch(`${baseUrl}${status.downloadUrl}`);
    const zipBuffer = Buffer.from(await downloadRes.arrayBuffer());
    const zipEntries = listZipEntries(zipBuffer);
    const imageEntries = zipEntries.filter((entry) => !['report.txt', 'failed_rows.csv'].includes(entry));

    assert.equal(downloadRes.status, 200);
    assert.equal(zipBuffer.subarray(0, 2).toString('ascii'), 'PK');
    assert.equal(imageEntries.length, 4);
    assert.ok(zipEntries.includes('report.txt'));
    assert.ok(zipEntries.includes('failed_rows.csv'));
  } finally {
    await closeServer(imageServer);
    await stopProcess(app, appOutput);
  }
});

function startImageServer() {
  const server = http.createServer((req, res) => {
    if (/^\/image-\d+\.png$/.test(req.url || '')) {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': PNG_1X1.length,
      });
      res.end(PNG_1X1);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('missing image');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
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

function listZipEntries(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];

  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);

    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;

    entries.push(buffer.toString('utf8', nameStart, nameEnd));
    offset = nameEnd + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(buffer) {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }

  throw new Error('ZIP end of central directory not found');
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
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

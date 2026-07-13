const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const sharp = require('sharp');

const { downloadImage } = require('../src/downloader');
const { buildZip } = require('../src/zipBuilder');
const {
  processOutputImage,
  normalizeOutputImageMode,
  OUTPUT_IMAGE_MODES,
  OUTPUT_RESIZE_SIZE,
} = require('../src/imageProcessor');

const ROOT_DIR = path.resolve(__dirname, '..');

test('Original output image mode preserves the current image buffer', async () => {
  const input = await createImage(320, 240, 'png');
  const result = await processOutputImage(input, {
    outputImageMode: OUTPUT_IMAGE_MODES.ORIGINAL,
    contentType: 'image/png',
  });

  assert.equal(result.outputImageMode, OUTPUT_IMAGE_MODES.ORIGINAL);
  assert.equal(result.method, 'original');
  assert.equal(result.contentType, 'image/png');
  assert.deepEqual(result.buffer, input);
  assert.equal(result.width, 320);
  assert.equal(result.height, 240);
});

test('Resize output image mode enlarges small images to exactly 2016 x 1512', async () => {
  const input = await createImage(120, 90, 'jpeg');
  const result = await processOutputImage(input, {
    outputImageMode: OUTPUT_IMAGE_MODES.RESIZE_2016_1512,
    contentType: 'image/jpeg',
  });

  await assertOutputSize(result);
  assert.equal(result.contentType, 'image/jpeg');
  assert.equal(result.method, 'resize-2016x1512');
});

test('Resize output image mode resizes large images to exactly 2016 x 1512', async () => {
  const input = await createImage(4800, 3200, 'jpeg');
  const result = await processOutputImage(input, {
    outputImageMode: OUTPUT_IMAGE_MODES.RESIZE_2016_1512,
    contentType: 'image/jpeg',
  });

  await assertOutputSize(result);
});

test('Resize output image mode keeps the configured 4:3 output aspect ratio', async () => {
  const input = await createImage(900, 1600, 'jpeg');
  const result = await processOutputImage(input, {
    outputImageMode: OUTPUT_IMAGE_MODES.RESIZE_2016_1512,
    contentType: 'image/jpeg',
  });
  const metadata = await sharp(result.buffer).metadata();

  assert.equal(metadata.width * OUTPUT_RESIZE_SIZE.height, metadata.height * OUTPUT_RESIZE_SIZE.width);
});

test('Output image mode files can still be written into a ZIP archive', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'piccatch-output-mode-'));
  try {
    const resized = await processOutputImage(await createImage(640, 480, 'jpeg'), {
      outputImageMode: OUTPUT_IMAGE_MODES.RESIZE_2016_1512,
      contentType: 'image/jpeg',
    });
    const imagePath = path.join(tempDir, 'merchant-item.jpg');
    const zipPath = path.join(tempDir, 'merchant-images.zip');

    await fsp.writeFile(imagePath, resized.buffer);
    await buildZip({
      zipPath,
      entries: [{ filePath: imagePath, filename: 'merchant-item.jpg' }],
      reportText: 'Output image mode test report',
    });

    const zipBuffer = await fsp.readFile(zipPath);
    const entries = listZipEntries(zipBuffer);

    assert.equal(zipBuffer.subarray(0, 2).toString('ascii'), 'PK');
    assert.deepEqual(entries.sort(), ['merchant-item.jpg', 'report.txt']);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('Output image mode remains backward compatible when omitted or unknown', () => {
  assert.equal(normalizeOutputImageMode(), OUTPUT_IMAGE_MODES.ORIGINAL);
  assert.equal(normalizeOutputImageMode(''), OUTPUT_IMAGE_MODES.ORIGINAL);
  assert.equal(normalizeOutputImageMode('unknown-future-mode'), OUTPUT_IMAGE_MODES.ORIGINAL);
  assert.equal(normalizeOutputImageMode('resize_2016x1512'), OUTPUT_IMAGE_MODES.RESIZE_2016_1512);
});

test('downloaded output pipeline keeps original dimensions or resizes based on selected mode', async () => {
  const source = await createImage(420, 300, 'jpeg');
  const imageServer = await startImageServer(source, 'image/jpeg');

  try {
    const imageUrl = `http://127.0.0.1:${imageServer.address().port}/source.jpg`;
    const downloaded = await downloadImage(imageUrl, {
      retries: 0,
      browserFallback: false,
      preserveOriginal: true,
    });

    const original = await processOutputImage(downloaded.buffer, {
      outputImageMode: OUTPUT_IMAGE_MODES.ORIGINAL,
      contentType: downloaded.contentType,
      sourceUrl: downloaded.finalUrl,
    });
    const resized = await processOutputImage(downloaded.buffer, {
      outputImageMode: OUTPUT_IMAGE_MODES.RESIZE_2016_1512,
      contentType: downloaded.contentType,
      sourceUrl: downloaded.finalUrl,
    });

    const originalMeta = await sharp(original.buffer).metadata();
    const resizedMeta = await sharp(resized.buffer).metadata();

    assert.equal(originalMeta.width, 420);
    assert.equal(originalMeta.height, 300);
    assert.equal(resizedMeta.width, OUTPUT_RESIZE_SIZE.width);
    assert.equal(resizedMeta.height, OUTPUT_RESIZE_SIZE.height);
    assert.equal(resized.returnedOriginal, false);
  } finally {
    await closeServer(imageServer);
  }
});

test('Resize output mode fails loudly instead of falling back to original bytes', async () => {
  await assert.rejects(
    processOutputImage(Buffer.from('not an image'), {
      outputImageMode: OUTPUT_IMAGE_MODES.RESIZE_2016_1512,
      contentType: 'image/jpeg',
    }),
    /output resize failed/
  );
});

test('Frontend and backend wire Output Image Mode through existing settings payload', () => {
  const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'public/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(ROOT_DIR, 'public/app.js'), 'utf8');
  const serverJs = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf8');

  assert.match(indexHtml, /Output Image Mode/);
  assert.match(indexHtml, /name="outputImageMode"/);
  assert.match(indexHtml, /value="original"/);
  assert.match(indexHtml, /value="resize_2016x1512"/);
  assert.match(indexHtml, /output-mode-button is-selected/);
  assert.match(appJs, /outputImageMode:\s*getOutputImageMode\(\)/);
  assert.match(appJs, /syncOutputModeUI/);
  assert.match(serverJs, /outputImageMode:\s*normalizeOutputImageMode/);
  assert.match(serverJs, /preserveOriginal:\s*true/);
  assert.match(serverJs, /processOutputImage\(result\.buffer/);
  assert.match(serverJs, /output=resized/);
  assert.match(serverJs, /output=original/);
  assert.match(serverJs, /const ext = resizedOutput \? 'jpg'/);
});

async function createImage(width, height, format) {
  const image = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 34, g: 154, b: 168 },
    },
  });

  return format === 'png'
    ? image.png().toBuffer()
    : image.jpeg({ quality: 92 }).toBuffer();
}

function startImageServer(buffer, contentType) {
  const server = http.createServer((req, res) => {
    if (req.url === '/source.jpg') {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': buffer.length,
        Connection: 'close',
      });
      res.end(buffer);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain', Connection: 'close' });
    res.end('missing');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
    server.closeIdleConnections?.();
    const forceCloseTimer = setTimeout(() => {
      server.closeAllConnections?.();
    }, 250);
    forceCloseTimer.unref?.();
  });
}

async function assertOutputSize(result) {
  const metadata = await sharp(result.buffer).metadata();
  assert.equal(metadata.width, OUTPUT_RESIZE_SIZE.width);
  assert.equal(metadata.height, OUTPUT_RESIZE_SIZE.height);
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

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

test('Resize output image mode frames common product shapes without cropping', async () => {
  const shapes = [
    { name: 'bag', canvasWidth: 900, canvasHeight: 1600, productWidth: 520, productHeight: 1180 },
    { name: 'bottle', canvasWidth: 800, canvasHeight: 1600, productWidth: 300, productHeight: 1200 },
    { name: 'can', canvasWidth: 1000, canvasHeight: 1500, productWidth: 560, productHeight: 1100 },
    { name: 'box', canvasWidth: 1400, canvasHeight: 1100, productWidth: 1000, productHeight: 760 },
    { name: 'jar', canvasWidth: 1200, canvasHeight: 1200, productWidth: 780, productHeight: 900 },
  ];

  for (const shape of shapes) {
    const input = await createMarkedProductOnWhiteCanvas(shape);
    const result = await processOutputImage(input, {
      outputImageMode: OUTPUT_IMAGE_MODES.RESIZE_2016_1512,
      contentType: 'image/png',
    });

    await assertOutputSize(result);
    const { data, info } = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });
    assertFramedProduct(data, info, shape.name);
  }
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

async function createMarkedProductOnWhiteCanvas(shape) {
  const {
    canvasWidth,
    canvasHeight,
    productWidth,
    productHeight,
  } = shape;
  const bandHeight = Math.max(36, Math.round(productHeight * 0.1));
  const product = await sharp({
    create: {
      width: productWidth,
      height: productHeight,
      channels: 3,
      background: { r: 34, g: 154, b: 168 },
    },
  })
    .composite([
      {
        input: await createSolidImage(productWidth, bandHeight, { r: 235, g: 38, b: 38 }),
        left: 0,
        top: 0,
      },
      {
        input: await createSolidImage(productWidth, bandHeight, { r: 37, g: 99, b: 235 }),
        left: 0,
        top: productHeight - bandHeight,
      },
    ])
    .png()
    .toBuffer();

  return sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      {
        input: product,
        left: Math.round((canvasWidth - productWidth) / 2),
        top: Math.round((canvasHeight - productHeight) / 2),
      },
    ])
    .png()
    .toBuffer();
}

async function createSolidImage(width, height, background) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background,
    },
  })
    .png()
    .toBuffer();
}

function assertFramedProduct(data, info, label) {
  const bounds = detectNonWhiteBounds(data, info);
  assert(bounds, `${label}: product bounds should be detected`);

  const productHeightRatio = bounds.height / info.height;
  assert(
    productHeightRatio >= 0.74 && productHeightRatio <= 0.81,
    `${label}: expected product to occupy 74-81% of canvas height, got ${productHeightRatio}`
  );

  const topMargin = bounds.top;
  const bottomMargin = info.height - bounds.bottom - 1;
  const leftMargin = bounds.left;
  const rightMargin = info.width - bounds.right - 1;
  assert(Math.abs(topMargin - bottomMargin) <= 14, `${label}: vertical margins should be balanced`);
  assert(Math.abs(leftMargin - rightMargin) <= 14, `${label}: horizontal margins should be balanced`);
  assert(topMargin > 80 && bottomMargin > 80, `${label}: vertical padding should be visible`);
  assert(leftMargin > 40 && rightMargin > 40, `${label}: horizontal padding should be visible`);

  const centerX = Math.round((bounds.left + bounds.right) / 2);
  const centerY = Math.round((bounds.top + bounds.bottom) / 2);
  assertColor(pixelAt(data, info, centerX, bounds.top + 18), { red: true }, `${label}: top marker should remain visible`);
  assertColor(pixelAt(data, info, centerX, bounds.bottom - 18), { blue: true }, `${label}: bottom marker should remain visible`);
  assertColor(pixelAt(data, info, centerX, Math.max(4, Math.floor(topMargin / 2))), { white: true }, `${label}: top padding should be white`);
  assertColor(pixelAt(data, info, Math.max(4, Math.floor(leftMargin / 2)), centerY), { white: true }, `${label}: side padding should be white`);
}

function detectNonWhiteBounds(data, info) {
  const channels = info.channels || 3;
  let left = info.width;
  let right = -1;
  let top = info.height;
  let bottom = -1;
  const thresholdSquared = 26 * 26;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * channels;
      const dr = 255 - data[offset];
      const dg = 255 - data[offset + 1];
      const db = 255 - data[offset + 2];
      if ((dr * dr + dg * dg + db * db) <= thresholdSquared) continue;

      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }

  if (right < left || bottom < top) return null;
  return {
    left,
    right,
    top,
    bottom,
    width: right - left + 1,
    height: bottom - top + 1,
  };
}

function pixelAt(data, info, x, y) {
  const channels = info.channels || 3;
  const offset = (Math.max(0, Math.min(info.height - 1, y)) * info.width + Math.max(0, Math.min(info.width - 1, x))) * channels;
  return {
    r: data[offset],
    g: data[offset + 1],
    b: data[offset + 2],
  };
}

function assertColor(pixel, expectation, message) {
  if (expectation.red) {
    assert(pixel.r > 170 && pixel.g < 95 && pixel.b < 95, `${message}: expected red, got ${JSON.stringify(pixel)}`);
  }
  if (expectation.blue) {
    assert(pixel.b > 150 && pixel.r < 110 && pixel.g < 140, `${message}: expected blue, got ${JSON.stringify(pixel)}`);
  }
  if (expectation.white) {
    assert(pixel.r > 235 && pixel.g > 235 && pixel.b > 235, `${message}: expected white, got ${JSON.stringify(pixel)}`);
  }
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

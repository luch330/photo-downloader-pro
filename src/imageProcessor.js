const { Buffer } = require('buffer');
const os = require('os');

const OUTPUT_IMAGE_MODES = Object.freeze({
  ORIGINAL: 'original',
  RESIZE_2016_1512: 'resize_2016x1512',
});

const OUTPUT_RESIZE_SIZE = Object.freeze({
  width: 2016,
  height: 1512,
});

const OUTPUT_RESIZE_BACKGROUND = '#ffffff';
const OUTPUT_PRODUCT_FRAME = Object.freeze({
  width: Math.round(OUTPUT_RESIZE_SIZE.width * 0.9),
  height: Math.round(OUTPUT_RESIZE_SIZE.height * 0.78),
  left: Math.floor((OUTPUT_RESIZE_SIZE.width - Math.round(OUTPUT_RESIZE_SIZE.width * 0.9)) / 2),
  right: Math.ceil((OUTPUT_RESIZE_SIZE.width - Math.round(OUTPUT_RESIZE_SIZE.width * 0.9)) / 2),
  top: Math.floor((OUTPUT_RESIZE_SIZE.height - Math.round(OUTPUT_RESIZE_SIZE.height * 0.78)) / 2),
  bottom: Math.ceil((OUTPUT_RESIZE_SIZE.height - Math.round(OUTPUT_RESIZE_SIZE.height * 0.78)) / 2),
});
const FOREGROUND_DISTANCE_THRESHOLD = 18;
const FOREGROUND_PADDING_RATIO = 0.01;

let sharp = null;
try {
  sharp = require('sharp');
  sharp.cache({ memory: 64, files: 0, items: 128 });
  sharp.concurrency(Math.max(1, Math.min(4, os.cpus().length || 1)));
} catch {
  sharp = null;
}

async function normalizeImage(buffer, options = {}) {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!input.length) {
    throw new Error('empty image buffer');
  }

  const contentType = String(options.contentType || '');
  const sourceUrl = String(options.sourceUrl || '');
  const maxSide = clampInt(options.maxSide, 256, 8000, 3000);
  const quality = clampInt(options.quality, 50, 100, 92);

  if (!sharp) {
    return {
      buffer: input,
      contentType: guessContentTypeFromBuffer(input, contentType, sourceUrl),
      method: 'original',
    };
  }

  try {
    const density = isSvgLike(contentType, sourceUrl, input) ? 300 : 72;

    let pipeline = sharp(input, {
      failOnError: false,
      density,
      limitInputPixels: 12000 * 12000,
      sequentialRead: true,
    }).rotate();

    pipeline = pipeline.flatten({ background: '#ffffff' });

    if (maxSide > 0) {
      pipeline = pipeline.resize({
        width: maxSide,
        height: maxSide,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    const jpegBuffer = await pipeline
      .jpeg({
        quality,
        mozjpeg: true,
        progressive: true,
      })
      .toBuffer();

    return {
      buffer: jpegBuffer,
      contentType: 'image/jpeg',
      method: 'jpeg',
    };
  } catch {
    return {
      buffer: input,
      contentType: guessContentTypeFromBuffer(input, contentType, sourceUrl),
      method: 'original',
    };
  }
}

async function processOutputImage(buffer, options = {}) {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!input.length) {
    throw new Error('empty image buffer');
  }

  const mode = normalizeOutputImageMode(options.outputImageMode);
  const contentType = String(options.contentType || '');
  const sourceUrl = String(options.sourceUrl || '');

  if (mode === OUTPUT_IMAGE_MODES.ORIGINAL) {
    const dimensions = await readImageDimensions(input, { contentType, sourceUrl });
    return {
      buffer: input,
      contentType: guessContentTypeFromBuffer(input, contentType, sourceUrl),
      method: 'original',
      outputImageMode: OUTPUT_IMAGE_MODES.ORIGINAL,
      width: dimensions.width,
      height: dimensions.height,
      returnedOriginal: true,
    };
  }

  return resizeTo2016x1512(input, {
    contentType,
    sourceUrl,
  });
}

async function resizeTo2016x1512(buffer, options = {}) {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!input.length) {
    throw new Error('empty image buffer');
  }
  if (!sharp) {
    throw new Error('Sharp is required for Resize to 2016 x 1512 output mode.');
  }

  const contentType = String(options.contentType || '');
  const sourceUrl = String(options.sourceUrl || '');

  try {
    const dimensions = await readImageDimensions(input, { contentType, sourceUrl });
    const density = isSvgLike(contentType, sourceUrl, input) ? 300 : 72;
    const prepared = await prepareProductResizeInput(input, { density });
    const jpegBuffer = await sharp(prepared.buffer, {
      failOnError: false,
      limitInputPixels: 16000 * 16000,
      sequentialRead: true,
    })
      .resize({
        width: OUTPUT_PRODUCT_FRAME.width,
        height: OUTPUT_PRODUCT_FRAME.height,
        fit: 'contain',
        position: 'center',
        background: OUTPUT_RESIZE_BACKGROUND,
        kernel: sharp.kernel.lanczos3,
        withoutEnlargement: false,
      })
      .extend({
        top: OUTPUT_PRODUCT_FRAME.top,
        bottom: OUTPUT_PRODUCT_FRAME.bottom,
        left: OUTPUT_PRODUCT_FRAME.left,
        right: OUTPUT_PRODUCT_FRAME.right,
        background: OUTPUT_RESIZE_BACKGROUND,
      })
      .withMetadata()
      .jpeg({
        quality: 95,
        progressive: true,
        chromaSubsampling: '4:4:4',
      })
      .toBuffer();

    return {
      buffer: jpegBuffer,
      contentType: 'image/jpeg',
      method: 'resize-2016x1512',
      outputImageMode: OUTPUT_IMAGE_MODES.RESIZE_2016_1512,
      width: OUTPUT_RESIZE_SIZE.width,
      height: OUTPUT_RESIZE_SIZE.height,
      originalWidth: dimensions.width,
      originalHeight: dimensions.height,
      returnedOriginal: false,
    };
  } catch (err) {
    throw new Error(`output resize failed: ${err?.message || err}`);
  }
}

async function prepareProductResizeInput(input, options = {}) {
  const base = sharp(input, {
    failOnError: false,
    density: options.density || 72,
    limitInputPixels: 16000 * 16000,
    sequentialRead: true,
  })
    .rotate()
    .flatten({ background: OUTPUT_RESIZE_BACKGROUND })
    .toColorspace('srgb');

  const { data, info } = await base.clone().raw().toBuffer({ resolveWithObject: true });
  const fullBuffer = await base.clone().png().toBuffer();
  const bounds = detectForegroundBounds(data, info);

  if (!bounds) {
    return { buffer: fullBuffer, bounds: null };
  }

  const padding = Math.max(4, Math.round(Math.max(info.width, info.height) * FOREGROUND_PADDING_RATIO));
  const expanded = expandBounds(bounds, info.width, info.height, padding);

  if (boundsCoverMostImage(expanded, info)) {
    return { buffer: fullBuffer, bounds: expanded };
  }

  const width = expanded.right - expanded.left + 1;
  const height = expanded.bottom - expanded.top + 1;
  const buffer = await sharp(fullBuffer, {
    failOnError: false,
    sequentialRead: true,
  })
    .extract({
      left: expanded.left,
      top: expanded.top,
      width,
      height,
    })
    .png()
    .toBuffer();

  return { buffer, bounds: expanded };
}

function detectForegroundBounds(data, info) {
  const width = Number(info.width || 0);
  const height = Number(info.height || 0);
  const channels = Number(info.channels || 3);
  if (!width || !height || !data?.length) return null;

  const background = estimateBackgroundColor(data, info);
  const rowCounts = new Uint32Array(height);
  const colCounts = new Uint32Array(width);
  const thresholdSquared = FOREGROUND_DISTANCE_THRESHOLD * FOREGROUND_DISTANCE_THRESHOLD;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      const dr = data[offset] - background.r;
      const dg = data[offset + 1] - background.g;
      const db = data[offset + 2] - background.b;
      if ((dr * dr + dg * dg + db * db) > thresholdSquared) {
        rowCounts[y] += 1;
        colCounts[x] += 1;
      }
    }
  }

  const minRowPixels = Math.max(3, Math.floor(width * 0.003));
  const minColPixels = Math.max(3, Math.floor(height * 0.003));
  const top = firstIndexAtLeast(rowCounts, minRowPixels);
  const bottom = lastIndexAtLeast(rowCounts, minRowPixels);
  const left = firstIndexAtLeast(colCounts, minColPixels);
  const right = lastIndexAtLeast(colCounts, minColPixels);

  if (top === -1 || bottom === -1 || left === -1 || right === -1 || right <= left || bottom <= top) {
    return null;
  }

  return { left, top, right, bottom };
}

function estimateBackgroundColor(data, info) {
  const width = Number(info.width || 0);
  const height = Number(info.height || 0);
  const channels = Number(info.channels || 3);
  const sampleSize = Math.max(4, Math.min(24, Math.floor(Math.min(width, height) * 0.04)));
  const corners = [
    [0, 0],
    [Math.max(0, width - sampleSize), 0],
    [0, Math.max(0, height - sampleSize)],
    [Math.max(0, width - sampleSize), Math.max(0, height - sampleSize)],
  ];
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (const [startX, startY] of corners) {
    for (let y = startY; y < Math.min(height, startY + sampleSize); y += 1) {
      for (let x = startX; x < Math.min(width, startX + sampleSize); x += 1) {
        const offset = (y * width + x) * channels;
        r += data[offset];
        g += data[offset + 1];
        b += data[offset + 2];
        count += 1;
      }
    }
  }

  if (!count) return { r: 255, g: 255, b: 255 };
  return {
    r: Math.round(r / count),
    g: Math.round(g / count),
    b: Math.round(b / count),
  };
}

function expandBounds(bounds, width, height, padding) {
  return {
    left: Math.max(0, bounds.left - padding),
    top: Math.max(0, bounds.top - padding),
    right: Math.min(width - 1, bounds.right + padding),
    bottom: Math.min(height - 1, bounds.bottom + padding),
  };
}

function boundsCoverMostImage(bounds, info) {
  const width = Number(info.width || 0);
  const height = Number(info.height || 0);
  if (!width || !height) return true;

  const boundsWidth = bounds.right - bounds.left + 1;
  const boundsHeight = bounds.bottom - bounds.top + 1;
  return boundsWidth >= width * 0.97 && boundsHeight >= height * 0.97;
}

function firstIndexAtLeast(values, minimum) {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] >= minimum) return index;
  }
  return -1;
}

function lastIndexAtLeast(values, minimum) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] >= minimum) return index;
  }
  return -1;
}

function normalizeOutputImageMode(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (
    normalized === OUTPUT_IMAGE_MODES.RESIZE_2016_1512 ||
    normalized === 'resize_to_2016x1512' ||
    normalized === 'resize_to_2016_1512' ||
    normalized === '2016x1512'
  ) {
    return OUTPUT_IMAGE_MODES.RESIZE_2016_1512;
  }

  return OUTPUT_IMAGE_MODES.ORIGINAL;
}

async function readImageDimensions(buffer, options = {}) {
  if (!sharp) return { width: null, height: null };

  try {
    const density = isSvgLike(options.contentType, options.sourceUrl, buffer) ? 300 : 72;
    const metadata = await sharp(buffer, {
      failOnError: false,
      density,
      limitInputPixels: 16000 * 16000,
      sequentialRead: true,
    }).metadata();

    return {
      width: Number.isFinite(metadata.width) ? metadata.width : null,
      height: Number.isFinite(metadata.height) ? metadata.height : null,
    };
  } catch {
    return { width: null, height: null };
  }
}

function isSvgLike(contentType, sourceUrl, buffer) {
  const ct = String(contentType || '').toLowerCase();
  const url = String(sourceUrl || '').toLowerCase();

  if (ct.includes('image/svg') || url.endsWith('.svg')) {
    return true;
  }

  const sample = Buffer.isBuffer(buffer)
    ? buffer.toString('utf8', 0, Math.min(buffer.length, 512)).toLowerCase()
    : '';

  return sample.includes('<svg');
}

function guessContentTypeFromBuffer(buffer, contentType, sourceUrl) {
  const ct = String(contentType || '').toLowerCase();
  const url = String(sourceUrl || '').toLowerCase();

  if (ct.includes('image/jpeg') || ct.includes('image/jpg') || url.endsWith('.jpg') || url.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (ct.includes('image/png') || url.endsWith('.png')) return 'image/png';
  if (ct.includes('image/gif') || url.endsWith('.gif')) return 'image/gif';
  if (ct.includes('image/webp') || url.endsWith('.webp')) return 'image/webp';
  if (ct.includes('image/bmp') || url.endsWith('.bmp')) return 'image/bmp';
  if (ct.includes('image/svg') || url.endsWith('.svg')) return 'image/svg+xml';
  if (ct.includes('image/avif') || url.endsWith('.avif')) return 'image/avif';
  if (ct.includes('image/heic') || url.endsWith('.heic')) return 'image/heic';
  if (ct.includes('image/heif') || url.endsWith('.heif')) return 'image/heif';
  if (ct.includes('image/tiff') || ct.includes('image/tif') || url.endsWith('.tiff') || url.endsWith('.tif')) return 'image/tiff';
  if (ct.includes('image/x-icon') || ct.includes('image/vnd.microsoft.icon') || url.endsWith('.ico')) return 'image/x-icon';

  if (buffer && buffer.length) {
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer.length >= 8 && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
    if (buffer.length >= 6) {
      const head = buffer.subarray(0, 6).toString('ascii');
      if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
    }
    if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
    if (
      buffer.length >= 4 &&
      ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
        (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a) ||
        (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2b && buffer[3] === 0x00))
    ) {
      return 'image/tiff';
    }
    if (buffer.length >= 4 && buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) {
      return 'image/x-icon';
    }
    if (buffer.length >= 12) {
      const head = buffer.subarray(0, 12).toString('ascii');
      if (head.startsWith('RIFF') && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
      if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
        const brands = buffer.subarray(8, Math.min(buffer.length, 64)).toString('ascii');
        if (brands.includes('avif') || brands.includes('avis')) return 'image/avif';
        if (/(heic|heix|hevc|hevx)/.test(brands)) return 'image/heic';
        if (/(mif1|msf1)/.test(brands)) return 'image/heif';
      }
    }
    const sample = buffer.toString('utf8', 0, Math.min(buffer.length, 512)).toLowerCase();
    if (sample.includes('<svg')) return 'image/svg+xml';
  }

  return contentType || 'application/octet-stream';
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

module.exports = {
  normalizeImage,
  processOutputImage,
  resizeTo2016x1512,
  normalizeOutputImageMode,
  readImageDimensions,
  OUTPUT_IMAGE_MODES,
  OUTPUT_RESIZE_SIZE,
};

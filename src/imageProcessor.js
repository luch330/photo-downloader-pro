const { Buffer } = require('buffer');
const os = require('os');

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
};

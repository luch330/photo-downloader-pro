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

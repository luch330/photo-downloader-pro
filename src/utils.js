function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFileName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120);
}

function uniqueName(base, ext, used) {
  const cleanBase = base || 'file';
  let candidate = cleanBase;
  let count = 2;
  let key = `${candidate.toLowerCase()}.${ext}`;
  while (used[key]) {
    candidate = `${cleanBase}_${count}`;
    count += 1;
    key = `${candidate.toLowerCase()}.${ext}`;
  }
  used[key] = true;
  return `${candidate}.${ext}`;
}

function isImageContentType(contentType) {
  return String(contentType || '').toLowerCase().startsWith('image/');
}

function detectExtension(buffer, contentType, url) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('bmp')) return 'bmp';
  if (ct.includes('tiff') || ct.includes('tif')) return 'tiff';
  if (ct.includes('svg')) return 'svg';

  if (Buffer.isBuffer(buffer)) {
    if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg';
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    const head = buffer.subarray(0, 16).toString('utf8').toLowerCase();
    if (head.includes('webp')) return 'webp';
    if (head.includes('<svg')) return 'svg';
  }

  const clean = String(url || '').split('?')[0].split('#')[0];
  const match = clean.match(/\.([a-zA-Z0-9]{2,5})$/);
  if (match) {
    const ext = match[1].toLowerCase();
    if (ext === 'jpeg') return 'jpg';
    if (['jpg', 'png', 'webp', 'gif', 'bmp', 'svg'].includes(ext)) return ext;
    if (['tif', 'tiff'].includes(ext)) return 'tiff';
  }
  return '';
}

function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDuration(ms) {
  const s = Math.max(0, Math.round((Number(ms || 0)) / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

module.exports = {
  sleep,
  sanitizeFileName,
  uniqueName,
  isImageContentType,
  detectExtension,
  getOrigin,
  formatBytes,
  formatDuration,
};

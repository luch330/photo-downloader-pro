const path = require('path');

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / Math.pow(1024, idx);

  return `${value >= 10 || idx === 0 ? Math.round(value) : value.toFixed(1)} ${units[idx]}`;
}

function formatDuration(ms) {
  const totalMs = Number(ms);
  if (!Number.isFinite(totalMs) || totalMs < 0) return '—';

  const totalSeconds = Math.round(totalMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins) parts.push(`${mins}m`);
  if (!parts.length || secs) parts.push(`${secs}s`);

  return parts.join(' ');
}

function sanitizeFileName(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';

  return raw
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/\.+/g, '.')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .trim()
    .slice(0, 180);
}

function detectExtension(buffer, contentType, sourceUrl) {
  const ct = String(contentType || '').toLowerCase();
  const url = String(sourceUrl || '').toLowerCase();

  const extFromUrl = extFromSource(url);
  if (extFromUrl) return extFromUrl;

  if (ct.includes('image/jpeg') || ct.includes('image/jpg')) return 'jpg';
  if (ct.includes('image/png')) return 'png';
  if (ct.includes('image/gif')) return 'gif';
  if (ct.includes('image/webp')) return 'webp';
  if (ct.includes('image/bmp')) return 'bmp';
  if (ct.includes('image/svg')) return 'svg';
  if (ct.includes('image/tiff')) return 'tiff';
  if (ct.includes('image/avif')) return 'avif';
  if (ct.includes('image/heic')) return 'heic';
  if (ct.includes('image/heif')) return 'heif';
  if (ct.includes('image/x-icon') || ct.includes('image/vnd.microsoft.icon')) return 'ico';

  if (buffer && buffer.length) {
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
    if (buffer.length >= 8 && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'png';
    if (buffer.length >= 6) {
      const head = buffer.subarray(0, 6).toString('ascii');
      if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
    }
    if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'bmp';
    if (
      buffer.length >= 4 &&
      ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
        (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a) ||
        (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2b && buffer[3] === 0x00))
    ) {
      return 'tiff';
    }
    if (buffer.length >= 4 && buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) {
      return 'ico';
    }
    if (buffer.length >= 12) {
      const head = buffer.subarray(0, 12).toString('ascii');
      if (head.startsWith('RIFF') && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
      if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
        const brands = buffer.subarray(8, Math.min(buffer.length, 64)).toString('ascii');
        if (brands.includes('avif') || brands.includes('avis')) return 'avif';
        if (/(heic|heix|hevc|hevx)/.test(brands)) return 'heic';
        if (/(mif1|msf1)/.test(brands)) return 'heif';
      }
    }

    const sample = buffer.toString('utf8', 0, Math.min(buffer.length, 512)).toLowerCase();
    if (sample.includes('<svg')) return 'svg';
  }

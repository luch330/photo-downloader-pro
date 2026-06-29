const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const archiver = require('archiver');

async function buildZip({ zipPath, entries = [], reportText = '', failedCsv = '' }) {
  await fsp.mkdir(path.dirname(zipPath), { recursive: true });

  return new Promise((resolve, reject) => {
    let settled = false;
    let entryCount = 0;
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', {
      zlib: { level: 6 },
    });

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        archive.destroy();
      } catch {
        // ignore destroy races
      }
      reject(err);
    };

    output.on('close', () => {
      if (settled) return;
      settled = true;
      resolve({
        bytes: archive.pointer(),
        entries: entryCount,
      });
    });
    output.on('error', fail);
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        return;
      }
      fail(err);
    });
    archive.on('error', fail);
    archive.on('entry', () => {
      entryCount += 1;
    });

    archive.pipe(output);

    for (const entry of entries) {
      if (!entry || !entry.filePath) continue;
      const filename = String(entry.filename || path.basename(entry.filePath));
      archive.file(entry.filePath, { name: filename });
    }

    if (reportText) {
      archive.append(reportText, { name: 'report.txt' });
    }

    if (failedCsv && String(failedCsv).trim()) {
      archive.append(failedCsv, { name: 'failed_rows.csv' });
    }

    archive.finalize().catch(fail);
  });
}

module.exports = {
  buildZip,
};

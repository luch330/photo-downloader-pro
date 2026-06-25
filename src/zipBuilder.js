const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const archiver = require('archiver');

async function buildZip({ zipPath, entries = [], reportText = '', failedCsv = '' }) {
  await fsp.mkdir(path.dirname(zipPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', {
      zlib: { level: 9 },
    });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        return;
      }
      reject(err);
    });
    archive.on('error', reject);

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

    archive.finalize().catch(reject);
  });
}

module.exports = {
  buildZip,
};

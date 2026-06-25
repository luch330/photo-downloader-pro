const fs = require('fs');
const archiver = require('archiver');

async function buildZip({ zipPath, entries = [], reportText = '', failedCsv = '' }) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') return;
      reject(err);
    });
    archive.on('error', reject);

    archive.pipe(output);

    for (const entry of entries) {
      if (entry && entry.filePath && entry.filename) {
        archive.file(entry.filePath, { name: entry.filename });
      }
    }

    if (reportText) archive.append(reportText, { name: 'report.txt' });
    if (failedCsv) archive.append(failedCsv, { name: 'failed_rows.csv' });

    archive.finalize();
  });
}

module.exports = { buildZip };

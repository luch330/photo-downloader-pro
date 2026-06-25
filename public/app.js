const fileInput = document.getElementById('fileInput');
const dropzone = document.getElementById('dropzone');
const chooseBtn = document.getElementById('chooseBtn');
const runBtn = document.getElementById('runBtn');
const refererInput = document.getElementById('refererInput');
const timeoutInput = document.getElementById('timeoutInput');
const retryInput = document.getElementById('retryInput');
const concurrencyInput = document.getElementById('concurrencyInput');
const browserFallbackInput = document.getElementById('browserFallbackInput');
const fileNameEl = document.getElementById('fileName');
const rowsCountEl = document.getElementById('rowsCount');
const okCountEl = document.getElementById('okCount');
const errCountEl = document.getElementById('errCount');
const currentItemEl = document.getElementById('currentItem');
const zipSizeEl = document.getElementById('zipSize');
const progressText = document.getElementById('progressText');
const etaText = document.getElementById('etaText');
const barEl = document.getElementById('bar');
const previewWrap = document.getElementById('previewWrap');
const logWrap = document.getElementById('logWrap');
const statusEl = document.getElementById('status');
const downloadBtn = document.getElementById('downloadBtn');
const advancedSettings = document.querySelector('.advanced-settings');

const SETTINGS_KEY = 'photo-downloader-settings';
const MODE_PRESETS = {
  fast: {
    label: 'Fast',
    timeoutInput: '20',
    retryInput: '1',
    concurrencyInput: '8',
    browserFallbackInput: true,
  },
  balanced: {
    label: 'Balanced',
    timeoutInput: '45',
    retryInput: '2',
    concurrencyInput: '4',
    browserFallbackInput: true,
  },
  safe: {
    label: 'Safe',
    timeoutInput: '90',
    retryInput: '3',
    concurrencyInput: '2',
    browserFallbackInput: true,
  },
};

let selectedFile = null;
let parsedRows = [];
let jobId = null;
let startedAt = 0;
let pollTimer = null;
let autoDownloaded = false;
let currentMode = 'balanced';
let modeButtons = {};
let modeLabelEl = null;
let customModeHintEl = null;

loadSavedSettings();
initModeControls();

chooseBtn.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('click', (e) => {
  const interactive = e.target.closest('button, input, select, textarea, label, summary, a');
  if (interactive) return;
  fileInput.click();
});

if (advancedSettings) {
  advancedSettings.addEventListener('click', (e) => {
    e.stopPropagation();
  });
}

[
  refererInput,
  timeoutInput,
  retryInput,
  concurrencyInput,
  browserFallbackInput,
].forEach((el) => {
  el.addEventListener('change', () => {
    refreshModeFromInputs();
    saveCurrentSettings();
  });

  el.addEventListener('input', () => {
    refreshModeFromInputs();
    saveCurrentSettings();
  });
});

fileInput.addEventListener('change', () => {
  if (fileInput.files && fileInput.files[0]) {
    loadFile(fileInput.files[0]);
  }
});

['dragenter', 'dragover'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.remove('dragover');
  });
});

dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  selectedFile = file;
  fileInput.files = e.dataTransfer.files;
  fileNameEl.textContent = selectedFile.name;
  setStatus('File selected. Ready to start.', 'info');
  runBtn.disabled = false;
});

runBtn.addEventListener('click', startUpload);

function initModeControls() {
  if (!advancedSettings) return;

  const settingsGrid = advancedSettings.querySelector('.settings-grid');
  if (!settingsGrid) return;

  const modeSection = document.createElement('div');
  modeSection.className = 'mode-section';
  modeSection.style.cssText = `
    padding: 14px 16px 0;
    border-top: 1px solid rgba(216, 226, 238, 0.75);
    margin-top: 6px;
  `;

  modeSection.innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
      <div>
        <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#52657a;margin-bottom:6px;">Mode</div>
        <div style="font-size:13px;color:#64748b;font-weight:600;">Choose a preset or customize the values below.</div>
      </div>
      <div id="modeLabel" style="display:inline-flex;align-items:center;justify-content:center;border:1px solid rgba(0,183,195,0.24);background:rgba(0,183,195,0.10);color:#0094a3;font-size:12px;font-weight:900;border-radius:999px;padding:8px 12px;white-space:nowrap;">Balanced</div>
    </div>
  `;

  const buttonsWrap = document.createElement('div');
  buttonsWrap.style.cssText = `
    display:flex;
    flex-wrap:wrap;
    gap:8px;
    margin-bottom:14px;
  `;

  const buttons = [
    { key: 'fast', label: 'Fast' },
    { key: 'balanced', label: 'Balanced' },
    { key: 'safe', label: 'Safe' },
  ];

  buttons.forEach(({ key, label }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.mode = key;
    btn.textContent = label;
    btn.style.cssText = `
      appearance:none;
      border:1px solid rgba(198, 211, 228, 0.95);
      background:#f8fbff;
      color:#334155;
      font-size:13px;
      font-weight:900;
      border-radius:999px;
      padding:9px 14px;
      cursor:pointer;
      box-shadow:0 6px 14px rgba(15,23,42,0.03);
      transition:transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
    `;

    btn.addEventListener('mouseenter', () => {
      if (btn.dataset.mode !== currentMode) {
        btn.style.transform = 'translateY(-1px)';
      }
    });

    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'translateY(0)';
    });

    btn.addEventListener('click', () => applyMode(key, true));

    buttonsWrap.appendChild(btn);
    modeButtons[key] = btn;
  });

  customModeHintEl = document.createElement('div');
  customModeHintEl.style.cssText = `
    margin-top: 2px;
    margin-bottom: 12px;
    font-size: 12px;
    color:#64748b;
    line-height:1.45;
    font-weight:600;
  `;
  customModeHintEl.textContent = 'Manual edits will switch the mode to Custom automatically.';

  modeSection.appendChild(buttonsWrap);
  modeSection.appendChild(customModeHintEl);

  advancedSettings.insertBefore(modeSection, settingsGrid);

  modeLabelEl = modeSection.querySelector('#modeLabel');
  updateModeUI();
  if (MODE_PRESETS[currentMode]) {
    applyMode(currentMode, false);
  } else {
    refreshModeFromInputs(false);
  }
}

function applyMode(mode, persist = true) {
  const preset = MODE_PRESETS[mode];
  if (!preset) return;

  currentMode = mode;
  timeoutInput.value = preset.timeoutInput;
  retryInput.value = preset.retryInput;
  concurrencyInput.value = preset.concurrencyInput;
  browserFallbackInput.checked = preset.browserFallbackInput;

  updateModeUI();

  if (persist) {
    saveCurrentSettings();
  }
}

function refreshModeFromInputs(persist = true) {
  const matched = Object.keys(MODE_PRESETS).find((mode) => {
    const preset = MODE_PRESETS[mode];
    return (
      String(timeoutInput.value || '') === preset.timeoutInput &&
      String(retryInput.value || '') === preset.retryInput &&
      String(concurrencyInput.value || '') === preset.concurrencyInput &&
      Boolean(browserFallbackInput.checked) === Boolean(preset.browserFallbackInput)
    );
  });

  currentMode = matched || 'custom';
  updateModeUI();

  if (persist) {
    saveCurrentSettings();
  }
}

function updateModeUI() {
  Object.entries(modeButtons).forEach(([mode, btn]) => {
    const isActive = mode === currentMode;
    btn.style.background = isActive
      ? 'linear-gradient(135deg, #00b7c3, #0094a3)'
      : '#f8fbff';
    btn.style.color = isActive ? '#ffffff' : '#334155';
    btn.style.borderColor = isActive ? 'transparent' : 'rgba(198, 211, 228, 0.95)';
    btn.style.boxShadow = isActive
      ? '0 12px 20px rgba(0, 183, 195, 0.20)'
      : '0 6px 14px rgba(15,23,42,0.03)';
    btn.setAttribute('aria-pressed', String(isActive));
  });

  if (modeLabelEl) {
    modeLabelEl.textContent = currentMode === 'custom'
      ? 'Custom'
      : (MODE_PRESETS[currentMode]?.label || 'Custom');
  }

  if (customModeHintEl) {
    customModeHintEl.textContent =
      currentMode === 'custom'
        ? 'Custom values are active.'
        : 'Manual edits will switch the mode to Custom automatically.';
  }
}

async function loadFile(file) {
  selectedFile = file;
  fileNameEl.textContent = file.name;
  setStatus('Reading Excel file...', 'info');
  setProgress(10, 'Reading...');
  downloadBtn.style.display = 'none';
  downloadBtn.href = '#';
  zipSizeEl.textContent = '—';
  logWrap.textContent = 'Reading Excel file...';
  previewWrap.innerHTML = '<div class="small">Loading preview...</div>';
  runBtn.disabled = true;

  saveCurrentSettings();

  try {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    parsedRows = raw
      .map((r) => [String(r[0] || '').trim(), String(r[1] || '').trim()])
      .filter((r) => r[0] || r[1]);

    const dataRows = parsedRows.slice(1);
    rowsCountEl.textContent = String(dataRows.length);
    okCountEl.textContent = '0';
    errCountEl.textContent = '0';
    currentItemEl.textContent = '—';
    renderPreview(parsedRows);
    setProgress(30, 'Preview ready');

    if (!dataRows.length) {
      setStatus('The file has a header row but no data rows.', 'error');
      runBtn.disabled = true;
      return;
    }

    setStatus(
      'File loaded. Първият ред се използва като заглавие. Качи файла, а ние ще се погрижим за останалото.',
      'success'
    );
    runBtn.disabled = false;
  } catch (err) {
    parsedRows = [];
    rowsCountEl.textContent = '—';
    previewWrap.innerHTML = '<div class="small">Upload a file to see the first rows.</div>';
    setStatus('Error reading Excel: ' + err.message, 'error');
    setProgress(0, '0%');
    runBtn.disabled = true;
  }
}

function renderPreview(rows) {
  const visible = rows.slice(0, 6);
  if (!visible.length) {
    previewWrap.innerHTML = '<div class="small">No preview rows available.</div>';
    return;
  }

  const header = visible[0];
  let html =
    '<table class="preview-table"><thead><tr><th>' +
    escapeHtml(header[0] || 'Item') +
    '</th><th>' +
    escapeHtml(header[1] || 'URL') +
    '</th></tr></thead><tbody>';

  visible.slice(1).forEach((r) => {
    html +=
      '<tr><td>' +
      escapeHtml(r[0] || '') +
      '</td><td class="preview-url">' +
      escapeHtml(r[1] || '') +
      '</td></tr>';
  });

  html += '</tbody></table>';

  if (rows.length > 6) {
    html += '<div class="small" style="margin-top:8px;">Showing the first 5 rows after the header.</div>';
  }

  previewWrap.innerHTML = html;
}

async function startUpload() {
  if (!selectedFile || !parsedRows.length) return;

  autoDownloaded = false;
  jobId = null;
  startedAt = Date.now();
  downloadBtn.style.display = 'none';
  downloadBtn.href = '#';
  setStatus('Uploading and processing...', 'info');
  setProgress(5, 'Uploading...');
  logWrap.textContent = 'Starting...';
  currentItemEl.textContent = '—';
  runBtn.disabled = true;

  saveCurrentSettings();

  const payload = {
    fileName: selectedFile.name,
    rows: parsedRows,
    referer: refererInput.value.trim(),
    settings: {
      timeoutMs: Number(timeoutInput.value || 45) * 1000,
      retries: Number(retryInput.value || 2),
      concurrency: Number(concurrencyInput.value || 4),
      browserFallback: browserFallbackInput.checked,
    },
  };

  try {
    const res = await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.message || 'Upload failed');

    jobId = data.jobId;
    pollStatus();
  } catch (err) {
    setStatus('Upload error: ' + err.message, 'error');
    setProgress(0, '0%');
    runBtn.disabled = false;
  }
}

function pollStatus() {
  if (!jobId) return;

  fetch('/api/status/' + jobId)
    .then((r) => r.json())
    .then((data) => {
      if (!data.ok) throw new Error(data.message || 'Status error');
      renderStatus(data);

      if (data.status === 'done') {
        zipSizeEl.textContent = data.zipSizeText || data.downloadName || 'ready';
        setStatus('ZIP file is ready.', 'success');
        setProgress(100, '100%');
        downloadBtn.href = data.downloadUrl;
        downloadBtn.style.display = 'inline-flex';
        downloadBtn.textContent = 'Download ZIP';

        if (!autoDownloaded) {
          autoDownloaded = true;
          downloadBtn.click();
        }

        runBtn.disabled = false;
        clearTimeout(pollTimer);
        return;
      }

      if (data.status === 'error') {
        setStatus(data.error || 'Processing failed.', 'error');
        setProgress(0, '0%');
        runBtn.disabled = false;
        clearTimeout(pollTimer);
        return;
      }

      pollTimer = setTimeout(pollStatus, 1000);
    })
    .catch((err) => {
      setStatus('Status error: ' + err.message, 'error');
      runBtn.disabled = false;
      clearTimeout(pollTimer);
    });
}

function renderStatus(data) {
  fileNameEl.textContent = data.fileName || '—';
  rowsCountEl.textContent = String(data.total ?? '—');
  okCountEl.textContent = String(data.ready ?? '—');
  errCountEl.textContent = String(data.failed ?? '—');
  currentItemEl.textContent = data.current || '—';

  const progress = Number(data.progress || 0);
  const done = Number(data.done || 0);
  const total = Number(data.total || 0);
  setProgress(progress, `Downloading ${done} / ${total}`);

  if (startedAt && progress > 0 && progress < 100) {
    const elapsed = (Date.now() - startedAt) / 1000;
    const remaining = (elapsed * (100 - progress)) / progress;
    etaText.textContent = 'ETA: ' + formatDuration(remaining);
  } else if (progress >= 100) {
    etaText.textContent = 'ETA: done';
  } else {
    etaText.textContent = 'ETA: —';
  }

  if (Array.isArray(data.preview) && data.preview.length) {
    previewWrap.innerHTML = renderPreviewTable(data.preview);
  }

  if (Array.isArray(data.logs) && data.logs.length) {
    logWrap.textContent = data.logs.join('\n');
    logWrap.scrollTop = logWrap.scrollHeight;
  }

  if (data.downloadReady && data.downloadUrl) {
    zipSizeEl.textContent = data.zipSizeText || data.downloadName || 'ready';
  }
}

function renderPreviewTable(rows) {
  const visible = rows.slice(0, 6);
  if (!visible.length) return '<div class="small">No preview rows available.</div>';

  let html = '<table class="preview-table"><tbody>';
  visible.forEach((r, idx) => {
    const a = escapeHtml(r[0] || '');
    const b = escapeHtml(r[1] || '');
    if (idx === 0) html += '<tr><th>' + a + '</th><th>' + b + '</th></tr>';
    else html += '<tr><td>' + a + '</td><td class="preview-url">' + b + '</td></tr>';
  });
  html += '</tbody></table>';
  return html;
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.classList.remove('ok', 'err');
  if (kind === 'success') statusEl.classList.add('ok');
  if (kind === 'error') statusEl.classList.add('err');
}

function setProgress(value, label) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  barEl.style.width = v + '%';
  progressText.textContent = label || (v + '%');
}

function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

function loadSavedSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');

    if (saved.refererInput !== undefined) refererInput.value = saved.refererInput;
    if (saved.timeoutInput !== undefined) timeoutInput.value = saved.timeoutInput;
    if (saved.retryInput !== undefined) retryInput.value = saved.retryInput;
    if (saved.concurrencyInput !== undefined) concurrencyInput.value = saved.concurrencyInput;
    if (saved.browserFallbackInput !== undefined) browserFallbackInput.checked = saved.browserFallbackInput;

    if (saved.mode && (saved.mode === 'fast' || saved.mode === 'balanced' || saved.mode === 'safe' || saved.mode === 'custom')) {
      currentMode = saved.mode;
    }
  } catch (err) {
    console.warn('Could not load saved settings:', err);
  }
}

function saveCurrentSettings() {
  try {
    const payload = {
      refererInput: refererInput.value,
      timeoutInput: timeoutInput.value,
      retryInput: retryInput.value,
      concurrencyInput: concurrencyInput.value,
      browserFallbackInput: browserFallbackInput.checked,
      mode: currentMode,
    };

    localStorage.setItem(SETTINGS_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn('Could not save settings:', err);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

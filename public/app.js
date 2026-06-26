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
const estimatedFinishEl = document.getElementById('estimatedFinish');
const progressText = document.getElementById('progressText');
const etaText = document.getElementById('etaText');
const barEl = document.getElementById('bar');
const previewWrap = document.getElementById('previewWrap');
const logWrap = document.getElementById('logWrap');
const statusEl = document.getElementById('status');
const downloadBtn = document.getElementById('downloadBtn');
const modeBadge = document.getElementById('modeBadge');
const settingsBtn = document.getElementById('settingsBtn');
const themeBtn = document.getElementById('themeBtn');
const settingsModal = document.getElementById('settingsModal');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const resetSettingsBtn = document.getElementById('resetSettingsBtn');
const modeCards = Array.from(document.querySelectorAll('[data-mode]'));
const modeLabelEl = document.getElementById('modeLabel');
const customModeHintEl = document.getElementById('customModeHint');
const columnHint = document.getElementById('columnHint');
const errorSummaryCard = document.getElementById('errorSummaryCard');
const errorSummaryGrid = document.getElementById('errorSummaryGrid');
const errorSummaryHelp = document.getElementById('errorSummaryHelp');
const retryFailedBtn = document.getElementById('retryFailedBtn');
const viewErrorsBtn = document.getElementById('viewErrorsBtn');
const successScreen = document.getElementById('successScreen');
const successDownloadBtn = document.getElementById('successDownloadBtn');
const successRetryBtn = document.getElementById('successRetryBtn');
const closeSuccessBtn = document.getElementById('closeSuccessBtn');
const successImages = document.getElementById('successImages');
const successErrors = document.getElementById('successErrors');
const successZipSize = document.getElementById('successZipSize');
const successFinish = document.getElementById('successFinish');

const SETTINGS_KEY = 'photo-downloader-settings';
const THEME_KEY = 'photo-downloader-theme';

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

const TIMELINE_STEPS = [
  { key: 'upload', label: 'Upload', detail: 'Pick an Excel file' },
  { key: 'read', label: 'Read Excel', detail: 'Parse rows' },
  { key: 'detect', label: 'Auto-detect', detail: 'Map columns' },
  { key: 'download', label: 'Download', detail: 'Fetch images' },
  { key: 'normalize', label: 'Normalize', detail: 'Process formats' },
  { key: 'zip', label: 'Build ZIP', detail: 'Package files' },
  { key: 'done', label: 'Done', detail: 'ZIP ready' },
];

let selectedFile = null;
let parsedRows = [];
let originalRows = [];
let jobId = null;
let startedAt = 0;
let pollTimer = null;
let autoDownloaded = false;
let currentMode = 'balanced';
let lastFailedRows = [];
let lastErrorSummary = null;
let detectedColumns = null;
let lastStatusSnapshot = null;
let lastSample = null;
let smoothedSpeed = 0;
let dashboardRefs = {};
let dashboardReady = false;

injectEnhancementStyles();
createFloatingBackground();
setupDashboardShell();

loadTheme();
loadSavedSettings();
refreshModeFromInputs(false);
updateModeUI();
renderErrorSummary({
  total: 0,
  forbidden: 0,
  unauthorized: 0,
  notFound: 0,
  timeout: 0,
  nonImage: 0,
  other: 0,
});
renderTimeline('idle', 'Ready');
updateDashboardMetrics({
  fileName: '—',
  rows: 0,
  ready: 0,
  failed: 0,
  speed: 0,
  avgMs: 0,
  eta: '—',
  progress: 0,
  stage: 'idle',
});

chooseBtn?.addEventListener('click', () => fileInput.click());
settingsBtn?.addEventListener('click', openSettings);
themeBtn?.addEventListener('click', toggleTheme);

if (modeBadge) {
  modeBadge.classList.add('mode-badge-static');
  modeBadge.setAttribute('aria-disabled', 'true');
  modeBadge.tabIndex = -1;
}

dropzone?.addEventListener('click', (e) => {
  const interactive = e.target.closest('button, input, select, textarea, label, summary, a');
  if (interactive) return;
  fileInput.click();
});

dropzone?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});

fileInput?.addEventListener('change', () => {
  if (fileInput.files && fileInput.files[0]) {
    loadFile(fileInput.files[0]);
  }
});

['dragenter', 'dragover'].forEach((evt) => {
  dropzone?.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.add('dragover');
    document.body.classList.add('is-dragging');
  });
});

['dragleave', 'drop'].forEach((evt) => {
  dropzone?.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.remove('dragover');
    document.body.classList.remove('is-dragging');
  });
});

dropzone?.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  selectedFile = file;
  fileInput.files = e.dataTransfer.files;
  fileNameEl.textContent = selectedFile.name;
  setStatus('File selected. Ready to start.', 'info');
  runBtn.disabled = false;
});

runBtn?.addEventListener('click', startUpload);
retryFailedBtn?.addEventListener('click', retryFailed);
successRetryBtn?.addEventListener('click', retryFailed);
viewErrorsBtn?.addEventListener('click', () => {
  if (errorSummaryCard) {
    errorSummaryCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});
closeSuccessBtn?.addEventListener('click', closeSuccess);
successScreen?.addEventListener('click', (e) => {
  if (e.target === successScreen) closeSuccess();
});
settingsModal?.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeSettings();
});
closeSettingsBtn?.addEventListener('click', closeSettings);
saveSettingsBtn?.addEventListener('click', () => {
  saveCurrentSettings();
  closeSettings();
});
resetSettingsBtn?.addEventListener('click', () => {
  applyMode('balanced', true);
  saveCurrentSettings();
});
modeCards.forEach((btn) => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode;
    applyMode(mode, true);
  });
});

[
  refererInput,
  timeoutInput,
  retryInput,
  concurrencyInput,
  browserFallbackInput,
].forEach((el) => {
  el.addEventListener('change', () => {
    refreshModeFromInputs(true);
    saveCurrentSettings();
  });

  el.addEventListener('input', () => {
    refreshModeFromInputs(true);
    saveCurrentSettings();
  });
});

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    fileInput.click();
    return;
  }

  if (mod && e.key === 'Enter') {
    e.preventDefault();
    if (!runBtn.disabled) startUpload();
    return;
  }

  if (e.key === 'Escape') {
    if (!settingsModal.hidden) {
      closeSettings();
      return;
    }
    if (!successScreen.hidden) {
      closeSuccess();
    }
  }
});

function injectEnhancementStyles() {
  if (document.getElementById('ui-enhancements')) return;

  const style = document.createElement('style');
  style.id = 'ui-enhancements';
  style.textContent = `
    body { overflow-x: hidden; }
    body::after {
      content: "";
      position: fixed;
      inset: -20%;
      pointer-events: none;
      background:
        radial-gradient(circle at 18% 20%, rgba(0, 183, 195, 0.14), transparent 0 16%),
        radial-gradient(circle at 82% 18%, rgba(47, 128, 255, 0.12), transparent 0 14%),
        radial-gradient(circle at 70% 82%, rgba(124, 58, 237, 0.08), transparent 0 16%);
      filter: blur(24px);
      opacity: .8;
      animation: bgFloat 24s linear infinite;
      z-index: 0;
    }
    .layout {
      grid-template-columns: 1fr !important;
      align-items: start !important;
    }
    .panel-right {
      margin-top: 20px;
    }
    .panel-right.is-dashboard {
      padding-top: 10px;
    }
    .dashboard-board {
      display: grid;
      gap: 14px;
      margin-bottom: 16px;
    }
    .dashboard-hero {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      border-radius: 22px;
      padding: 14px 16px;
      border: 1px solid rgba(148, 163, 184, 0.22);
      background: linear-gradient(135deg, rgba(0, 183, 195, 0.10), rgba(47, 128, 255, 0.07));
    }
    .dashboard-hero h3 {
      margin: 4px 0 4px;
      font-size: 18px;
      line-height: 1.15;
      letter-spacing: -.04em;
      font-weight: 900;
    }
    .dashboard-hero p {
      margin: 0;
      color: var(--text-muted);
      font-size: 13px;
      line-height: 1.55;
      font-weight: 600;
      max-width: 660px;
    }
    .dashboard-badge {
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid rgba(0, 183, 195, 0.22);
      background: rgba(255,255,255,.55);
      color: var(--brand-2);
      font-size: 12px;
      font-weight: 900;
      white-space: nowrap;
      box-shadow: var(--shadow-sm);
    }
    body.theme-dark .dashboard-badge {
      background: rgba(17, 26, 43, 0.72);
    }
    .dashboard-metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }
    .dash-card {
      border-radius: 18px;
      padding: 14px;
      border: 1px solid var(--line);
      background:
        linear-gradient(180deg, rgba(255,255,255,0.86), rgba(255,255,255,0.70)),
        var(--surface-solid);
      box-shadow: var(--shadow-sm);
      overflow: hidden;
    }
    body.theme-dark .dash-card {
      background:
        linear-gradient(180deg, rgba(17, 26, 43, 0.98), rgba(17, 26, 43, 0.90)),
        var(--surface-solid);
    }
    .dash-card-label {
      display: block;
      margin-bottom: 6px;
      font-size: 11px;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: var(--text-muted);
      font-weight: 900;
    }
    .dash-card-value {
      display: block;
      font-size: 24px;
      line-height: 1.1;
      letter-spacing: -.04em;
      font-weight: 900;
      color: var(--text);
    }
    .dash-card-sub {
      margin-top: 6px;
      font-size: 12px;
      line-height: 1.5;
      color: var(--text-muted);
      font-weight: 600;
    }
    .timeline-card {
      border-radius: 22px;
      padding: 14px 16px;
      border: 1px solid var(--line);
      background:
        linear-gradient(180deg, rgba(255,255,255,0.86), rgba(255,255,255,0.70)),
        var(--surface-solid);
      box-shadow: var(--shadow-sm);
    }
    body.theme-dark .timeline-card {
      background:
        linear-gradient(180deg, rgba(17, 26, 43, 0.98), rgba(17, 26, 43, 0.90)),
        var(--surface-solid);
    }
    .timeline-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 12px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .08em;
      font-weight: 900;
      color: var(--text-muted);
    }
    .timeline {
      display: grid;
      gap: 10px;
    }
    .timeline-step {
      display: grid;
      grid-template-columns: 24px 1fr auto;
      gap: 10px;
      align-items: center;
      border-radius: 16px;
      padding: 10px 12px;
      border: 1px solid transparent;
      background: rgba(148, 163, 184, 0.06);
    }
    .timeline-step .dot {
      width: 14px;
      height: 14px;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.35);
      box-shadow: 0 0 0 6px rgba(148, 163, 184, 0.08);
    }
    .timeline-step .label {
      font-size: 13px;
      font-weight: 800;
      color: var(--text);
      letter-spacing: -.01em;
    }
    .timeline-step .detail {
      font-size: 12px;
      color: var(--text-muted);
      font-weight: 600;
    }
    .timeline-step.is-active {
      border-color: rgba(0, 183, 195, 0.24);
      background: linear-gradient(135deg, rgba(0,183,195,.10), rgba(47,128,255,.06));
    }
    .timeline-step.is-active .dot {
      background: linear-gradient(135deg, var(--brand), var(--brand-2));
      box-shadow: 0 0 0 6px rgba(0, 183, 195, 0.10);
      animation: pulseDot 1.2s ease-in-out infinite;
    }
    .timeline-step.is-done .dot {
      background: linear-gradient(135deg, #16a34a, #22c55e);
      box-shadow: 0 0 0 6px rgba(34, 197, 94, 0.10);
    }
    .timeline-step.is-done .label {
      color: var(--text-soft);
    }
    .timeline-step.is-error {
      border-color: rgba(239, 68, 68, 0.22);
      background: rgba(239, 68, 68, 0.07);
    }
    .timeline-step.is-error .dot {
      background: linear-gradient(135deg, #ef4444, #f97316);
      box-shadow: 0 0 0 6px rgba(239, 68, 68, 0.12);
    }
    .mode-badge-static {
      cursor: default !important;
      pointer-events: none !important;
      user-select: none !important;
    }
    .mode-badge-static:hover {
      transform: none !important;
      box-shadow: var(--shadow-sm) !important;
    }
    body.is-dragging .dropzone {
      transform: scale(1.01);
      box-shadow: 0 18px 40px rgba(0, 183, 195, 0.16);
    }
    body.is-dragging .dropzone::before {
      opacity: .7;
    }
    .mini-glow {
      position: fixed;
      width: 340px;
      height: 340px;
      border-radius: 999px;
      pointer-events: none;
      filter: blur(24px);
      opacity: .5;
      z-index: 0;
      animation: drift 18s ease-in-out infinite;
    }
    .mini-glow.one { left: -110px; top: 12%; background: rgba(0,183,195,.16); }
    .mini-glow.two { right: -120px; top: 26%; background: rgba(47,128,255,.12); animation-delay: -7s; }
    .mini-glow.three { left: 24%; bottom: -130px; background: rgba(124,58,237,.10); animation-delay: -12s; }
    .metric-up {
      animation: metricPop 260ms ease;
    }
    .flash {
      animation: flashBg 500ms ease;
    }
    @keyframes bgFloat {
      0% { transform: translate3d(0,0,0) scale(1); }
      50% { transform: translate3d(12px,-18px,0) scale(1.02); }
      100% { transform: translate3d(0,0,0) scale(1); }
    }
    @keyframes drift {
      0%,100% { transform: translateY(0) translateX(0); }
      50% { transform: translateY(-18px) translateX(16px); }
    }
    @keyframes pulseDot {
      0%,100% { transform: scale(1); }
      50% { transform: scale(1.12); }
    }
    @keyframes metricPop {
      0% { transform: translateY(2px) scale(.98); opacity: .6; }
      100% { transform: translateY(0) scale(1); opacity: 1; }
    }
    @keyframes flashBg {
      0% { box-shadow: 0 0 0 0 rgba(0,183,195,.0); }
      40% { box-shadow: 0 0 0 8px rgba(0,183,195,.10); }
      100% { box-shadow: 0 0 0 0 rgba(0,183,195,.0); }
    }
    @media (max-width: 1100px) {
      .dashboard-metrics { grid-template-columns: repeat(2, minmax(0,1fr)); }
    }
    @media (max-width: 720px) {
      .dashboard-metrics { grid-template-columns: 1fr; }
    }
  `;
  document.head.appendChild(style);
}

function createFloatingBackground() {
  ['one', 'two', 'three'].forEach((cls) => {
    if (document.querySelector(`.mini-glow.${cls}`)) return;
    const el = document.createElement('div');
    el.className = `mini-glow ${cls}`;
    document.body.appendChild(el);
  });
}

function setupDashboardShell() {
  if (dashboardReady) return;

  const layout = document.querySelector('.layout');
  const leftPanel = document.querySelector('.panel-left') || document.querySelector('.panel:first-child');
  const rightPanel = document.querySelector('.panel-right') || document.querySelector('.panel:last-child');

  if (!layout || !leftPanel || !rightPanel) return;

  layout.classList.add('dashboard-shell');

  if (leftPanel.parentElement === layout && rightPanel.parentElement === layout) {
    layout.appendChild(leftPanel);
    layout.appendChild(rightPanel);
  }

  rightPanel.classList.add('is-dashboard');

  const board = document.createElement('section');
  board.className = 'dashboard-board';
  board.innerHTML = `
    <div class="dashboard-hero">
      <div>
        <div class="eyebrow">Live dashboard</div>
        <h3>Processing telemetry</h3>
        <p>Live counters, ETA, download speed, and a timeline update as the job runs.</p>
      </div>
      <div class="dashboard-badge" data-dashboard-mode>Balanced</div>
    </div>

    <div class="dashboard-metrics">
      <div class="dash-card">
        <span class="dash-card-label">Images / sec</span>
        <span class="dash-card-value" data-dash="speed">0.0</span>
        <div class="dash-card-sub" data-dash-sub="speed">Waiting for job start</div>
      </div>
      <div class="dash-card">
        <span class="dash-card-label">Average latency</span>
        <span class="dash-card-value" data-dash="avg">0 ms</span>
        <div class="dash-card-sub" data-dash-sub="avg">Per processed image</div>
      </div>
      <div class="dash-card">
        <span class="dash-card-label">Remaining</span>
        <span class="dash-card-value" data-dash="remaining">—</span>
        <div class="dash-card-sub" data-dash-sub="remaining">Estimated finish time available below</div>
      </div>
      <div class="dash-card">
        <span class="dash-card-label">Progress</span>
        <span class="dash-card-value" data-dash="progress">0%</span>
        <div class="dash-card-sub" data-dash-sub="progress">Pipeline progress</div>
      </div>
    </div>

    <div class="timeline-card">
      <div class="timeline-title">
        <span>Processing timeline</span>
        <span class="overview-badge">Realtime</span>
      </div>
      <div class="timeline" data-timeline></div>
    </div>
  `;

  rightPanel.insertBefore(board, rightPanel.firstChild);

  dashboardRefs = {
    root: board,
    mode: board.querySelector('[data-dashboard-mode]'),
    speed: board.querySelector('[data-dash="speed"]'),
    avg: board.querySelector('[data-dash="avg"]'),
    remaining: board.querySelector('[data-dash="remaining"]'),
    progress: board.querySelector('[data-dash="progress"]'),
    speedSub: board.querySelector('[data-dash-sub="speed"]'),
    avgSub: board.querySelector('[data-dash-sub="avg"]'),
    remainingSub: board.querySelector('[data-dash-sub="remaining"]'),
    progressSub: board.querySelector('[data-dash-sub="progress"]'),
    timeline: board.querySelector('[data-timeline]'),
  };

  dashboardReady = true;
  renderTimeline('idle', 'Ready');
}

function openSettings() {
  settingsModal.hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => refererInput?.focus(), 30);
}

function closeSettings() {
  settingsModal.hidden = true;
  document.body.style.overflow = '';
}

function openSuccess() {
  successScreen.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeSuccess() {
  successScreen.hidden = true;
  document.body.style.overflow = '';
}
function toggleTheme() {
  const isDark = !document.body.classList.contains('theme-dark');
  setTheme(isDark);
  saveTheme();
}

function setTheme(isDark) {
  document.body.classList.toggle('theme-dark', isDark);
  if (themeBtn) {
    themeBtn.textContent = isDark ? '☀ Light mode' : '🌙 Dark mode';
  }
}

function loadTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark') {
      setTheme(true);
      return;
    }
    if (saved === 'light') {
      setTheme(false);
      return;
    }
  } catch (err) {
    console.warn('Could not load theme:', err);
  }

  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  setTheme(prefersDark);
}

function saveTheme() {
  try {
    localStorage.setItem(THEME_KEY, document.body.classList.contains('theme-dark') ? 'dark' : 'light');
  } catch (err) {
    console.warn('Could not save theme:', err);
  }
}

function loadSavedSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');

    if (saved.refererInput !== undefined) refererInput.value = saved.refererInput;
    if (saved.timeoutInput !== undefined) timeoutInput.value = saved.timeoutInput;
    if (saved.retryInput !== undefined) retryInput.value = saved.retryInput;
    if (saved.concurrencyInput !== undefined) concurrencyInput.value = saved.concurrencyInput;
    if (saved.browserFallbackInput !== undefined) browserFallbackInput.checked = saved.browserFallbackInput;
    if (saved.mode) currentMode = saved.mode;
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
  modeCards.forEach((btn) => {
    const isActive = btn.dataset.mode === currentMode;
    btn.classList.toggle('active', isActive);
  });

  if (modeLabelEl) {
    modeLabelEl.textContent = currentMode === 'custom'
      ? 'Custom'
      : (MODE_PRESETS[currentMode]?.label || 'Custom');
  }

  if (modeBadge) {
    modeBadge.textContent = currentMode === 'custom'
      ? 'Custom'
      : (MODE_PRESETS[currentMode]?.label || 'Balanced');
  }

  if (dashboardRefs.mode) {
    dashboardRefs.mode.textContent = currentMode === 'custom'
      ? 'Custom'
      : (MODE_PRESETS[currentMode]?.label || 'Balanced');
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
  estimatedFinishEl.textContent = '—';
  logWrap.textContent = 'Reading Excel file...';
  previewWrap.innerHTML = '<div class="small">Loading preview...</div>';
  runBtn.disabled = true;
  detectedColumns = null;
  columnHint.innerHTML = '<span class="mini-chip">Detecting columns…</span>';
  updateTimelineFromPhase('read', 'Parsing workbook...');

  saveCurrentSettings();

  try {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    detectedColumns = detectColumnMapping(raw);
    parsedRows = normalizeRows(raw, detectedColumns);
    originalRows = parsedRows.slice();
    renderColumnHint(detectedColumns);

    const dataRows = parsedRows.slice(1);
    rowsCountEl.textContent = String(dataRows.length);
    okCountEl.textContent = '0';
    errCountEl.textContent = '0';
    currentItemEl.textContent = '—';
    renderPreview(parsedRows);
    setProgress(30, 'Preview ready');
    updateTimelineFromPhase('detect', 'Columns mapped');

    if (!dataRows.length) {
      setStatus('The file has a header row but no data rows.', 'error');
      runBtn.disabled = true;
      return;
    }

    setStatus('File loaded. The first row is used as the header. Upload your file and we will handle the rest.', 'success');
    runBtn.disabled = false;
  } catch (err) {
    parsedRows = [];
    originalRows = [];
    rowsCountEl.textContent = '—';
    previewWrap.innerHTML = '<div class="small">Upload a file to see the first rows.</div>';
    setStatus('Error reading Excel: ' + err.message, 'error');
    setProgress(0, '0%');
    runBtn.disabled = true;
  }
}

function renderColumnHint(mapping) {
  if (!mapping) {
    columnHint.innerHTML = '<span class="mini-chip">Auto-detect ready</span>';
    return;
  }

  const nameLetter = indexToLetter(mapping.nameIndex);
  const urlLetter = indexToLetter(mapping.urlIndex);
  columnHint.innerHTML = `
    <span class="mini-chip">Name: ${escapeHtml(mapping.nameLabel || `Column ${nameLetter}`)} (${nameLetter})</span>
    <span class="mini-chip">URL: ${escapeHtml(mapping.urlLabel || `Column ${urlLetter}`)} (${urlLetter})</span>
  `;
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
  lastFailedRows = [];
  lastErrorSummary = null;
  lastStatusSnapshot = null;
  lastSample = null;
  smoothedSpeed = 0;
  downloadBtn.style.display = 'none';
  downloadBtn.href = '#';
  successDownloadBtn.href = '#';
  successScreen.hidden = true;
  setStatus('Uploading and processing...', 'info');
  setProgress(5, 'Uploading...');
  logWrap.textContent = 'Starting...';
  currentItemEl.textContent = '—';
  retryFailedBtn.disabled = true;
  successRetryBtn.style.display = 'none';
  runBtn.disabled = true;

  updateTimelineFromPhase('upload', 'Uploading workbook...');
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
    updateTimelineFromPhase('download', 'Job queued');
    pollStatus();
  } catch (err) {
    setStatus('Upload error: ' + err.message, 'error');
    setProgress(0, '0%');
    runBtn.disabled = false;
  }
}

function pollStatus() {
  if (!jobId) return;

  fetch('/api/status/' + jobId, { cache: 'no-store' })
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

        successDownloadBtn.href = data.downloadUrl;
        successImages.textContent = String(data.ready ?? '—');
        successErrors.textContent = String(data.failed ?? '—');
        successZipSize.textContent = data.zipSizeText || data.downloadName || 'ready';
        successFinish.textContent = estimatedFinishEl.textContent || '—';

        if (Array.isArray(data.failedRows) && data.failedRows.length) {
          lastFailedRows = normalizeFailedRows(data.failedRows);
          retryFailedBtn.disabled = !lastFailedRows.length;
          successRetryBtn.style.display = lastFailedRows.length ? 'inline-flex' : 'none';
        } else {
          retryFailedBtn.disabled = true;
          successRetryBtn.style.display = 'none';
        }

        updateTimelineFromPhase('done', 'ZIP ready');

        openSuccess();

        if (!autoDownloaded) {
          autoDownloaded = true;
          successDownloadBtn.click();
        }

        runBtn.disabled = false;
        clearTimeout(pollTimer);
        return;
      }

      if (data.status === 'error') {
        setStatus(data.error || 'Processing failed.', 'error');
        setProgress(0, '0%');
        updateTimelineFromPhase('error', data.error || 'Processing failed');
        runBtn.disabled = false;
        clearTimeout(pollTimer);
        return;
      }

      pollTimer = setTimeout(pollStatus, 1000);
    })
    .catch((err) => {
      setStatus('Status error: ' + err.message, 'error');
      updateTimelineFromPhase('error', err.message || 'Status error');
      runBtn.disabled = false;
      clearTimeout(pollTimer);
    });
}

function renderStatus(data) {
  lastStatusSnapshot = data;

  fileNameEl.textContent = data.fileName || '—';
  animateCount(rowsCountEl, Number(data.total ?? 0));
  animateCount(okCountEl, Number(data.ready ?? 0));
  animateCount(errCountEl, Number(data.failed ?? 0));
  currentItemEl.textContent = data.current || '—';

  const progress = Number(data.progress || 0);
  const done = Number(data.done || 0);
  const total = Number(data.total || 0);
  setProgress(progress, `Downloading ${done} / ${total}`);

  const metrics = computeMetrics(data);
  updateDashboardMetrics({
    fileName: data.fileName || '—',
    rows: total,
    ready: Number(data.ready || 0),
    failed: Number(data.failed || 0),
    speed: metrics.speed,
    avgMs: metrics.avgMs,
    eta: metrics.etaText,
    progress,
    stage: data.status,
    current: data.current || '—',
    currentFile: data.current || '—',
  });

  if (startedAt && progress > 0 && progress < 100) {
    const elapsed = (Date.now() - startedAt) / 1000;
    const remaining = metrics.remainingSec ?? ((elapsed * (100 - progress)) / progress);
    const remainingMs = Math.max(0, Math.round(remaining * 1000));
    etaText.textContent = 'ETA: ' + formatDuration(remaining);
    estimatedFinishEl.textContent = formatClockTime(Date.now() + remainingMs);
  } else if (progress >= 100) {
    etaText.textContent = 'ETA: done';
    estimatedFinishEl.textContent = formatClockTime(Date.now());
  } else {
    etaText.textContent = 'ETA: —';
    estimatedFinishEl.textContent = '—';
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

  const summary = deriveErrorSummary(data);
  lastErrorSummary = summary;
  renderErrorSummary(summary);

  if (Array.isArray(data.failedRows) && data.failedRows.length) {
    lastFailedRows = normalizeFailedRows(data.failedRows);
    retryFailedBtn.disabled = !lastFailedRows.length;
    successRetryBtn.style.display = lastFailedRows.length ? 'inline-flex' : 'none';
  } else if (Number(data.failed || 0) > 0) {
    retryFailedBtn.disabled = true;
    successRetryBtn.style.display = 'none';
  }

  updateTimelineFromPhase(data.status === 'done' ? 'done' : 'download', data.current || data.message || 'Processing');
}

function renderErrorSummary(summary) {
  if (!errorSummaryGrid) return;

  if (!summary || summary.total === 0) {
    errorSummaryGrid.innerHTML = '<div class="summary-empty">No error summary yet.</div>';
    errorSummaryHelp.textContent = 'This will summarize what failed in the latest run.';
    return;
  }

  const items = [
    ['403 / Forbidden', summary.forbidden || 0],
    ['Timeout', summary.timeout || 0],
    ['404 / Not found', summary.notFound || 0],
    ['Non-image', summary.nonImage || 0],
    ['Other', summary.other || 0],
  ];

  errorSummaryGrid.innerHTML = items
    .map(([label, value]) => `
      <div class="summary-card">
        <span class="summary-kind">${escapeHtml(label)}</span>
        <span class="summary-value" data-count="${Number(value || 0)}">0</span>
      </div>
    `)
    .join('');

  errorSummaryHelp.textContent = `Detected ${summary.total} failed items in the latest run.`;

  errorSummaryGrid.querySelectorAll('.summary-value').forEach((el) => {
    animateCount(el, Number(el.dataset.count || 0));
  });
}

function retryFailed() {
  if (!lastFailedRows.length) {
    setStatus('No failed rows available to retry yet.', 'info');
    return;
  }

  const retryRows = buildRetryRows(lastFailedRows);
  if (!retryRows || retryRows.length < 2) {
    setStatus('Could not prepare retry rows yet.', 'error');
    return;
  }

  parsedRows = retryRows;
  rowsCountEl.textContent = String(retryRows.length - 1);
  runBtn.disabled = false;
  closeSuccess();
  setStatus('Retrying only the failed rows...', 'info');
  startUpload();
}

function buildRetryRows(failedRows) {
  const header = originalRows[0] || ['Item name', 'Image URL'];
  const rows = [header];

  failedRows.forEach((row) => {
    const rowNumber = Number(row.rowNumber || row.excelRow || row.row || 0);
    if (rowNumber >= 2 && originalRows[rowNumber - 1]) {
      rows.push(originalRows[rowNumber - 1]);
      return;
    }

    if (row.itemName || row.imageUrl) {
      rows.push([row.itemName || '', row.imageUrl || '']);
    }
  });

  return rows;
}

function normalizeFailedRows(rows) {
  if (!Array.isArray(rows)) return [];

  return rows
    .map((row) => {
      if (Array.isArray(row)) {
        return {
          rowNumber: Number(row[0] || 0),
          itemName: String(row[1] || ''),
          imageUrl: String(row[2] || ''),
          error: String(row[3] || ''),
          method: String(row[4] || ''),
        };
      }

      if (row && typeof row === 'object') {
        return {
          rowNumber: Number(row.rowNumber || row.excelRow || row.row || 0),
          itemName: String(row.itemName || row.name || ''),
          imageUrl: String(row.imageUrl || row.url || ''),
          error: String(row.error || row.message || ''),
          method: String(row.method || ''),
        };
      }

      return null;
    })
    .filter(Boolean);
}

function deriveErrorSummary(data) {
  const lines = [];

  if (Array.isArray(data?.logs)) lines.push(...data.logs);
  if (Array.isArray(data?.failedRows)) {
    data.failedRows.forEach((row) => {
      if (Array.isArray(row)) {
        lines.push(`Row ${row[0] || ''}: ${row[3] || ''}`);
      } else if (row && typeof row === 'object') {
        lines.push(`Row ${row.rowNumber || row.excelRow || row.row || ''}: ${row.error || row.message || ''}`);
      }
    });
  }

  if (!lines.length && Number(data?.failed || 0) === 0) {
    return {
      total: 0,
      forbidden: 0,
      unauthorized: 0,
      notFound: 0,
      timeout: 0,
      nonImage: 0,
      other: 0,
    };
  }

  const summary = {
    total: 0,
    forbidden: 0,
    unauthorized: 0,
    notFound: 0,
    timeout: 0,
    nonImage: 0,
    other: 0,
  };

  const seen = lines.filter(Boolean);
  seen.forEach((line) => {
    const text = String(line).toLowerCase();
    if (!text.includes('fail') && !text.includes('error') && !/\b403\b|\b401\b|\b404\b|timeout|html|non-image|blocked|forbidden|not found/.test(text)) {
      return;
    }

    summary.total += 1;

    if (/\b403\b|forbidden/.test(text)) {
      summary.forbidden += 1;
      return;
    }

    if (/\b401\b|unauthorized/.test(text)) {
      summary.unauthorized += 1;
      return;
    }

    if (/\b404\b|not found/.test(text)) {
      summary.notFound += 1;
      return;
    }

    if (/timeout|timed out|etimedout|aborted/.test(text)) {
      summary.timeout += 1;
      return;
    }

    if (/non-image|unsupported content type|blocked content type|text\/html|html response|image not found/.test(text)) {
      summary.nonImage += 1;
      return;
    }

    summary.other += 1;
  });

  if (!summary.total && Number(data?.failed || 0) > 0) {
    summary.total = Number(data.failed || 0);
    summary.other = Number(data.failed || 0);
  }

  return summary;
}

function detectColumnMapping(raw) {
  const rows = Array.isArray(raw) ? raw : [];
  const headers = (rows[0] || []).map((v) => String(v || '').trim());
  const width = rows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), headers.length);

  const nameAliases = [
    'item name', 'product name', 'product', 'name', 'title', 'article', 'article name', 'sku', 'variant', 'item'
  ];
  const urlAliases = [
    'image url', 'image', 'image link', 'photo url', 'photo', 'picture', 'picture url',
    'url', 'link', 'src', 'image src', 'picture link'
  ];

  const nameScores = Array.from({ length: width }, (_, col) => scoreNameCol(rows, headers, col, nameAliases));
  const urlScores = Array.from({ length: width }, (_, col) => scoreUrlCol(rows, headers, col, urlAliases));

  let nameIndex = maxIndex(nameScores);
  let urlIndex = maxIndex(urlScores);

  if (width > 1 && nameIndex === urlIndex) {
    urlIndex = nameIndex === 0 ? 1 : 0;
  }

  const nameLabel = headers[nameIndex] || `Column ${indexToLetter(nameIndex)}`;
  const urlLabel = headers[urlIndex] || `Column ${indexToLetter(urlIndex)}`;

  return { nameIndex, urlIndex, nameLabel, urlLabel };
}

function scoreNameCol(rows, headers, col, aliases) {
  const header = String(headers[col] || '').toLowerCase();
  let score = 0;

  aliases.forEach((alias) => {
    if (header.includes(alias)) score += 10;
  });

  rows.slice(1, 6).forEach((row) => {
    const value = String(row?.[col] || '').trim();
    if (!value) return;
    if (looksLikeUrl(value)) score -= 2;
    else score += 1;
  });

  return score;
}

function scoreUrlCol(rows, headers, col, aliases) {
  const header = String(headers[col] || '').toLowerCase();
  let score = 0;

  aliases.forEach((alias) => {
    if (header.includes(alias)) score += 10;
  });

  rows.slice(1, 10).forEach((row) => {
    const value = String(row?.[col] || '').trim();
    if (!value) return;
    if (looksLikeUrl(value)) score += 3;
    if (/\.(jpg|jpeg|png|webp|gif|bmp|tiff|svg)(\?|#|$)/i.test(value)) score += 2;
  });

  return score;
}

function normalizeRows(raw, mapping) {
  const rows = Array.isArray(raw) ? raw : [];
  const out = [];

  const header = rows[0] || [];
  const headerName = String(header[mapping.nameIndex] || 'Item name').trim() || 'Item name';
  const headerUrl = String(header[mapping.urlIndex] || 'Image URL').trim() || 'Image URL';
  out.push([headerName, headerUrl]);

  rows.slice(1).forEach((row) => {
    const name = String(row?.[mapping.nameIndex] || '').trim();
    const url = String(row?.[mapping.urlIndex] || '').trim();
    if (!name && !url) return;
    out.push([name, url]);
  });

  return out;
}

function looksLikeUrl(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^https?:\/\//.test(text) || text.includes('www.') || /\.(jpg|jpeg|png|webp|gif|bmp|tiff|svg)(\?|#|$)/.test(text);
}

function maxIndex(arr) {
  let bestIndex = 0;
  let bestValue = Number.NEGATIVE_INFINITY;
  arr.forEach((value, index) => {
    if (value > bestValue) {
      bestValue = value;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function indexToLetter(index) {
  const n = Number(index || 0);
  let result = '';
  let x = n + 1;
  while (x > 0) {
    const rem = (x - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    x = Math.floor((x - 1) / 26);
  }
  return result || 'A';
}

function updateTimelineFromPhase(phase, currentText) {
  renderTimeline(phase, currentText);
}

function renderTimeline(phase, currentText) {
  if (!dashboardRefs.timeline) return;

  const phaseOrder = {
    idle: 0,
    upload: 1,
    read: 2,
    detect: 3,
    download: 4,
    normalize: 5,
    zip: 6,
    done: 7,
    error: -1,
  };

  const active = phaseOrder[phase] ?? 0;

  dashboardRefs.timeline.innerHTML = TIMELINE_STEPS.map((step, idx) => {
    const done = active > idx;
    const isActive = active === idx;
    const isError = phase === 'error' && idx >= 3 && idx <= 6;
    return `
      <div class="timeline-step ${done ? 'is-done' : ''} ${isActive ? 'is-active' : ''} ${isError ? 'is-error' : ''}">
        <div class="dot"></div>
        <div>
          <div class="label">${escapeHtml(step.label)}</div>
          <div class="detail">${escapeHtml(step.detail)}</div>
        </div>
        <div class="detail">${isActive && currentText ? escapeHtml(currentText) : done ? 'Complete' : ''}</div>
      </div>
    `;
  }).join('');
}

function computeMetrics(data) {
  const now = Date.now();
  const total = Number(data?.total || 0);
  const done = Number(data?.done || 0);
  const progress = Number(data?.progress || 0);
  const elapsedMs = startedAt ? Math.max(1, now - startedAt) : 1;

  const sample = { t: now, done };
  let instantSpeed = 0;

  if (lastSample) {
    const dt = Math.max(1, (sample.t - lastSample.t)) / 1000;
    const dDone = sample.done - lastSample.done;
    if (dDone > 0 && dt > 0) {
      instantSpeed = dDone / dt;
    }
  }

  lastSample = sample;

  if (instantSpeed > 0) {
    smoothedSpeed = smoothedSpeed ? (smoothedSpeed * 0.68 + instantSpeed * 0.32) : instantSpeed;
  }

  const speed = Number.isFinite(smoothedSpeed) ? smoothedSpeed : 0;
  const avgMs = done > 0 ? elapsedMs / done : 0;
  const remainingSec = speed > 0 ? Math.max(0, (total - done) / speed) : 0;
  const etaTextValue = progress >= 100 ? 'Done' : remainingSec > 0 ? formatDuration(remainingSec) : '—';

  return {
    speed,
    avgMs,
    remainingSec,
    etaText: etaTextValue,
  };
}

function updateDashboardMetrics({ fileName, rows, ready, failed, speed, avgMs, eta, progress, stage, current }) {
  if (!dashboardReady) return;

  setDashValue(dashboardRefs.speed, `${formatNumber(speed, 1)} img/s`);
  setDashSub(dashboardRefs.speedSub, current && stage !== 'done' ? `Now: ${current}` : 'Live throughput');

  setDashValue(dashboardRefs.avg, avgMs ? `${Math.round(avgMs)} ms/img` : '—');
  setDashSub(dashboardRefs.avgSub, 'Average per processed row');

  setDashValue(dashboardRefs.remaining, eta || '—');
  setDashSub(dashboardRefs.remainingSub, stage === 'done' ? 'Completed' : 'Estimated finish');

  setDashValue(dashboardRefs.progress, `${Math.round(progress || 0)}%`);
  setDashSub(dashboardRefs.progressSub, `${ready || 0} ready · ${failed || 0} errors`);

  if (dashboardRefs.mode && currentMode) {
    dashboardRefs.mode.textContent = currentMode === 'custom'
      ? 'Custom'
      : (MODE_PRESETS[currentMode]?.label || 'Balanced');
  }

  flashMetric(dashboardRefs.speed);
  flashMetric(dashboardRefs.avg);
  flashMetric(dashboardRefs.remaining);
  flashMetric(dashboardRefs.progress);
}

function setDashValue(el, value) {
  if (!el) return;
  const next = String(value);
  if (el.textContent !== next) {
    el.textContent = next;
    el.classList.remove('metric-up');
    void el.offsetWidth;
    el.classList.add('metric-up');
  }
}

function setDashSub(el, value) {
  if (!el) return;
  el.textContent = value;
}

function flashMetric(el) {
  if (!el) return;
  const card = el.closest('.dash-card');
  if (!card) return;
  card.classList.remove('flash');
  void card.offsetWidth;
  card.classList.add('flash');
}

function animateCount(el, target) {
  if (!el) return;
  const finalValue = Number.isFinite(target) ? target : 0;
  const start = Number(String(el.textContent || '0').replace(/[^\d.-]/g, '')) || 0;

  if (Math.abs(finalValue - start) < 1) {
    el.textContent = String(Math.round(finalValue));
    return;
  }

  const duration = 450;
  const startTime = performance.now();

  function frame(now) {
    const p = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    const value = start + (finalValue - start) * eased;
    el.textContent = String(Math.round(value));
    if (p < 1) requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

function formatClockTime(ts) {
  if (!Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

function formatNumber(value, digits = 0) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(digits);
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
  barEl.parentElement?.style.setProperty('--progress', `${v}%`);
  progressText.textContent = label || (v + '%');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

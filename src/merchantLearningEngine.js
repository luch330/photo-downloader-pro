const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_VERSION = 1;
const MAX_HOSTS = 500;
const MAX_HINTS_PER_HOST = 40;

class MerchantLearningEngine {
  constructor(options = {}) {
    this.cachePath = options.cachePath === false
      ? ''
      : String(options.cachePath || process.env.PICCATCH_LEARNING_CACHE || path.join(os.tmpdir(), 'piccatch-merchant-learning.json'));
    this.disabled = Boolean(options.disabled || options.cachePath === false);
    this.cache = createEmptyCache();
    this.loaded = false;
  }

  load() {
    if (this.disabled || this.loaded) return this.cache;
    this.loaded = true;

    try {
      if (!this.cachePath || !fs.existsSync(this.cachePath)) return this.cache;
      const parsed = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      this.cache = sanitizeCache(parsed);
    } catch {
      this.cache = createEmptyCache();
    }

    return this.cache;
  }

  save() {
    if (this.disabled || !this.cachePath) return false;
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2));
      return true;
    } catch {
      return false;
    }
  }

  getProfile(urlOrHost) {
    const hostname = normalizeHostname(urlOrHost);
    if (!hostname) return null;
    this.load();
    const profile = this.cache.hosts[hostname];
    return isValidProfile(profile) ? profile : null;
  }

  applyLearning(urlOrHost, candidates) {
    const hostname = normalizeHostname(urlOrHost);
    const profile = hostname ? this.getProfile(hostname) : null;
    if (!profile || !Array.isArray(candidates) || !candidates.length) {
      return { candidates: Array.isArray(candidates) ? candidates : [], profile: null };
    }

    return {
      profile,
      candidates: candidates.map((candidate) => applyProfileBoost(candidate, profile)),
    };
  }

  recordSuccess(urlOrHost, candidate, details = {}) {
    const hostname = normalizeHostname(urlOrHost);
    if (!hostname || !candidate || !candidate.url) return null;

    this.load();
    const now = new Date().toISOString();
    const profile = this.cache.hosts[hostname] || createHostProfile(hostname, now);
    const hints = deriveHints(candidate);
    const confidence = clampNumber(details.confidence ?? candidate.confidence ?? 0, 0, 100);

    profile.updatedAt = now;
    profile.successes = clampNumber(profile.successes, 0, Number.MAX_SAFE_INTEGER) + 1;
    profile.lastConfidence = confidence;
    profile.lastStrategy = hints.strategy;
    profile.lastSourceType = hints.sourceType;
    profile.lastMetadataSource = hints.metadataSource;
    profile.lastDomPattern = hints.domPattern;
    profile.preferred = {
      strategy: hints.strategy,
      sourceType: hints.sourceType,
      metadataSource: hints.metadataSource,
      domPattern: hints.domPattern,
      confidence,
      updatedAt: now,
    };

    increment(profile.strategies, hints.strategy, confidence);
    increment(profile.sourceTypes, hints.sourceType, confidence);
    increment(profile.metadataSources, hints.metadataSource, confidence);
    increment(profile.domPatterns, hints.domPattern, confidence);
    increment(profile.galleryPositions, hints.galleryPosition, confidence);
    increment(profile.rendering, hints.rendered ? 'rendered' : 'static', confidence);

    profile.hints = compactHints([
      {
        ...hints,
        confidence,
        updatedAt: now,
      },
      ...(Array.isArray(profile.hints) ? profile.hints : []),
    ]);

    this.cache.hosts[hostname] = sanitizeProfile(profile, hostname);
    this.prune();
    this.save();
    return this.cache.hosts[hostname];
  }

  clear() {
    this.cache = createEmptyCache();
    this.loaded = true;
    this.save();
  }

  prune() {
    const entries = Object.entries(this.cache.hosts || {})
      .filter(([, profile]) => isValidProfile(profile))
      .sort((a, b) => String(b[1].updatedAt || '').localeCompare(String(a[1].updatedAt || '')))
      .slice(0, MAX_HOSTS);
    this.cache.hosts = Object.fromEntries(entries);
  }
}

function applyProfileBoost(candidate, profile) {
  const hints = deriveHints(candidate);
  const matches = [];
  let boost = 0;

  const strategyBoost = weightedMatch(profile.strategies, hints.strategy, 11);
  if (strategyBoost) {
    boost += strategyBoost;
    matches.push(`strategy ${hints.strategy}`);
  }

  const sourceTypeBoost = weightedMatch(profile.sourceTypes, hints.sourceType, 7);
  if (sourceTypeBoost) {
    boost += sourceTypeBoost;
    matches.push(`type ${hints.sourceType}`);
  }

  const metadataBoost = weightedMatch(profile.metadataSources, hints.metadataSource, 13);
  if (metadataBoost) {
    boost += metadataBoost;
    matches.push(`metadata ${hints.metadataSource}`);
  }

  const domBoost = bestDomPatternBoost(profile.domPatterns, hints.domPattern);
  if (domBoost) {
    boost += domBoost;
    matches.push(`DOM ${hints.domPattern}`);
  }

  const galleryBoost = weightedMatch(profile.galleryPositions, hints.galleryPosition, 6);
  if (galleryBoost) {
    boost += galleryBoost;
    matches.push(`gallery ${hints.galleryPosition}`);
  }

  const renderingBoost = weightedMatch(profile.rendering, hints.rendered ? 'rendered' : 'static', 5);
  if (renderingBoost) {
    boost += renderingBoost;
    matches.push(hints.rendered ? 'rendered DOM' : 'static DOM');
  }

  boost = Math.min(24, Math.round(boost * 10) / 10);
  if (!boost) return candidate;

  const scoreBreakdown = [
    ...(candidate.scoreBreakdown || []),
    { label: `learned host hint: ${matches.slice(0, 3).join(', ')}`, value: boost, category: 'learning' },
  ];

  return {
    ...candidate,
    score: Math.round((Number(candidate.score || 0) + boost) * 10) / 10,
    scoreBreakdown,
    reasons: scoreBreakdown
      .filter((item) => Math.abs(item.value) >= 4)
      .map((item) => `${item.value > 0 ? '+' : ''}${item.value} ${item.label}`),
    metrics: {
      ...(candidate.metrics || {}),
      learningPriority: boost,
    },
    learning: {
      host: profile.hostname,
      boost,
      matchedHints: matches,
      profileSuccesses: profile.successes,
      profileConfidence: profile.lastConfidence || 0,
    },
  };
}

function deriveHints(candidate = {}) {
  const sources = Array.isArray(candidate.sources) && candidate.sources.length
    ? candidate.sources
    : String(candidate.source || '').split(',').filter(Boolean);
  const sourceTypes = Array.isArray(candidate.sourceTypes) && candidate.sourceTypes.length
    ? candidate.sourceTypes
    : [candidate.sourceType].filter(Boolean);
  const metadataSources = Array.isArray(candidate.schemaPaths) && candidate.schemaPaths.length
    ? candidate.schemaPaths
    : Array.isArray(candidate.metadataKeys) && candidate.metadataKeys.length
      ? candidate.metadataKeys
      : sources.filter((source) => /metadata|jsonLd|og:image|twitter:image|Product|ImageObject|mainEntity|primaryImageOfPage/i.test(source));

  return {
    strategy: normalizeHint(primarySource(sources)),
    sourceType: normalizeHint(sourceTypes[0] || candidate.sourceType || 'unknown'),
    metadataSource: normalizeHint(primaryMetadata(metadataSources, sources)),
    domPattern: normalizeDomPattern(candidate),
    galleryPosition: Number.isFinite(candidate.galleryPosition) && candidate.galleryPosition >= 0
      ? `gallery-${Math.min(3, candidate.galleryPosition)}`
      : 'none',
    rendered: Boolean(candidate.rendered),
  };
}

function primarySource(sources) {
  return sources.find((source) => /primaryImageOfPage|mainEntity|Product|og:image|twitter:image|ImageObject/i.test(source)) ||
    sources[0] ||
    'unknown';
}

function primaryMetadata(metadataSources, sources) {
  return metadataSources.find(Boolean) ||
    sources.find((source) => /primaryImageOfPage|mainEntity|Product|og:image|twitter:image|ImageObject/i.test(source)) ||
    'none';
}

function normalizeDomPattern(candidate = {}) {
  const text = [candidate.domPath, candidate.className, candidate.id, candidate.itemprop, candidate.role, candidate.ancestorText]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const tokens = [];
  if (/product-gallery|product_gallery|product media|product-media|product_media/.test(text)) tokens.push('product-gallery');
  else if (/gallery|carousel|slider/.test(text)) tokens.push('gallery');
  if (/\bmain\b|main-content|main_content/.test(text)) tokens.push('main');
  if (/\barticle\b/.test(text)) tokens.push('article');
  if (/product/.test(text)) tokens.push('product');
  if (/hero/.test(text)) tokens.push('hero');
  if (/figure/.test(text)) tokens.push('figure');
  if (!tokens.length && candidate.tagName) tokens.push(String(candidate.tagName).toLowerCase());
  return tokens.slice(0, 4).join('>') || 'unknown';
}

function weightedMatch(map, key, maxBoost) {
  const record = map && key ? map[key] : null;
  if (!record || !record.count) return 0;
  const confidenceFactor = Math.max(0.35, Math.min(1, Number(record.avgConfidence || 0) / 100));
  return Math.min(maxBoost, (3 + Math.log2(record.count + 1) * 2) * confidenceFactor);
}

function bestDomPatternBoost(map, pattern) {
  if (!map || !pattern || pattern === 'unknown') return 0;
  const direct = weightedMatch(map, pattern, 10);
  if (direct) return direct;

  const patternTokens = new Set(String(pattern).split('>').filter(Boolean));
  let best = 0;
  for (const [key, record] of Object.entries(map)) {
    const overlap = String(key).split('>').filter((token) => patternTokens.has(token)).length;
    if (!overlap) continue;
    const confidenceFactor = Math.max(0.35, Math.min(1, Number(record.avgConfidence || 0) / 100));
    best = Math.max(best, Math.min(8, (2 + overlap * 2 + Math.log2(record.count + 1)) * confidenceFactor));
  }
  return best;
}

function increment(map, key, confidence) {
  const normalized = normalizeHint(key);
  if (!normalized || normalized === 'unknown' || normalized === 'none') return;
  const existing = map[normalized] || { count: 0, avgConfidence: 0, lastSeenAt: '' };
  const count = existing.count + 1;
  map[normalized] = {
    count,
    avgConfidence: Math.round(((existing.avgConfidence * existing.count) + confidence) / count),
    lastSeenAt: new Date().toISOString(),
  };
}

function compactHints(hints) {
  const out = [];
  const seen = new Set();
  for (const hint of hints) {
    const key = [hint.strategy, hint.sourceType, hint.metadataSource, hint.domPattern, hint.galleryPosition, hint.rendered].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hint);
    if (out.length >= MAX_HINTS_PER_HOST) break;
  }
  return out;
}

function sanitizeCache(value) {
  const cache = createEmptyCache();
  if (!value || typeof value !== 'object' || !value.hosts || typeof value.hosts !== 'object') return cache;

  for (const [hostname, profile] of Object.entries(value.hosts)) {
    const normalized = normalizeHostname(hostname);
    if (!normalized) continue;
    const sanitized = sanitizeProfile(profile, normalized);
    if (isValidProfile(sanitized)) cache.hosts[normalized] = sanitized;
  }
  return cache;
}

function sanitizeProfile(profile, hostname) {
  const now = new Date().toISOString();
  return {
    version: CACHE_VERSION,
    hostname,
    createdAt: validString(profile?.createdAt) || now,
    updatedAt: validString(profile?.updatedAt) || now,
    successes: clampNumber(profile?.successes, 0, Number.MAX_SAFE_INTEGER),
    lastConfidence: clampNumber(profile?.lastConfidence, 0, 100),
    lastStrategy: validString(profile?.lastStrategy),
    lastSourceType: validString(profile?.lastSourceType),
    lastMetadataSource: validString(profile?.lastMetadataSource),
    lastDomPattern: validString(profile?.lastDomPattern),
    preferred: profile?.preferred && typeof profile.preferred === 'object' ? profile.preferred : {},
    strategies: sanitizeStatsMap(profile?.strategies),
    sourceTypes: sanitizeStatsMap(profile?.sourceTypes),
    metadataSources: sanitizeStatsMap(profile?.metadataSources),
    domPatterns: sanitizeStatsMap(profile?.domPatterns),
    galleryPositions: sanitizeStatsMap(profile?.galleryPositions),
    rendering: sanitizeStatsMap(profile?.rendering),
    hints: Array.isArray(profile?.hints) ? profile.hints.slice(0, MAX_HINTS_PER_HOST) : [],
  };
}

function sanitizeStatsMap(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [key, record] of Object.entries(value)) {
    const normalized = normalizeHint(key);
    if (!normalized || !record || typeof record !== 'object') continue;
    const count = clampNumber(record.count, 0, Number.MAX_SAFE_INTEGER);
    if (!count) continue;
    out[normalized] = {
      count,
      avgConfidence: clampNumber(record.avgConfidence, 0, 100),
      lastSeenAt: validString(record.lastSeenAt),
    };
  }
  return out;
}

function createHostProfile(hostname, now) {
  return sanitizeProfile({ createdAt: now, updatedAt: now }, hostname);
}

function createEmptyCache() {
  return {
    version: CACHE_VERSION,
    hosts: {},
  };
}

function isValidProfile(profile) {
  return Boolean(profile && typeof profile === 'object' && profile.hostname && typeof profile.hostname === 'string');
}

function normalizeHostname(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  try {
    return new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`).hostname.replace(/^www\./, '');
  } catch {
    return text.replace(/^www\./, '').replace(/[^a-z0-9.-]/g, '');
  }
}

function normalizeHint(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 160) || 'unknown';
}

function validString(value) {
  return typeof value === 'string' ? value.slice(0, 240) : '';
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

const sharedMerchantLearningEngine = new MerchantLearningEngine();

module.exports = {
  MerchantLearningEngine,
  sharedMerchantLearningEngine,
  deriveHints,
  normalizeHostname,
};

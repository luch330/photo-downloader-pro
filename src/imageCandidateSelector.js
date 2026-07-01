const {
  extractAllImageCandidates,
  normalizeCandidates,
} = require('./imageCandidateExtractor');
const {
  getCandidateDimensions,
  scoreCandidate,
  scoreCandidates,
} = require('./imageCandidateScorer');

function selectMainImageCandidate(html, baseUrl, options = {}) {
  const rawCandidates = extractAllImageCandidates(html, baseUrl, options);
  const normalizedCandidates = normalizeCandidates(rawCandidates, baseUrl);
  const scoredCandidates = scoreCandidates(normalizedCandidates, options);
  const learningResult = options.learningEngine
    ? options.learningEngine.applyLearning(baseUrl, scoredCandidates)
    : { candidates: scoredCandidates, profile: null };
  const rankedCandidates = assignConfidence(rankCandidates(learningResult.candidates));
  const selected = rankedCandidates[0] || null;

  return {
    selected,
    selectedUrl: selected?.url || '',
    candidates: rankedCandidates,
    rawCount: rawCandidates.length,
    normalizedCount: normalizedCandidates.length,
    learningProfile: learningResult.profile,
    debug: selected ? buildSelectionDebug(selected, rankedCandidates, learningResult.profile) : null,
  };
}

function discoverMainImageCandidates(html, baseUrl, options = {}) {
  return selectMainImageCandidate(html, baseUrl, options).candidates;
}

function rankCandidates(candidates) {
  return (Array.isArray(candidates) ? candidates : [])
    .slice()
    .sort((a, b) => {
      const scoreDiff = Number(b.score || 0) - Number(a.score || 0);
      if (Math.abs(scoreDiff) > 4) return scoreDiff;

      const bMeta = Number(b.metrics?.metadataPriority || 0);
      const aMeta = Number(a.metrics?.metadataPriority || 0);
      if (bMeta !== aMeta) return bMeta - aMeta;

      const bDom = Number(b.metrics?.domPriority || 0) + Number(b.metrics?.locationPriority || 0);
      const aDom = Number(a.metrics?.domPriority || 0) + Number(a.metrics?.locationPriority || 0);
      if (bDom !== aDom) return bDom - aDom;

      const bArea = areaFor(b);
      const aArea = areaFor(a);
      if (bArea !== aArea) return bArea - aArea;

      const bSource = Number(b.metrics?.sourcePriority || b.sourcePriority || 0);
      const aSource = Number(a.metrics?.sourcePriority || a.sourcePriority || 0);
      if (bSource !== aSource) return bSource - aSource;

      return Number(a.index || a.sequence || 0) - Number(b.index || b.sequence || 0);
    });
}

function assignConfidence(rankedCandidates) {
  return rankedCandidates.map((candidate, index) => {
    const runnerUp = index === 0 ? rankedCandidates[1] : rankedCandidates[0];
    const confidence = calculateConfidence(candidate, runnerUp);
    return {
      ...candidate,
      confidence,
      confidenceLabel: confidence >= 82 ? 'high' : confidence >= 55 ? 'medium' : 'low',
    };
  });
}

function calculateConfidence(candidate, runnerUp) {
  const metrics = candidate.metrics || {};
  const area = areaFor(candidate);
  const metadata = clamp(Number(metrics.metadataPriority || 0), 0, 56) / 56 * 22;
  const dom = clamp(Number(metrics.domPriority || 0) + Number(metrics.locationPriority || 0), 0, 58) / 58 * 18;
  const dimensions = area >= 1000000
    ? 16
    : area >= 360000
      ? 12
      : area >= 90000
        ? 8
        : 0;
  const consensus = Math.min(10, Math.max(0, ((candidate.sources || []).length - 1) * 4));
  const learned = clamp(Number(metrics.learningPriority || 0), 0, 24) / 24 * 12;
  const scoreGap = runnerUp ? Number(candidate.score || 0) - Number(runnerUp.score || 0) : 28;
  const gap = clamp(scoreGap, 0, 36) / 36 * 16;
  const penalties = (candidate.scoreBreakdown || [])
    .filter((item) => item.value < 0)
    .reduce((sum, item) => sum + Math.abs(item.value), 0);
  const penalty = Math.min(16, penalties / 7);

  return Math.round(clamp(24 + metadata + dom + dimensions + consensus + learned + gap - penalty, 1, 99));
}

function buildSelectionDebug(selected, rankedCandidates, learningProfile = null) {
  const positive = (selected.scoreBreakdown || []).filter((item) => item.value > 0);
  const negative = (selected.scoreBreakdown || []).filter((item) => item.value < 0);
  const runnerUp = rankedCandidates[1] || null;
  const closest = rankedCandidates.slice(1, 5).map((candidate) => ({
    url: candidate.url,
    score: candidate.score,
    confidence: candidate.confidence,
    delta: Math.round((selected.score - candidate.score) * 10) / 10,
    reasons: candidate.reasons || [],
  }));

  return {
    selectedImage: selected.url,
    score: selected.score,
    confidence: selected.confidence,
    confidenceLabel: selected.confidenceLabel,
    reasons: selected.reasons || [],
    learnedHostHint: selected.learning || null,
    learningProfile: learningProfile
      ? {
          hostname: learningProfile.hostname,
          successes: learningProfile.successes,
          lastStrategy: learningProfile.lastStrategy,
          lastConfidence: learningProfile.lastConfidence,
        }
      : null,
    positive,
    negative,
    runnerUpLost: runnerUp
      ? explainRunnerUpLoss(selected, runnerUp)
      : 'No runner-up candidate was available.',
    closestAlternatives: closest,
  };
}

function explainRunnerUpLoss(selected, runnerUp) {
  const delta = Math.round((Number(selected.score || 0) - Number(runnerUp.score || 0)) * 10) / 10;
  const selectedTop = (selected.scoreBreakdown || [])
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .map((item) => `${item.value > 0 ? '+' : ''}${item.value} ${item.label}`)
    .join(', ');
  const runnerPenalties = (runnerUp.scoreBreakdown || [])
    .filter((item) => item.value < 0)
    .sort((a, b) => a.value - b.value)
    .slice(0, 2)
    .map((item) => `${item.value} ${item.label}`)
    .join(', ');
  return `Runner-up lost by ${delta} points${selectedTop ? `; winner had ${selectedTop}` : ''}${runnerPenalties ? `; runner-up penalties: ${runnerPenalties}` : ''}.`;
}

function areaFor(candidate) {
  const { width, height } = getCandidateDimensions(candidate);
  return width * height;
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

module.exports = {
  selectMainImageCandidate,
  discoverMainImageCandidates,
  rankCandidates,
  scoreCandidate,
  calculateConfidence,
};

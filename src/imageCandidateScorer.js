const IMAGE_URL_RE = /\.(?:jpe?g|png|gif|bmp|webp|svg|avif|heic|heif|tiff?|ico)(?:[?#]|$)/i;

const METADATA_WEIGHTS = [
  [/primaryImageOfPage/i, 56, 'primaryImageOfPage'],
  [/mainEntity\.image/i, 50, 'mainEntity.image'],
  [/Product\.primaryImage/i, 47, 'Product.primaryImage'],
  [/Product\.image/i, 44, 'Product.image'],
  [/og:image:secure_url/i, 41, 'og:image:secure_url'],
  [/og:image/i, 39, 'og:image'],
  [/twitter:image/i, 34, 'twitter:image'],
  [/ImageObject\.url/i, 31, 'ImageObject.url'],
  [/Article\.image/i, 26, 'Article.image'],
];

const DOM_POSITIVE_WEIGHTS = [
  [/product-gallery|product_gallery|product media|product-media|product_media/i, 22, 'product media container'],
  [/product/i, 18, 'product container'],
  [/\bmain\b|main-content|main_content|content-main/i, 16, 'main content'],
  [/\barticle\b/i, 13, 'article content'],
  [/gallery|carousel|slider/i, 13, 'gallery container'],
  [/\bfigure\b/i, 10, 'figure'],
  [/hero/i, 10, 'hero image area'],
  [/image|photo|media/i, 6, 'media context'],
];

const DOM_NEGATIVE_WEIGHTS = [
  [/\bheader\b|site-header|topbar/i, -30, 'header area'],
  [/\bfooter\b|site-footer/i, -32, 'footer area'],
  [/sidebar|aside/i, -28, 'sidebar area'],
  [/\bnav\b|navigation|menu/i, -30, 'navigation area'],
  [/breadcrumb/i, -24, 'breadcrumbs'],
  [/\bad\b|ads|advert|sponsor|promo/i, -36, 'ad or promo area'],
];

const POSITIVE_FILENAME_TERMS = [
  'main',
  'product',
  'hero',
  'cover',
  'primary',
  'featured',
  'original',
  'zoom',
  'large',
  'full',
  'gallery',
  'detail',
];

const NEGATIVE_FILENAME_TERMS = [
  'logo',
  'icon',
  'favicon',
  'avatar',
  'sprite',
  'thumb',
  'thumbnail',
  'badge',
  'banner',
  'promo',
  'ad',
  'placeholder',
  'loading',
  'spinner',
  'pixel',
  'tracking',
];

const NEGATIVE_ALT_TERMS = [
  'logo',
  'icon',
  'facebook',
  'instagram',
  'share',
  'payment',
  'brand logo',
  'twitter',
  'pinterest',
  'youtube',
];

function scoreCandidates(candidates, options = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  return list.map((candidate) => scoreCandidate(candidate, list, options));
}

function scoreCandidate(candidate, allCandidates = [], options = {}) {
  const scored = { ...candidate };
  const breakdown = [];
  const metrics = {
    metadataPriority: 0,
    domPriority: 0,
    dimensionsArea: 0,
    locationPriority: 0,
    sourcePriority: Number(candidate.sourcePriority || 0),
  };

  const add = (label, value, category = 'general') => {
    if (!value) return;
    breakdown.push({ label, value, category });
  };

  const sourceText = [
    candidate.source,
    ...(candidate.sources || []),
    ...(candidate.metadataKeys || []),
    ...(candidate.schemaPaths || []),
  ].join(' ').toLowerCase();
  const domText = normalizeText([
    candidate.tagName,
    candidate.attr,
    candidate.className,
    candidate.id,
    candidate.itemprop,
    candidate.role,
    candidate.domPath,
    candidate.ancestorText,
    candidate.context,
  ].join(' '));
  const urlText = normalizeText(candidate.url || candidate.rawUrl || '');
  const altTitleText = normalizeText([candidate.alt, candidate.title].join(' '));

  add('image URL', IMAGE_URL_RE.test(candidate.url || '') ? 8 : 0, 'format');

  const metadataScore = scoreMetadata(sourceText, add);
  metrics.metadataPriority = metadataScore;

  const domScore = scoreDomLocation(domText, add);
  metrics.domPriority = domScore;

  scoreHeadingProximity(candidate, altTitleText, add, metrics);
  scoreDimensions(candidate, add, metrics);
  scoreAspectRatio(candidate, add);
  scoreFilename(urlText, add);
  scoreAltTitle(altTitleText, candidate, add);
  scoreGallery(candidate, add, metrics);
  scoreVisiblePosition(candidate, add, metrics);
  scoreCandidateFrequency(candidate, allCandidates, add);

  const score = breakdown.reduce((sum, item) => sum + item.value, 0);
  scored.score = Math.round(score * 10) / 10;
  scored.scoreBreakdown = breakdown;
  scored.reasons = breakdown
    .filter((item) => Math.abs(item.value) >= 4)
    .map((item) => `${item.value > 0 ? '+' : ''}${item.value} ${item.label}`);
  scored.metrics = metrics;
  return scored;
}

function scoreMetadata(sourceText, add) {
  let total = 0;
  const matched = new Set();

  for (const [pattern, value, label] of METADATA_WEIGHTS) {
    if (!pattern.test(sourceText) || matched.has(label)) continue;
    matched.add(label);
    total += value;
    add(label, value, 'metadata');
  }

  return total;
}

function scoreDomLocation(domText, add) {
  let total = 0;

  for (const [pattern, value, label] of DOM_POSITIVE_WEIGHTS) {
    if (!pattern.test(domText)) continue;
    total += value;
    add(label, value, 'dom');
  }

  for (const [pattern, value, label] of DOM_NEGATIVE_WEIGHTS) {
    if (!pattern.test(domText)) continue;
    total += value;
    add(label, value, 'dom');
  }

  return total;
}

function scoreHeadingProximity(candidate, altTitleText, add, metrics) {
  const distance = Number(candidate.h1Distance);
  if (Number.isFinite(distance)) {
    if (distance <= 260) {
      add('near H1', 14, 'heading');
      metrics.locationPriority += 14;
    } else if (distance <= 900) {
      add('close to H1', 10, 'heading');
      metrics.locationPriority += 10;
    } else if (distance <= 2200) {
      add('same section as H1', 6, 'heading');
      metrics.locationPriority += 6;
    }
  }

  const h1Tokens = tokenize(candidate.h1Text).filter((token) => token.length >= 4);
  if (h1Tokens.length && h1Tokens.some((token) => altTitleText.includes(token))) {
    add('alt/title matches H1', 8, 'heading');
  }
}

function scoreDimensions(candidate, add, metrics) {
  const dimensions = getCandidateDimensions(candidate);
  const { width, height } = dimensions;
  const area = width && height ? width * height : 0;
  metrics.dimensionsArea = area;

  if (candidate.actualWidth || candidate.actualHeight) add('actual image dimensions', 4, 'dimensions');
  if (candidate.density >= 2) add('high density srcset', 5, 'dimensions');

  if (area >= 1000000 || width >= 1200 || height >= 1200) add('large image', 20, 'dimensions');
  else if (area >= 360000 || width >= 700 || height >= 700) add('medium-large image', 14, 'dimensions');
  else if (area >= 90000 || width >= 320 || height >= 320) add('usable image size', 8, 'dimensions');
  else if (width || height) add('very small image', -36, 'dimensions');

  if ((width && width < 120) || (height && height < 120)) add('tiny asset dimensions', -42, 'dimensions');
  if ((width && width < 64) || (height && height < 64)) add('icon-size asset', -48, 'dimensions');
}

function scoreAspectRatio(candidate, add) {
  const { width, height } = getCandidateDimensions(candidate);
  if (!width || !height) return;

  const ratio = width / height;
  if (ratio >= 0.82 && ratio <= 1.18) add('square product ratio', 10, 'aspect');
  else if (ratio > 1.18 && ratio <= 1.8) add('slightly landscape ratio', 7, 'aspect');
  else if (ratio >= 0.58 && ratio < 0.82) add('portrait product ratio', 4, 'aspect');
  else if (ratio > 3.2 || ratio < 0.32) add('extreme banner/icon ratio', -42, 'aspect');
  else if (ratio > 2.3 || ratio < 0.45) add('weak product aspect ratio', -18, 'aspect');
}

function scoreFilename(urlText, add) {
  const positive = countTerms(urlText, POSITIVE_FILENAME_TERMS);
  const negative = countTerms(urlText, NEGATIVE_FILENAME_TERMS);
  if (positive) add('positive filename keywords', positive * 6, 'filename');
  if (negative) add('negative filename keywords', negative * -18, 'filename');
  if (containsTerm(urlText, 'logo') || containsTerm(urlText, 'favicon')) add('logo/favicon filename', -42, 'filename');
  if (containsTerm(urlText, 'thumb') || containsTerm(urlText, 'thumbnail')) add('thumbnail filename', -30, 'filename');
  if (containsTerm(urlText, 'banner') || containsTerm(urlText, 'promo')) add('banner/promo filename', -34, 'filename');
}

function scoreAltTitle(altTitleText, candidate, add) {
  if (!altTitleText) return;

  const negative = countTerms(altTitleText, NEGATIVE_ALT_TERMS);
  if (negative) add('negative alt/title terms', negative * -18, 'alt');
  if (altTitleText.length >= 18 && negative === 0) add('descriptive alt/title', 6, 'alt');
  if (/\b[A-Z]{2,}[\w-]*\d[\w-]*\b|\bSKU[:\s-]*[A-Z0-9-]+\b/i.test(`${candidate.alt || ''} ${candidate.title || ''}`)) {
    add('SKU-like alt/title', 6, 'alt');
  }
  if (containsTerm(altTitleText, 'product') || containsTerm(altTitleText, 'merchant')) {
    add('product alt/title terms', 6, 'alt');
  }
}

function scoreGallery(candidate, add, metrics) {
  const inGallery = Number(candidate.galleryIndex || -1) >= 0 || /gallery|carousel|product-media|product-gallery/i.test(candidate.domPath || candidate.ancestorText || '');
  if (!inGallery) return;

  const { width, height } = getCandidateDimensions(candidate);
  const largeEnough = width >= 480 || height >= 480 || (width && height && width * height >= 160000);
  const galleryPosition = Number(candidate.galleryPosition);

  add('inside gallery', 10, 'gallery');
  metrics.domPriority += 10;

  if (galleryPosition === 0 && largeEnough) add('first large gallery image', 16, 'gallery');
  else if (galleryPosition >= 0 && galleryPosition <= 2 && largeEnough) add('early gallery image', 9, 'gallery');

  if (/thumb|thumbnail/i.test(`${candidate.url} ${candidate.className} ${candidate.context}`)) {
    add('gallery thumbnail', -22, 'gallery');
  }
}

function scoreVisiblePosition(candidate, add, metrics) {
  const domIndex = Number(candidate.domIndex);
  if (!Number.isFinite(domIndex)) return;

  if (candidate.aboveFoldHint && domIndex <= 2) {
    add('first visible image', 10, 'position');
    metrics.locationPriority += 10;
  } else if (candidate.aboveFoldHint && domIndex <= 6) {
    add('above-fold image', 6, 'position');
    metrics.locationPriority += 6;
  } else if (domIndex > 30) {
    add('late DOM position', -6, 'position');
  }
}

function scoreCandidateFrequency(candidate, allCandidates, add) {
  const url = candidate.url;
  if (!url) return;
  const appearances = allCandidates.filter((item) => item.url === url || item.rawUrl === candidate.rawUrl).length;
  const sources = Array.isArray(candidate.sources) ? candidate.sources.length : 0;
  if (appearances > 1 || sources > 1) add('same image found multiple ways', Math.min(12, (appearances + sources - 1) * 3), 'consensus');
}

function getCandidateDimensions(candidate) {
  const width = Number(candidate.actualWidth || candidate.naturalWidth || candidate.width || 0);
  const height = Number(candidate.actualHeight || candidate.naturalHeight || candidate.height || 0);
  if (width || height) return { width, height };

  const text = `${candidate.url || ''} ${candidate.context || ''}`;
  const match = text.match(/(?:^|[^0-9])(\d{2,5})\s*[xX-]\s*(\d{2,5})(?:[^0-9]|$)/);
  if (!match) return { width: 0, height: 0 };
  return { width: Number(match[1]) || 0, height: Number(match[2]) || 0 };
}

function countTerms(text, terms) {
  return terms.reduce((count, term) => count + (containsTerm(text, term) ? 1 : 0), 0);
}

function containsTerm(text, term) {
  const haystack = normalizeText(text);
  const needle = normalizeText(term);
  if (!needle) return false;
  if (needle.length <= 3) {
    return new RegExp(`(?:^|[\\W_/-])${escapeRegExp(needle)}(?:$|[\\W_/-])`, 'i').test(haystack);
  }
  return haystack.includes(needle);
}

function tokenize(value) {
  return normalizeText(value).split(/[^a-z0-9]+/i).filter(Boolean);
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[_-]+/g, ' ');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  scoreCandidate,
  scoreCandidates,
  getCandidateDimensions,
  METADATA_WEIGHTS,
};

const IMAGE_URL_RE = /\.(?:jpe?g|png|gif|bmp|webp|svg|avif|heic|heif|tiff?|ico)(?:[?#]|$)/i;

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const META_IMAGE_KEYS = new Set([
  'og:image',
  'og:image:url',
  'og:image:secure_url',
  'twitter:image',
  'twitter:image:src',
  'twitter:image:url',
  'primaryimageofpage',
  'image',
]);

const LAZY_IMAGE_ATTRIBUTES = [
  'src',
  'currentSrc',
  'href',
  'data-src',
  'data-lazy-src',
  'data-original',
  'data-full',
  'data-full-src',
  'data-large_image',
  'data-large-file',
  'data-medium-file',
  'data-orig-file',
  'data-zoom-image',
  'data-image',
  'data-image-src',
  'data-hires',
  'data-thumb',
  'data-thumbnail',
  'data-bg',
  'data-bg-src',
  'data-background',
  'data-background-image',
  'data-pin-media',
  'poster',
];

const SRCSET_ATTRIBUTES = [
  'srcset',
  'data-srcset',
  'data-lazy-srcset',
  'data-bgset',
  'imagesrcset',
];

function extractAllImageCandidates(html, baseUrl, options = {}) {
  const documentHtml = String(html || '');
  const h1Positions = collectHeadingPositions(documentHtml);
  const candidates = [];
  let sequence = 0;

  const push = (rawUrl, details = {}) => {
    const values = Array.isArray(rawUrl) ? rawUrl : [rawUrl];
    for (const value of values) {
      const item = typeof value === 'object' && value !== null ? value : { url: value };
      const url = normalizeEscapedUrl(String(item.url || '').trim());
      if (!url || /^(?:javascript|mailto|tel|blob):/i.test(url)) continue;

      candidates.push({
        rawUrl: url,
        baseUrl,
        source: details.source || 'html',
        sourceType: details.sourceType || 'html',
        sourcePriority: Number(details.sourcePriority || 0),
        sequence: sequence += 1,
        index: Number(details.index ?? sequence),
        tagName: details.tagName || '',
        attr: details.attr || '',
        metadataKey: details.metadataKey || '',
        schemaPath: details.schemaPath || '',
        descriptor: item.descriptor || details.descriptor || '',
        width: Math.max(parseDimension(details.width), parseDimension(item.width)),
        height: Math.max(parseDimension(details.height), parseDimension(item.height)),
        density: Math.max(Number(details.density || 0), Number(item.density || 0)),
        alt: details.alt || '',
        title: details.title || '',
        className: details.className || '',
        id: details.id || '',
        itemprop: details.itemprop || '',
        role: details.role || '',
        context: details.context || '',
        domPath: details.domPath || '',
        ancestorText: details.ancestorText || '',
        ancestorTags: details.ancestorTags || [],
        h1Distance: Number.isFinite(details.h1Distance) ? details.h1Distance : Infinity,
        h1Text: details.h1Text || '',
        domIndex: Number.isFinite(details.domIndex) ? details.domIndex : Infinity,
        galleryIndex: Number.isFinite(details.galleryIndex) ? details.galleryIndex : -1,
        galleryPosition: Number.isFinite(details.galleryPosition) ? details.galleryPosition : -1,
        aboveFoldHint: Boolean(details.aboveFoldHint),
        rendered: Boolean(options.rendered || details.rendered),
      });
    }
  };

  for (const tag of matchTagsWithPosition(documentHtml, 'meta')) {
    const attrs = parseAttributes(tag.html);
    const key = String(attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (!META_IMAGE_KEYS.has(key)) continue;

    push(attrs.content, {
      source: normalizeMetadataSource(key),
      sourceType: 'metadata',
      sourcePriority: 100,
      metadataKey: key,
      index: tag.index,
      context: tag.html,
      ...buildDomContext(documentHtml, tag.index, 'meta', attrs, h1Positions),
    });
  }

  for (const tag of matchTagsWithPosition(documentHtml, 'link')) {
    const attrs = parseAttributes(tag.html);
    const rel = String(attrs.rel || '').toLowerCase();
    const as = String(attrs.as || '').toLowerCase();
    if (!rel.includes('image_src') && !(rel.includes('preload') && as === 'image')) continue;

    push(attrs.href, {
      source: 'link:image',
      sourceType: 'metadata',
      sourcePriority: 72,
      attr: 'href',
      index: tag.index,
      context: tag.html,
      ...buildDomContext(documentHtml, tag.index, 'link', attrs, h1Positions),
    });
    push(parseSrcsetDetailed(attrs.imagesrcset || attrs.srcset), {
      source: 'link:srcset',
      sourceType: 'metadata',
      sourcePriority: 72,
      attr: 'srcset',
      index: tag.index,
      context: tag.html,
      ...buildDomContext(documentHtml, tag.index, 'link', attrs, h1Positions),
    });
  }

  let domImageIndex = 0;
  for (const tagName of ['img', 'source']) {
    for (const tag of matchTagsWithPosition(documentHtml, tagName)) {
      const attrs = parseAttributes(tag.html);
      const context = buildDomContext(documentHtml, tag.index, tagName, attrs, h1Positions, domImageIndex);
      const common = {
        sourceType: 'dom',
        sourcePriority: tagName === 'source' ? 58 : 62,
        tagName,
        index: tag.index,
        domIndex: domImageIndex,
        width: attrs.width || attrs['data-width'],
        height: attrs.height || attrs['data-height'],
        alt: attrs.alt || '',
        title: attrs.title || '',
        className: attrs.class || '',
        id: attrs.id || '',
        itemprop: attrs.itemprop || '',
        role: attrs.role || '',
        context: tag.html,
        ...context,
      };

      for (const attr of LAZY_IMAGE_ATTRIBUTES) {
        push(attrs[attr.toLowerCase()], {
          ...common,
          source: `dom:${tagName}:${attr.toLowerCase()}`,
          attr: attr.toLowerCase(),
        });
      }

      for (const attr of SRCSET_ATTRIBUTES) {
        push(parseSrcsetDetailed(attrs[attr]), {
          ...common,
          source: `dom:${tagName}:${attr}`,
          attr,
        });
      }

      push(extractCssUrls(attrs.style), {
        ...common,
        source: `dom:${tagName}:inline-style`,
        sourceType: 'css',
        attr: 'style',
      });

      domImageIndex += 1;
    }
  }

  for (const block of extractJsonLdBlocks(documentHtml)) {
    for (const candidate of extractJsonLdCandidates(block.text)) {
      push(candidate.url, {
        source: candidate.source,
        sourceType: 'jsonLd',
        sourcePriority: 96,
        schemaPath: candidate.schemaPath,
        index: block.index,
        context: candidate.context || block.text.slice(0, 500),
        ...buildDomContext(documentHtml, block.index, 'script', {}, h1Positions),
      });
    }
  }

  for (const cssCandidate of extractCssBackgroundCandidates(documentHtml)) {
    push(cssCandidate.url, {
      source: cssCandidate.inline ? 'css:inline-background' : 'css:background-image',
      sourceType: 'css',
      sourcePriority: 36,
      index: cssCandidate.index,
      context: cssCandidate.context,
      ...buildDomContext(documentHtml, cssCandidate.index, 'style', {}, h1Positions),
    });
  }

  const urlRegex = /https?:\/\/[^"'\\\s>)]+?\.(?:jpe?g|png|webp|gif|bmp|svg|avif|heic|heif|tiff?|ico)(?:\?[^"'\\\s>)]*)?/gi;
  let urlMatch;
  while ((urlMatch = urlRegex.exec(documentHtml))) {
    push(urlMatch[0], {
      source: 'html:url-regex',
      sourceType: 'regex',
      sourcePriority: 18,
      index: urlMatch.index,
      context: documentHtml.slice(Math.max(0, urlMatch.index - 120), urlMatch.index + 240),
      ...buildDomContext(documentHtml, urlMatch.index, 'html', {}, h1Positions),
    });
  }

  return candidates;
}

function normalizeCandidates(candidates, baseUrl) {
  const normalized = new Map();

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const resolvedUrl = resolveUrl(candidate.rawUrl || candidate.url, candidate.baseUrl || baseUrl);
    if (!resolvedUrl || (!isDataUrl(resolvedUrl) && !safeUrl(resolvedUrl))) continue;

    const existing = normalized.get(resolvedUrl);
    if (!existing) {
      normalized.set(resolvedUrl, {
        ...candidate,
        url: resolvedUrl,
        sources: uniqueList([candidate.source]),
        metadataKeys: uniqueList([candidate.metadataKey]),
        schemaPaths: uniqueList([candidate.schemaPath]),
        sourceTypes: uniqueList([candidate.sourceType]),
      });
      continue;
    }

    existing.sources = uniqueList(existing.sources.concat(candidate.source));
    existing.source = existing.sources.join(',');
    existing.metadataKeys = uniqueList(existing.metadataKeys.concat(candidate.metadataKey));
    existing.schemaPaths = uniqueList(existing.schemaPaths.concat(candidate.schemaPath));
    existing.sourceTypes = uniqueList(existing.sourceTypes.concat(candidate.sourceType));
    existing.sourcePriority = Math.max(existing.sourcePriority || 0, candidate.sourcePriority || 0);
    existing.index = Math.min(existing.index ?? Infinity, candidate.index ?? Infinity);
    existing.sequence = Math.min(existing.sequence ?? Infinity, candidate.sequence ?? Infinity);
    existing.width = Math.max(existing.width || 0, candidate.width || 0);
    existing.height = Math.max(existing.height || 0, candidate.height || 0);
    existing.density = Math.max(existing.density || 0, candidate.density || 0);
    existing.domIndex = Math.min(existing.domIndex ?? Infinity, candidate.domIndex ?? Infinity);
    existing.h1Distance = Math.min(existing.h1Distance ?? Infinity, candidate.h1Distance ?? Infinity);
    if (!existing.h1Text && candidate.h1Text) existing.h1Text = candidate.h1Text;
    if (!existing.alt && candidate.alt) existing.alt = candidate.alt;
    if (!existing.title && candidate.title) existing.title = candidate.title;
    if (!existing.className && candidate.className) existing.className = candidate.className;
    if (!existing.id && candidate.id) existing.id = candidate.id;
    if (!existing.itemprop && candidate.itemprop) existing.itemprop = candidate.itemprop;
    if (!existing.role && candidate.role) existing.role = candidate.role;
    existing.galleryIndex = Math.max(existing.galleryIndex ?? -1, candidate.galleryIndex ?? -1);
    existing.galleryPosition = mergeGalleryPosition(existing.galleryPosition, candidate.galleryPosition);
    existing.aboveFoldHint = Boolean(existing.aboveFoldHint || candidate.aboveFoldHint);
    existing.rendered = Boolean(existing.rendered || candidate.rendered);
    existing.ancestorTags = uniqueList((existing.ancestorTags || []).concat(candidate.ancestorTags || []));
    existing.context = mergeText(existing.context, candidate.context, 3000);
    existing.ancestorText = mergeText(existing.ancestorText, candidate.ancestorText, 1800);
    existing.domPath = mergeText(existing.domPath, candidate.domPath, 900);
  }

  return Array.from(normalized.values()).map((candidate) => {
    const inferred = inferDimensions(candidate);
    return {
      ...candidate,
      source: candidate.sources.join(','),
      width: candidate.width || inferred.width,
      height: candidate.height || inferred.height,
    };
  });
}

function extractJsonLdCandidates(block) {
  const out = [];
  const seen = new Set();

  const push = (value, source, schemaPath, context = '') => {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (!item) continue;
      if (typeof item === 'object') {
        push(item.url || item.contentUrl || item.thumbnailUrl || item['@id'], source, schemaPath, context || safeJsonSnippet(item));
        continue;
      }

      const url = normalizeEscapedUrl(String(item || '').trim());
      if (!url || seen.has(`${source}:${url}`)) continue;
      seen.add(`${source}:${url}`);
      out.push({ url, source, schemaPath, context });
    }
  };

  const collectImageValue = (value, source, schemaPath, context) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => collectImageValue(item, source, `${schemaPath}[${index}]`, context));
      return;
    }
    if (typeof value === 'object') {
      push(value.url || value.contentUrl || value.thumbnailUrl || value.image, source, schemaPath, context || safeJsonSnippet(value));
      return;
    }
    push(value, source, schemaPath, context);
  };

  const walk = (node, path = '$', parentTypes = []) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`, parentTypes));
      return;
    }
    if (typeof node !== 'object') return;

    const types = uniqueList(parentTypes.concat(getSchemaTypes(node)));
    const context = safeJsonSnippet({ '@type': node['@type'], name: node.name, headline: node.headline, sku: node.sku });

    if (node.primaryImageOfPage) {
      collectImageValue(node.primaryImageOfPage, 'jsonLd:primaryImageOfPage', `${path}.primaryImageOfPage`, context);
    }

    if (node.mainEntity) {
      const entities = Array.isArray(node.mainEntity) ? node.mainEntity : [node.mainEntity];
      entities.forEach((entity, index) => {
        if (entity && typeof entity === 'object') {
          collectImageValue(entity.primaryImage || entity.image, 'jsonLd:mainEntity.image', `${path}.mainEntity[${index}].image`, safeJsonSnippet(entity));
          walk(entity, `${path}.mainEntity[${index}]`, types);
        }
      });
    }

    if (types.includes('product')) {
      collectImageValue(node.primaryImage, 'jsonLd:Product.primaryImage', `${path}.primaryImage`, context);
      collectImageValue(node.image, 'jsonLd:Product.image', `${path}.image`, context);
    }

    if (types.includes('article') || types.includes('newsarticle') || types.includes('blogposting')) {
      collectImageValue(node.image, 'jsonLd:Article.image', `${path}.image`, context);
    }

    if (types.includes('imageobject')) {
      collectImageValue(node.url || node.contentUrl, 'jsonLd:ImageObject.url', `${path}.url`, context);
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === 'mainEntity') continue;
      if (key === 'image' && (types.includes('product') || types.includes('article'))) continue;
      if (key === 'primaryImage' && types.includes('product')) continue;
      if (key === 'primaryImageOfPage') continue;

      const lower = key.toLowerCase();
      if ((lower === 'image' || lower.endsWith('image')) && typeof value !== 'object') {
        collectImageValue(value, 'jsonLd:image', `${path}.${key}`, context);
      } else if (value && typeof value === 'object') {
        walk(value, `${path}.${key}`, types);
      }
    }
  };

  try {
    walk(JSON.parse(String(block || '')));
  } catch {
    const matches = String(block || '').match(
      /https?:\/\/[^"'\\\s>]+?\.(?:jpe?g|png|webp|gif|bmp|svg|avif|heic|heif|tiff?|ico)(?:\?[^"'\\\s>]*)?/gi
    );
    if (matches) matches.forEach((url) => push(url, 'jsonLd:url-regex', '$', 'json-ld parse fallback'));
  }

  return out;
}

function buildDomContext(html, index, tagName, attrs = {}, h1Positions = [], domIndex = Infinity) {
  const ancestors = getAncestorStack(html, index);
  const ancestorText = ancestors.map((tag) => tag.context).join(' ');
  const domPath = ancestors.map((tag) => tag.label).concat(tagName).join(' > ');
  const nearestH1 = findNearestHeading(index, h1Positions);
  const galleryAncestor = findLastAncestor(ancestors, /gallery|carousel|slider|product-media|product-gallery|photos?|images?/i);
  const galleryPosition = galleryAncestor ? countImageTags(html.slice(galleryAncestor.index, index)) : -1;

  return {
    ancestorText,
    ancestorTags: ancestors.map((tag) => tag.name),
    domPath,
    h1Distance: nearestH1.distance,
    h1Text: nearestH1.text,
    domIndex,
    galleryIndex: galleryAncestor ? galleryAncestor.index : -1,
    galleryPosition,
    aboveFoldHint: index < 10000 || domIndex < 3,
    className: attrs.class || '',
    id: attrs.id || '',
    itemprop: attrs.itemprop || '',
    role: attrs.role || '',
  };
}

function getAncestorStack(html, position) {
  const stack = [];
  const regex = /<\/?([a-zA-Z0-9-]+)\b([^>]*)>/g;
  let match;

  while ((match = regex.exec(html)) && match.index < position) {
    const raw = match[0];
    const name = String(match[1] || '').toLowerCase();
    if (!name || raw.startsWith('<!') || raw.startsWith('<?')) continue;

    if (raw.startsWith('</')) {
      const lastIndex = findLastIndex(stack, (tag) => tag.name === name);
      if (lastIndex >= 0) stack.splice(lastIndex);
      continue;
    }

    if (VOID_TAGS.has(name) || /\/\s*>$/.test(raw)) continue;
    const attrs = parseAttributes(raw);
    stack.push({
      name,
      attrs,
      index: match.index,
      label: makeTagLabel(name, attrs),
      context: `${name} ${attrs.id || ''} ${attrs.class || ''} ${attrs.itemprop || ''} ${attrs.role || ''}`,
    });
  }

  return stack.slice(-12);
}

function findLastAncestor(ancestors, pattern) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    if (pattern.test(`${ancestor.name} ${ancestor.context}`)) return ancestor;
  }
  return null;
}

function collectHeadingPositions(html) {
  const headings = [];
  const regex = /<h1\b[^>]*>([\s\S]*?)<\/h1>/gi;
  let match;
  while ((match = regex.exec(html))) {
    headings.push({
      index: match.index,
      center: match.index + Math.round(match[0].length / 2),
      text: stripTags(match[1]),
    });
  }
  return headings;
}

function findNearestHeading(index, headings) {
  if (!headings.length) return { distance: Infinity, text: '' };
  return headings.reduce((best, heading) => {
    const distance = Math.abs(index - heading.center);
    return distance < best.distance ? { distance, text: heading.text } : best;
  }, { distance: Infinity, text: '' });
}

function matchTagsWithPosition(html, tagName) {
  const out = [];
  const regex = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  let match;
  while ((match = regex.exec(html))) {
    out.push({ html: match[0], index: match.index });
  }
  return out;
}

function parseAttributes(tag) {
  const attrs = {};
  const regex = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = regex.exec(String(tag || '')))) {
    const key = String(match[1] || '').toLowerCase();
    if (!key || key.startsWith('<')) continue;
    attrs[key] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function parseSrcsetDetailed(value) {
  return normalizeEscapedUrl(String(value || ''))
    .split(',')
    .map((part) => {
      const [url, descriptor = ''] = part.trim().split(/\s+/, 2);
      if (!url) return null;
      const widthMatch = descriptor.match(/^(\d+)w$/i);
      const densityMatch = descriptor.match(/^(\d+(?:\.\d+)?)x$/i);
      return {
        url,
        descriptor,
        width: widthMatch ? Number(widthMatch[1]) : 0,
        density: densityMatch ? Number(densityMatch[1]) : 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.width || b.density * 1000 || 0) - (a.width || a.density * 1000 || 0));
}

function extractCssBackgroundCandidates(html) {
  const out = [];
  const regex = /(?:background(?:-image)?\s*:[^;{}]*url\(\s*(?:"([^"]+)"|'([^']+)'|([^'")]+?))\s*\))/gi;
  let match;
  while ((match = regex.exec(String(html || '')))) {
    out.push({
      url: (match[1] || match[2] || match[3] || '').trim(),
      index: match.index,
      context: String(html || '').slice(Math.max(0, match.index - 160), match.index + 260),
      inline: true,
    });
  }
  return out;
}

function extractCssUrls(cssText) {
  const out = [];
  const regex = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^'")]+?))\s*\)/gi;
  let match;
  while ((match = regex.exec(String(cssText || '')))) {
    const value = match[1] || match[2] || match[3] || '';
    if (value && !/^data:font\//i.test(value)) out.push(value.trim());
  }
  return out;
}

function extractJsonLdBlocks(html) {
  const blocks = [];
  const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(String(html || '')))) {
    const text = String(match[1] || '').trim();
    if (text) blocks.push({ text, index: match.index });
  }
  return blocks;
}

function normalizeMetadataSource(key) {
  const lower = String(key || '').toLowerCase();
  if (lower === 'primaryimageofpage') return 'metadata:primaryImageOfPage';
  if (lower === 'image') return 'metadata:image';
  return `metadata:${lower}`;
}

function resolveUrl(candidate, baseUrl) {
  const value = String(candidate || '').trim();
  if (!value) return value;
  if (isDataUrl(value)) return value;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^\/\//.test(value)) {
    const proto = String(baseUrl || '').startsWith('https:') ? 'https:' : 'http:';
    return `${proto}${value}`;
  }

  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function safeUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

function isDataUrl(value) {
  return /^data:/i.test(String(value || '').trim());
}

function looksLikeImageUrl(value) {
  const text = String(value || '').trim();
  return isDataUrl(text) || IMAGE_URL_RE.test(text);
}

function inferDimensions(candidate) {
  const text = `${candidate?.rawUrl || ''} ${candidate?.url || ''} ${candidate?.context || ''}`;
  const match = text.match(/(?:^|[^0-9])(\d{2,5})\s*[xX-]\s*(\d{2,5})(?:[^0-9]|$)/);
  if (!match) return { width: 0, height: 0 };
  return {
    width: Number(match[1]) || 0,
    height: Number(match[2]) || 0,
  };
}

function getSchemaTypes(node) {
  const raw = node && node['@type'];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((value) => String(value || '').split('/').pop().toLowerCase())
    .filter(Boolean);
}

function makeTagLabel(name, attrs = {}) {
  const id = attrs.id ? `#${attrs.id}` : '';
  const cls = attrs.class ? `.${String(attrs.class).trim().split(/\s+/).slice(0, 3).join('.')}` : '';
  return `${name}${id}${cls}`;
}

function countImageTags(html) {
  const matches = String(html || '').match(/<(?:img|source)\b/gi);
  return matches ? matches.length : 0;
}

function parseDimension(value) {
  const match = String(value || '').match(/\d{1,5}/);
  return match ? Number(match[0]) : 0;
}

function mergeGalleryPosition(current, next) {
  if (!Number.isFinite(current) || current < 0) return Number.isFinite(next) ? next : -1;
  if (!Number.isFinite(next) || next < 0) return current;
  return Math.min(current, next);
}

function mergeText(a, b, maxLength) {
  return uniqueList([a, b].filter(Boolean)).join(' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function uniqueList(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function findLastIndex(array, predicate) {
  for (let index = array.length - 1; index >= 0; index -= 1) {
    if (predicate(array[index], index)) return index;
  }
  return -1;
}

function stripTags(value) {
  return decodeHtmlEntities(String(value || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function safeJsonSnippet(value) {
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return '';
  }
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCharCode(Number.parseInt(n, 16)));
}

function normalizeEscapedUrl(value) {
  return decodeHtmlEntities(String(value || ''))
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u002f/gi, '/');
}

module.exports = {
  extractAllImageCandidates,
  normalizeCandidates,
  parseSrcsetDetailed,
  parseAttributes,
  resolveUrl,
  looksLikeImageUrl,
  inferDimensions,
};

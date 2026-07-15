import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { DOMParser, XMLSerializer, onWarningStopParsing } from '@xmldom/xmldom';
import { canonicalPath, fail, formatNumber } from './svg-utils.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ELEMENTS = 10000;
const MAX_DEPTH = 128;
const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'path', 'rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline', 'use', 'symbol',
  'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'filter', 'feGaussianBlur', 'feOffset',
  'feColorMatrix', 'feMerge', 'feMergeNode', 'title', 'desc', 'metadata', 'text', 'tspan',
]);
const BLOCKED_ELEMENTS = new Set(['script', 'foreignObject', 'image', 'style', 'animate', 'animateMotion', 'animateTransform', 'set']);
const GLOBAL_ATTRIBUTES = new Set([
  'id', 'class', 'style', 'transform', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
  'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray',
  'stroke-dashoffset', 'opacity', 'color', 'display', 'visibility', 'clip-path', 'mask', 'filter',
  'vector-effect', 'paint-order', 'shape-rendering', 'preserveAspectRatio', 'viewBox', 'width', 'height',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'pathLength',
  'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'fx', 'fy',
  'fr', 'clipPathUnits', 'maskUnits', 'maskContentUnits', 'filterUnits', 'primitiveUnits', 'stdDeviation',
  'dx', 'dy', 'result', 'in', 'in2', 'values', 'type', 'operator', 'flood-color', 'flood-opacity',
  'font-family', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline', 'xmlns', 'xmlns:xlink',
  'role', 'aria-label', 'aria-hidden', 'focusable', 'tabindex', 'data-optiai-original-viewbox', 'data-optiai-offset',
]);
const SAFE_STYLE_PROPERTIES = new Set([
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'color',
  'display', 'visibility', 'clip-path', 'mask', 'filter', 'vector-effect', 'paint-order', 'shape-rendering',
  'font-family', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline',
]);

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function parseViewBox(value) {
  if (!value) return null;
  const numbers = String(value).trim().split(/[\s,]+/).map(Number);
  if (numbers.length !== 4 || numbers.some((number) => !Number.isFinite(number))) return null;
  const [x, y, width, height] = numbers;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height, raw: [x, y, width, height].map((number) => formatNumber(number, 6)).join(' ') };
}

function securityIssue(code, message, detail = null) { return { severity: 'block', code, message, detail }; }

function validateStyle(value) {
  if (/[\\\u0000-\u001f\u007f]|\/\*|@/u.test(value)) return false;
  for (const declaration of value.split(';').map((part) => part.trim()).filter(Boolean)) {
    const separator = declaration.indexOf(':');
    if (separator <= 0) return false;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const cssValue = declaration.slice(separator + 1).trim();
    if (!SAFE_STYLE_PROPERTIES.has(property) || !cssValue || /(?:https?:|data:|javascript:|expression\s*\(|behavior\s*:|-moz-binding)/i.test(cssValue)) return false;
    const withoutLocalUrls = cssValue.replace(/url\(\s*['"]?#[A-Za-z_][\w:.-]*['"]?\s*\)/gi, '');
    if (/url\s*\(/i.test(withoutLocalUrls)) return false;
  }
  return true;
}

function validateUrl(value) {
  const trimmed = value.trim();
  return /^#[A-Za-z_][\w:.-]*$/.test(trimmed);
}

export function loadSvg(path) {
  const realpath = canonicalPath(path);
  const size = statSync(realpath).size;
  if (size > MAX_BYTES) {
    return { realpath, filename: basename(realpath), sha256: null, byteLength: size, source: '', document: null, root: null, sanitized: null, security: { status: 'blocked', issues: [securityIssue('input-too-large', `SVG exceeds ${MAX_BYTES} bytes.`)] }, viewBox: null, features: {} };
  }
  const bytes = readFileSync(realpath);
  const source = bytes.toString('utf8');
  const binding = { realpath, filename: basename(realpath), sha256: sha256(bytes), byteLength: bytes.length };
  const preflight = [];
  if (bytes.length > MAX_BYTES) preflight.push(securityIssue('input-too-large', `SVG exceeds ${MAX_BYTES} bytes.`));
  if (/<!DOCTYPE/i.test(source)) preflight.push(securityIssue('unsafe-doctype', 'DOCTYPE declarations are not allowed.'));
  if (/<!ENTITY/i.test(source)) preflight.push(securityIssue('unsafe-entity', 'ENTITY declarations are not allowed.'));
  const withoutDeclaration = source.replace(/^\uFEFF?\s*<\?xml\s[^?]*\?>/i, '');
  if (/<\?/u.test(withoutDeclaration)) preflight.push(securityIssue('unsafe-processing-instruction', 'XML processing instructions are not allowed.'));
  const apparentElements = source.match(/<(?!!|\?|\/)[A-Za-z_][\w:.-]*(?:\s|\/?>)/g)?.length ?? 0;
  if (apparentElements > MAX_ELEMENTS) preflight.push(securityIssue('too-many-elements', `SVG exceeds ${MAX_ELEMENTS} elements.`));
  if (preflight.length) return { ...binding, source, document: null, root: null, sanitized: null, security: { status: 'blocked', issues: preflight }, viewBox: null, features: {} };

  let document;
  try { document = new DOMParser({ onError: onWarningStopParsing }).parseFromString(source, 'image/svg+xml'); }
  catch (error) { return { ...binding, source, document: null, root: null, sanitized: null, security: { status: 'blocked', issues: [securityIssue('invalid-xml', error.message)] }, viewBox: null, features: {} }; }
  const root = document.documentElement;
  const issues = [];
  if (!root || root.localName !== 'svg' || root.namespaceURI !== SVG_NS) issues.push(securityIssue('invalid-svg-root', 'The document must have one SVG namespace root.'));
  for (let child = document.firstChild; child; child = child.nextSibling) {
    if (child === root || child.nodeType === 8 || (child.nodeType === 3 && !child.nodeValue.trim())) continue;
    issues.push(securityIssue('unsafe-document-node', 'Only comments and whitespace may appear outside the SVG root.'));
  }
  let count = 0;
  const featureCounts = { masks: 0, clipPaths: 0, filters: 0, text: 0, uses: 0, gradients: 0, hasStroke: false, hasTransform: false, hasTransparentFiller: false, hasNonScalingStroke: false };

  const visit = (node, depth) => {
    count += 1;
    const name = node.localName;
    if (node.namespaceURI !== SVG_NS) issues.push(securityIssue('foreign-namespace', `Foreign namespace on <${name}>.`));
    if (BLOCKED_ELEMENTS.has(name)) issues.push(securityIssue(`unsafe-element-${name}`, `<${name}> is not allowed.`));
    else if (!ALLOWED_ELEMENTS.has(name)) issues.push(securityIssue('unsupported-element', `<${name}> is not in the safe SVG allowlist.`, name));
    if (name === 'mask') featureCounts.masks += 1;
    if (name === 'clipPath') featureCounts.clipPaths += 1;
    if (name === 'filter') featureCounts.filters += 1;
    if (name === 'text' || name === 'tspan') featureCounts.text += 1;
    if (name === 'use') featureCounts.uses += 1;
    if (name === 'linearGradient' || name === 'radialGradient') featureCounts.gradients += 1;
    for (let index = 0; index < node.attributes.length; index += 1) {
      const attr = node.attributes.item(index);
      const attrName = attr.name;
      const local = attr.localName;
      const value = attr.value;
      if (/^on/i.test(local)) { issues.push(securityIssue('unsafe-event-attribute', `${attrName} is not allowed.`)); continue; }
      if ((local === 'href' || attrName === 'xlink:href')) {
        if (!validateUrl(value)) issues.push(securityIssue('external-resource', `Only local fragment references are allowed in ${attrName}.`));
        if (attr.namespaceURI && attr.namespaceURI !== XLINK_NS) issues.push(securityIssue('foreign-attribute-namespace', `Unsupported namespace on ${attrName}.`));
        continue;
      }
      if (!GLOBAL_ATTRIBUTES.has(attrName) && !GLOBAL_ATTRIBUTES.has(local) && !/^data-[\w-]+$/.test(attrName)) {
        issues.push(securityIssue('unsupported-attribute', `${attrName} is not in the safe attribute allowlist.`));
        continue;
      }
      if (local === 'style' && !validateStyle(value)) issues.push(securityIssue('unsafe-style', 'Inline style contains an unsafe resource or expression.'));
      if (['fill', 'stroke', 'clip-path', 'mask', 'filter'].includes(local) && /url\s*\(/i.test(value) && !/^url\(\s*['"]?#[A-Za-z_][\w:.-]*['"]?\s*\)$/i.test(value.trim())) {
        issues.push(securityIssue('external-resource', `${attrName} may only reference a local fragment.`));
      }
      if (local === 'stroke' && value !== 'none') featureCounts.hasStroke = true;
      if (local === 'transform') featureCounts.hasTransform = true;
      if ((local === 'opacity' || local === 'fill-opacity') && Number(value) === 0) featureCounts.hasTransparentFiller = true;
      if (local === 'vector-effect' && value === 'non-scaling-stroke') featureCounts.hasNonScalingStroke = true;
    }
  };
  if (root) {
    const stack = [{ node: root, depth: 1 }];
    while (stack.length) {
      const current = stack.pop();
      if (current.depth > MAX_DEPTH) { issues.push(securityIssue('tree-too-deep', `SVG exceeds nesting depth ${MAX_DEPTH}.`)); break; }
      if (current.node.nodeType !== 1) continue;
      visit(current.node, current.depth);
      if (count > MAX_ELEMENTS) { issues.push(securityIssue('too-many-elements', `SVG exceeds ${MAX_ELEMENTS} elements.`)); break; }
      for (let child = current.node.lastChild; child; child = child.previousSibling) stack.push({ node: child, depth: current.depth + 1 });
    }
  }
  const viewBox = root ? parseViewBox(root.getAttribute('viewBox')) : null;
  if (!viewBox) issues.push(securityIssue('invalid-viewbox', 'A finite positive viewBox is required.'));
  const status = issues.length ? 'blocked' : 'safe';
  const sanitized = status === 'safe' ? new XMLSerializer().serializeToString(root) : null;
  return { ...binding, source, document, root, sanitized, sanitizedSha256: sanitized ? sha256(sanitized) : null, security: { status, issues }, viewBox, features: featureCounts };
}

export function validateAudit(svg, audit) {
  if (audit?.schemaVersion !== 2 || audit?.tool !== 'OptiAI') fail('Unsupported or invalid audit schema.', 'audit-schema-unsupported', 2);
  if (!audit.source || !/^[a-f0-9]{64}$/.test(audit.source.sha256 ?? '')) fail('Audit source binding is invalid.', 'audit-binding-invalid', 2);
  if (!Array.isArray(audit.targetSizes) || !audit.targetSizes.length || audit.targetSizes.length > 32 || audit.targetSizes.some((size) => !Number.isInteger(size) || size < 1 || size > 512)) fail('Audit target sizes are invalid.', 'audit-sizes-invalid', 2);
  if (!['ensemble', 'centroid', 'none'].includes(audit.engine?.name) || !['icon-only', 'icon-text', 'logo', 'unknown'].includes(audit.context)) fail('Audit request parameters are invalid.', 'audit-request-invalid', 2);
  if (audit.source.realpath !== svg.realpath) fail('Audit was created for a different source path.', 'audit-input-path-mismatch', 2);
  if (audit.source.sha256 !== svg.sha256 || audit.source.byteLength !== svg.byteLength) fail('Source bytes changed after the audit.', 'audit-input-hash-mismatch', 2);
  if (audit.source.viewBox?.raw !== svg.viewBox?.raw) fail('Source viewBox changed after the audit.', 'audit-input-viewbox-mismatch', 2);
  if (svg.security.status !== 'safe') fail('Source is not safe to render.', 'unsafe-source', 2);
  return true;
}

export function buildCandidate(svg, correction) {
  if (!svg.sanitized) fail('Cannot build a candidate from an unsafe SVG.', 'unsafe-source', 2);
  const document = new DOMParser({ onError: onWarningStopParsing }).parseFromString(svg.sanitized, 'image/svg+xml');
  const root = document.documentElement;
  const x = svg.viewBox.x - (correction.dxPercent / 100) * svg.viewBox.width;
  const y = svg.viewBox.y - (correction.dyPercent / 100) * svg.viewBox.height;
  const raw = [x, y, svg.viewBox.width, svg.viewBox.height].map((value) => formatNumber(value, 6)).join(' ');
  root.setAttribute('viewBox', raw);
  root.setAttribute('data-optiai-original-viewbox', svg.viewBox.raw);
  root.setAttribute('data-optiai-offset', `${formatNumber(correction.dxPercent, 6)}% ${formatNumber(correction.dyPercent, 6)}%`);
  const bytes = new XMLSerializer().serializeToString(root);
  return { bytes, sha256: sha256(bytes), viewBox: { x, y, width: svg.viewBox.width, height: svg.viewBox.height, raw } };
}

export function withRootColor(svg, color) {
  const document = new DOMParser({ onError: onWarningStopParsing }).parseFromString(svg, 'image/svg+xml');
  document.documentElement.setAttribute('color', color);
  if (!document.documentElement.hasAttribute('fill') && !document.documentElement.hasAttribute('style')) document.documentElement.setAttribute('fill', color);
  return new XMLSerializer().serializeToString(document.documentElement);
}

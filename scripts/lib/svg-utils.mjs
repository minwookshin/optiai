import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export function parseArgs(argv) {
  const result = { _: [] };
  const booleanFlags = new Set(['help', 'rtl', 'in-place', 'yes', 'no-backup']);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      result._.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    if (equals !== -1) {
      result[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }
    const key = token.slice(2);
    if (booleanFlags.has(key)) {
      result[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      result[key] = next;
      i += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

export function fail(message, code = 1) {
  process.stderr.write(`OptiAI: ${message}\n`);
  process.exit(code);
}

export function parseCsv(value, fallback = []) {
  if (value === undefined || value === true || value === '') return fallback;
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseSizes(value, fallback = [16, 20, 24, 32, 48]) {
  const sizes = parseCsv(value, fallback).map(Number).filter((number) => Number.isFinite(number) && number > 0);
  return [...new Set(sizes)];
}

export function readSvg(filePath) {
  const absolutePath = resolve(filePath);
  const source = readFileSync(absolutePath, 'utf8');
  const rootMatch = source.match(/<svg\b([^>]*)>/i);
  if (!rootMatch) fail(`${filePath} does not contain an SVG root element.`);
  const closingIndex = source.toLowerCase().lastIndexOf('</svg>');
  if (closingIndex === -1) fail(`${filePath} does not contain a closing </svg> tag.`);
  const attributes = parseAttributes(rootMatch[1]);
  const viewBox = parseViewBox(attributes.viewBox ?? attributes.viewbox);
  const rootStart = rootMatch.index ?? 0;
  const rootEnd = rootStart + rootMatch[0].length;
  return {
    absolutePath,
    filename: basename(absolutePath),
    source,
    rootTag: rootMatch[0],
    attributes,
    viewBox,
    innerMarkup: source.slice(rootEnd, closingIndex),
    features: inspectFeatures(source),
  };
}

export function parseAttributes(attributeText) {
  const attributes = {};
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(attributeText)) !== null) {
    attributes[match[1]] = match[2] ?? match[3] ?? '';
  }
  return attributes;
}

export function parseViewBox(value) {
  if (!value) return null;
  const numbers = String(value).trim().split(/[\s,]+/).map(Number);
  if (numbers.length !== 4 || numbers.some((number) => !Number.isFinite(number))) return null;
  const [x, y, width, height] = numbers;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height, raw: `${formatNumber(x)} ${formatNumber(y)} ${formatNumber(width)} ${formatNumber(height)}` };
}

export function inspectFeatures(source) {
  const count = (tag) => (source.match(new RegExp(`<${tag}\\b`, 'gi')) ?? []).length;
  return {
    paths: count('path'),
    primitiveShapes: ['rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline'].reduce((sum, tag) => sum + count(tag), 0),
    groups: count('g'),
    uses: count('use'),
    masks: count('mask'),
    clipPaths: count('clipPath'),
    filters: count('filter'),
    gradients: count('linearGradient') + count('radialGradient'),
    hasStroke: /\bstroke\s*=\s*["'][^"']+["']/i.test(source) || /\bstroke\s*:/i.test(source),
    hasTransform: /\btransform\s*=\s*["']/i.test(source),
    hasExternalReference: /(?:href|xlink:href)\s*=\s*["'](?:https?:|\/\/|data:)/i.test(source),
    hasTransparentFiller: /(?:opacity|fill-opacity)\s*=\s*["']0(?:\.0+)?["']/i.test(source),
    hasLowOpacityFiller: /(?:opacity|fill-opacity)\s*=\s*["']0?\.0+[1-9]\d*["']/i.test(source),
    hasNonScalingStroke: /vector-effect\s*=\s*["']non-scaling-stroke["']/i.test(source),
  };
}

export function runOpticalCenter(filePath) {
  const command = spawnSync(
    'npx',
    ['--yes', 'optical-center@0.2.0-alpha.0', 'info', resolve(filePath), '--json'],
    { encoding: 'utf8', shell: false, maxBuffer: 5 * 1024 * 1024 },
  );
  if (command.error) {
    return { ok: false, error: command.error.message, status: command.status };
  }
  if (command.status !== 0) {
    return { ok: false, error: command.stderr.trim() || command.stdout.trim() || `exit ${command.status}`, status: command.status };
  }
  try {
    const start = command.stdout.indexOf('{');
    const end = command.stdout.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON object was returned.');
    return { ok: true, data: JSON.parse(command.stdout.slice(start, end + 1)) };
  } catch (error) {
    return { ok: false, error: `Could not parse optical-center output: ${error.message}`, status: command.status };
  }
}

export function writeOutput(path, content) {
  if (!path) {
    process.stdout.write(content.endsWith('\n') ? content : `${content}\n`);
    return;
  }
  const absolutePath = resolve(path);
  const temporaryPath = resolve(dirname(absolutePath), `.${basename(absolutePath)}.${process.pid}.tmp`);
  try {
    writeFileSync(temporaryPath, content, 'utf8');
    renameSync(temporaryPath, absolutePath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch {}
    fail(`Could not write ${absolutePath}: ${error.message}`);
  }
  process.stdout.write(`${absolutePath}\n`);
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (error) {
    fail(`Could not read JSON from ${path}: ${error.message}`);
  }
}

export function formatNumber(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const rounded = Number(value.toFixed(digits));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

export function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function offsetViewBox(viewBox, dxPercent, dyPercent) {
  if (!viewBox) return null;
  const x = viewBox.x - (dxPercent / 100) * viewBox.width;
  const y = viewBox.y - (dyPercent / 100) * viewBox.height;
  return `${formatNumber(x)} ${formatNumber(y)} ${formatNumber(viewBox.width)} ${formatNumber(viewBox.height)}`;
}

export function getRecommendation(analysis) {
  const recommendation = analysis?.recommendation;
  if (!recommendation || !Number.isFinite(recommendation.dxPercent) || !Number.isFinite(recommendation.dyPercent)) {
    fail('The analysis does not contain a usable correction recommendation.');
  }
  return recommendation;
}

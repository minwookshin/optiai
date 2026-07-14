#!/usr/bin/env node
import { copyFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fail, formatNumber, getRecommendation, offsetViewBox, parseArgs, readJson, readSvg, writeOutput } from './lib/svg-utils.mjs';

const HELP = `Usage: apply-correction.mjs <input.svg> --analysis audit.json [options]

Options:
  --output PATH   Write a corrected copy
  --dx-percent N  Override the reviewed horizontal correction
  --dy-percent N  Override the reviewed vertical correction
  --in-place      Overwrite the source (requires --yes)
  --yes           Confirm an in-place edit
  --no-backup     Do not create <input>.bak during an in-place edit
  --help          Show this help
`;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
const input = args._[0];
if (!input) fail('Provide an input SVG.');
if (!args.analysis || args.analysis === true) fail('Provide --analysis audit.json.');
if (args['in-place'] && !args.yes) fail('In-place editing requires --yes.');
if (!args['in-place'] && (!args.output || args.output === true)) fail('Provide --output PATH, or use --in-place --yes.');

const svg = readSvg(input);
if (!svg.viewBox) fail('Cannot apply a correction because the source has no valid viewBox.');
const analysis = readJson(args.analysis);
const engineRecommendation = getRecommendation(analysis);
if (engineRecommendation.clipDetectedByEngine) fail('Refusing to apply a correction that the engine marked as clipped.');
const parseOverride = (key, fallback) => {
  if (args[key] === undefined) return fallback;
  const value = Number(args[key]);
  if (!Number.isFinite(value)) fail(`--${key} must be a finite number.`);
  return value;
};
const dxPercent = parseOverride('dx-percent', engineRecommendation.dxPercent);
const dyPercent = parseOverride('dy-percent', engineRecommendation.dyPercent);
const reviewedViewBox = offsetViewBox(svg.viewBox, dxPercent, dyPercent);

const setAttribute = (tag, name, value) => {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*')`, 'i');
  const cleaned = tag.replace(pattern, '');
  return cleaned.replace(/\s*\/>$/, ` ${name}="${value}"/>`).replace(/\s*>$/, ` ${name}="${value}">`);
};

let root = svg.rootTag;
root = setAttribute(root, 'viewBox', reviewedViewBox);
root = setAttribute(root, 'data-optiai-original-viewbox', engineRecommendation.originalViewBox);
root = setAttribute(root, 'data-optiai-offset', `${formatNumber(dxPercent)}% ${formatNumber(dyPercent)}%`);
root = setAttribute(root, 'data-optiai-engine', analysis.engine?.package ?? analysis.engine?.requested ?? 'unknown');
const corrected = svg.source.replace(svg.rootTag, root);

const destination = args['in-place'] ? svg.absolutePath : resolve(String(args.output));
if (args['in-place'] && !args['no-backup']) copyFileSync(svg.absolutePath, `${svg.absolutePath}.bak`);
if (args['in-place']) {
  writeFileSync(destination, corrected, 'utf8');
  process.stdout.write(`${destination}\n`);
} else {
  writeOutput(destination, corrected);
}

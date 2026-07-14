#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  escapeXml,
  fail,
  getRecommendation,
  parseArgs,
  parseCsv,
  parseSizes,
  readJson,
  readSvg,
  writeOutput,
} from './lib/svg-utils.mjs';

const HELP = `Usage: render-comparison.mjs <input.svg> --analysis audit.json [options]

Options:
  --sizes LIST         Comma-separated sizes (default: analysis sizes)
  --themes LIST        light,dark (default: light,dark)
  --dx-percent NUMBER  Override the horizontal engine proposal
  --dy-percent NUMBER  Override the vertical engine proposal
  --output PATH        Output SVG path (default: stdout)
  --help               Show this help
`;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
const input = args._[0];
if (!input) fail('Provide an input SVG.');
if (!args.analysis || args.analysis === true) fail('Provide --analysis audit.json.');

const svg = readSvg(input);
const analysis = readJson(args.analysis);
const engineRecommendation = getRecommendation(analysis);
const parseOverride = (key, fallback) => {
  if (args[key] === undefined) return fallback;
  const value = Number(args[key]);
  if (!Number.isFinite(value)) fail(`--${key} must be a finite number.`);
  return value;
};
const recommendation = {
  ...engineRecommendation,
  dxPercent: parseOverride('dx-percent', engineRecommendation.dxPercent),
  dyPercent: parseOverride('dy-percent', engineRecommendation.dyPercent),
};
const sizes = parseSizes(args.sizes, analysis.targetSizes ?? [16, 20, 24, 32, 48]);
const themes = parseCsv(args.themes, ['light', 'dark']);
if (sizes.length === 0) fail('Provide at least one positive size.');
if (themes.some((theme) => !['light', 'dark'].includes(theme))) fail('Themes must be light and/or dark.');

const width = 1040;
const headerHeight = 112;
const themeHeaderHeight = 34;
const rowHeight = 82;
const footerHeight = 36;
const height = headerHeight + themes.length * (themeHeaderHeight + sizes.length * rowHeight) + footerHeight;
const columns = [40, 370, 700];
const cellWidth = 300;
const content = [];

content.push(`
  <g font-family="ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">
    <text x="40" y="42" fill="#f5f7fa" font-size="24" font-weight="700">OptiAI optical alignment comparison</text>
    <text x="40" y="68" fill="#9aa4b2" font-size="13">${escapeXml(svg.filename)} · dx ${recommendation.dxPercent.toFixed(4)}% · dy ${recommendation.dyPercent.toFixed(4)}% · confidence ${escapeXml(recommendation.confidence)}</text>
    <text x="${columns[0]}" y="100" fill="#d5d9e0" font-size="14" font-weight="600">Source</text>
    <text x="${columns[1]}" y="100" fill="#d5d9e0" font-size="14" font-weight="600">Geometric guides</text>
    <text x="${columns[2]}" y="100" fill="#d5d9e0" font-size="14" font-weight="600">OptiAI proposal</text>
  </g>`);
content.push(`<defs><g id="optiai-artwork">${svg.innerMarkup}</g></defs>`);

let y = headerHeight;
for (const theme of themes) {
  const palette = theme === 'dark'
    ? { background: '#171b22', border: '#303746', label: '#c8d0dc', guide: '#7a8699', pattern: 'url(#optiai-grid-dark)', color: '#ffffff' }
    : { background: '#f7f8fa', border: '#d7dce3', label: '#3d4653', guide: '#8792a2', pattern: 'url(#optiai-grid-light)', color: '#111318' };
  content.push(`<rect x="24" y="${y}" width="992" height="${themeHeaderHeight + sizes.length * rowHeight}" rx="12" fill="#12151b" stroke="#2b313d"/>`);
  content.push(`<text x="40" y="${y + 23}" fill="#aeb7c5" font-family="ui-sans-serif, -apple-system, sans-serif" font-size="12" font-weight="700" letter-spacing="1">${theme.toUpperCase()}</text>`);
  y += themeHeaderHeight;

  for (const size of sizes) {
    const cellY = y + 7;
    for (let column = 0; column < columns.length; column += 1) {
      const x = columns[column];
      content.push(`<rect x="${x}" y="${cellY}" width="${cellWidth}" height="68" rx="10" fill="${palette.background}" stroke="${palette.border}"/>`);
      if (column > 0) content.push(`<rect x="${x}" y="${cellY}" width="${cellWidth}" height="68" rx="10" fill="${palette.pattern}" opacity="0.55"/>`);
      const iconX = x + 132;
      const iconY = cellY + (68 - size) / 2;
      const centerX = iconX + size / 2;
      const centerY = iconY + size / 2;
      if (column > 0) {
        content.push(`<path d="M${centerX} ${cellY + 8}V${cellY + 60}M${x + 106} ${centerY}H${x + 194}" stroke="${palette.guide}" stroke-width="0.75" stroke-dasharray="3 3"/>`);
      }
      const dxUnits = column === 2 ? (recommendation.dxPercent / 100) * svg.viewBox.width : 0;
      const dyUnits = column === 2 ? (recommendation.dyPercent / 100) * svg.viewBox.height : 0;
      content.push(`<svg x="${iconX}" y="${iconY}" width="${size}" height="${size}" viewBox="${escapeXml(svg.viewBox.raw)}" overflow="visible" style="color:${palette.color}"><use href="#optiai-artwork" transform="translate(${dxUnits} ${dyUnits})"/></svg>`);
      content.push(`<text x="${x + 12}" y="${cellY + 39}" fill="${palette.label}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11">${size}px</text>`);
    }
    y += rowHeight;
  }
}

content.push(`<text x="40" y="${height - 16}" fill="#788394" font-family="ui-sans-serif, -apple-system, sans-serif" font-size="11">Algorithmic output is a proposal. Review the rasterized result before changing brand or production assets.</text>`);

const templatePath = fileURLToPath(new URL('../assets/comparison-template.svg', import.meta.url));
const template = readFileSync(templatePath, 'utf8');
const rendered = template
  .replaceAll('{{WIDTH}}', String(width))
  .replaceAll('{{HEIGHT}}', String(height))
  .replace('{{CONTENT}}', content.join('\n'));
writeOutput(args.output, rendered);

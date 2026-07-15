#!/usr/bin/env node
import { validateDerivedAudit } from './lib/audit-model.mjs';
import { assertKnownArgs, escapeXml, guardOutput, handleCliError, parseArgs, parseCorrection, parseCsv, parseSizes, readJson, writeOutput, fail } from './lib/svg-utils.mjs';
import { buildCandidate, loadSvg, validateAudit, withRootColor } from './lib/svg-document.mjs';
import { rasterPng } from './lib/raster.mjs';

const HELP = `Usage: render-comparison.mjs <input.svg> --analysis audit.json [options]

Options:
  --sizes LIST         Comma-separated target sizes
  --themes LIST        light,dark (default: both)
  --dx-percent NUMBER  Reviewed horizontal value
  --dy-percent NUMBER  Reviewed vertical value
  --output PATH        Output comparison SVG
  --help               Show this help
`;

try {
  const args = parseArgs(process.argv.slice(2));
  assertKnownArgs(args, ['help', 'analysis', 'sizes', 'themes', 'dx-percent', 'dy-percent', 'output']);
  if (args.help) { process.stdout.write(HELP); process.exit(0); }
  if (!args._[0]) fail('Provide an input SVG.');
  if (!args.analysis || args.analysis === true) fail('Provide --analysis audit.json.');
  const svg = loadSvg(args._[0]);
  guardOutput(svg.realpath, args.output);
  guardOutput(args.analysis, args.output);
  const audit = readJson(args.analysis);
  validateAudit(svg, audit);
  validateDerivedAudit(svg, audit);
  if (audit.decision?.status === 'ABSTAIN') fail('The audit abstained; there is no safe proposal to compare.', 'audit-abstained', 2);
  const correction = parseCorrection(args, audit.recommendation);
  const candidate = buildCandidate(svg, correction);
  const sizes = parseSizes(args.sizes, audit.targetSizes);
  const themes = parseCsv(args.themes, ['light', 'dark']);
  if (!themes.length || themes.some((theme) => !['light', 'dark'].includes(theme))) fail('Themes must be light and/or dark.');
  const rows = [];
  let y = 92;
  for (const theme of themes) {
    const background = theme === 'dark' ? '#11151b' : '#fff';
    const foreground = theme === 'dark' ? '#fff' : '#111';
    rows.push(`<text x="32" y="${y + 18}" fill="#9ca6b5" font-family="sans-serif" font-size="11" font-weight="700">${theme.toUpperCase()}</text>`);
    y += 28;
    for (const size of sizes) {
      const sourcePng = rasterPng(withRootColor(svg.sanitized, foreground), size).toString('base64');
      const candidatePng = rasterPng(withRootColor(candidate.bytes, foreground), size).toString('base64');
      rows.push(`<text x="32" y="${y + 27}" fill="#c7ced9" font-family="monospace" font-size="12">${size}px</text>`);
      rows.push(`<rect x="100" y="${y}" width="180" height="54" rx="8" fill="${background}"/><image x="${190 - size / 2}" y="${y + 27 - size / 2}" width="${size}" height="${size}" href="data:image/png;base64,${sourcePng}"/>`);
      rows.push(`<rect x="310" y="${y}" width="180" height="54" rx="8" fill="${background}"/><path d="M400 ${y + 5}V${y + 49}M378 ${y + 27}H422" stroke="#7f8998" stroke-dasharray="3 3"/><image x="${400 - size / 2}" y="${y + 27 - size / 2}" width="${size}" height="${size}" href="data:image/png;base64,${candidatePng}"/>`);
      y += 68;
    }
  }
  const output = `<svg xmlns="http://www.w3.org/2000/svg" width="522" height="${y + 24}" viewBox="0 0 522 ${y + 24}" data-optiai-source-sha256="${svg.sha256}" data-optiai-candidate-sha256="${candidate.sha256}" data-optiai-sizes="${sizes.join(',')}" data-optiai-themes="${themes.join(',')}"><rect width="100%" height="100%" fill="#171b22"/><text x="32" y="34" fill="#fff" font-family="sans-serif" font-size="20" font-weight="700">OptiAI reviewed comparison</text><text x="32" y="58" fill="#9ca6b5" font-family="sans-serif" font-size="12">${escapeXml(svg.filename)} · dx ${correction.dxPercent}% · dy ${correction.dyPercent}% · evidence experimental</text><text x="160" y="82" fill="#c7ced9" font-family="sans-serif" font-size="12">SOURCE</text><text x="362" y="82" fill="#c7ced9" font-family="sans-serif" font-size="12">REVIEWED</text>${rows.join('')}</svg>\n`;
  writeOutput(args.output, output);
} catch (error) { handleCliError(error); }

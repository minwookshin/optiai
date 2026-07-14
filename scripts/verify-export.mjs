#!/usr/bin/env node
import { extname } from 'node:path';
import { fail, parseArgs, readJson, readSvg, writeOutput } from './lib/svg-utils.mjs';

const HELP = `Usage: verify-export.mjs <input.svg> [options]

Options:
  --analysis PATH         Include an OptiAI analysis JSON
  --format json|markdown  Output format
  --output PATH           Write the result to a file
  --help                  Show this help
`;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
const input = args._[0];
if (!input) fail('Provide an input SVG.');
const svg = readSvg(input);
const analysis = args.analysis && args.analysis !== true ? readJson(args.analysis) : null;
const issues = [];
const add = (severity, code, message) => issues.push({ severity, code, message });

if (!svg.viewBox) add('fail', 'missing-viewbox', 'The root SVG has no valid viewBox.');
if (svg.attributes.width && svg.attributes.height && svg.viewBox) {
  const width = Number.parseFloat(svg.attributes.width);
  const height = Number.parseFloat(svg.attributes.height);
  if (Number.isFinite(width) && Number.isFinite(height)) {
    const viewportRatio = width / height;
    const viewBoxRatio = svg.viewBox.width / svg.viewBox.height;
    if (Math.abs(viewportRatio - viewBoxRatio) > 0.01) add('warn', 'aspect-ratio-mismatch', 'Root width/height and viewBox use different aspect ratios.');
  }
}
if (svg.features.masks) add('warn', 'masks', `${svg.features.masks} mask element(s) require visual export review.`);
if (svg.features.clipPaths) add('warn', 'clip-paths', `${svg.features.clipPaths} clipPath element(s) may hide corrected artwork.`);
if (svg.features.filters) add('warn', 'filters', `${svg.features.filters} filter element(s) can extend outside the geometric bounds.`);
if (svg.features.hasStroke) add('warn', 'stroke-overflow', 'Strokes may extend beyond the viewBox after tightening or shifting it.');
if (svg.features.hasExternalReference) add('warn', 'external-reference', 'External or data references can render differently after handoff.');
if (svg.features.hasTransparentFiller) add('warn', 'transparent-filler', 'Fully transparent filler geometry may be removed by design-tool export.');
if (svg.features.hasLowOpacityFiller) add('warn', 'low-opacity-filler', 'Low-opacity filler geometry may affect bounds, compositing, or hit testing.');
if (svg.features.hasNonScalingStroke) add('warn', 'non-scaling-stroke', 'Non-scaling strokes need inspection at each production size.');
if (/\boverflow\s*=\s*["']hidden["']/i.test(svg.rootTag)) add('warn', 'root-overflow-hidden', 'Root overflow is hidden and can clip strokes or filters.');

if (analysis?.engine?.error) add('warn', 'engine-error', `Correction engine error: ${analysis.engine.error}`);
if (analysis?.recommendation?.clipDetectedByEngine) add('fail', 'engine-clipping', 'The correction engine detected clipping in the proposed viewBox.');
if (analysis?.recommendation) {
  const magnitude = Math.hypot(analysis.recommendation.dxPercent, analysis.recommendation.dyPercent);
  if (magnitude > 5) add('warn', 'large-correction', 'The proposed correction exceeds 5% and likely indicates a bounds or semantic-weight problem.');
  if (analysis.context === 'logo') add('warn', 'brand-review', 'Logo corrections require explicit brand-owner approval.');
}

const failures = issues.filter((issue) => issue.severity === 'fail').length;
const warnings = issues.filter((issue) => issue.severity === 'warn').length;
const report = {
  schemaVersion: 1,
  tool: 'OptiAI',
  input: svg.absolutePath,
  status: failures ? 'fail' : warnings ? 'review' : 'pass',
  summary: { failures, warnings },
  issues,
};

function markdown(audit) {
  const lines = [
    '# OptiAI export verification',
    '',
    `- Input: \`${audit.input}\``,
    `- Status: \`${audit.status}\``,
    `- Failures: ${audit.summary.failures}`,
    `- Warnings: ${audit.summary.warnings}`,
    '',
    '## Findings',
    '',
    ...(audit.issues.length ? audit.issues.map((issue) => `- **${issue.severity.toUpperCase()} · ${issue.code}**: ${issue.message}`) : ['- No structural export risks detected.']),
  ];
  return `${lines.join('\n')}\n`;
}

const inferredFormat = args.output && extname(String(args.output)).toLowerCase() === '.md' ? 'markdown' : 'json';
const format = args.format ?? inferredFormat;
if (!['json', 'markdown'].includes(format)) fail(`Unsupported format: ${format}`);
writeOutput(args.output, format === 'markdown' ? markdown(report) : `${JSON.stringify(report, null, 2)}\n`);
if (failures) process.exitCode = 2;

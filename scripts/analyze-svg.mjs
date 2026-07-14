#!/usr/bin/env node
import { extname } from 'node:path';
import {
  fail,
  formatNumber,
  offsetViewBox,
  parseArgs,
  parseSizes,
  readSvg,
  runOpticalCenter,
  writeOutput,
} from './lib/svg-utils.mjs';

const HELP = `Usage: analyze-svg.mjs <input.svg> [options]

Options:
  --engine optical-center|none  Correction engine (default: optical-center)
  --context TYPE               icon-only, icon-text, logo, or unknown
  --sizes LIST                 Comma-separated target sizes
  --rtl                        Mirror the horizontal recommendation
  --format json|markdown       Output format (inferred from --output when possible)
  --output PATH                Write the audit to a file
  --help                       Show this help
`;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const input = args._[0];
if (!input) fail('Provide an input SVG. Run with --help for usage.');
const engine = args.engine ?? 'optical-center';
if (!['optical-center', 'none'].includes(engine)) fail(`Unsupported engine: ${engine}`);
const context = args.context ?? 'unknown';
if (!['icon-only', 'icon-text', 'logo', 'unknown'].includes(context)) fail(`Unsupported context: ${context}`);
const sizes = parseSizes(args.sizes);
if (sizes.length === 0) fail('Provide at least one positive target size.');

const svg = readSvg(input);
const warnings = [];
const diagnosis = [];

if (!svg.viewBox) {
  diagnosis.push({ category: 'svg-bounds', likelihood: 'high', evidence: 'The root SVG has no valid viewBox.' });
} else {
  diagnosis.push({ category: 'svg-bounds', likelihood: 'low', evidence: `The root viewBox is ${svg.viewBox.raw}.` });
}

if (context === 'icon-text') {
  diagnosis.push({ category: 'text-baseline', likelihood: 'possible', evidence: 'The asset is used beside text; font metrics and inline layout require separate inspection.' });
}
if (context === 'logo') warnings.push('Brand logo context: preserve artwork and require explicit visual approval before modification.');
if (svg.features.hasExternalReference) warnings.push('The SVG contains an external or data reference that may change bounds or rendering.');
if (svg.features.masks || svg.features.clipPaths || svg.features.filters) warnings.push('Masks, clipping paths, or filters reduce confidence and require manual review.');
if (svg.features.hasTransparentFiller || svg.features.hasLowOpacityFiller) warnings.push('Transparent or low-opacity filler geometry may be removed or altered during export.');
if (svg.features.hasStroke) warnings.push('Stroke caps, joins, and overflow may change perceived mass and clipping.');

let engineResult = null;
let engineError = null;
if (engine === 'optical-center') {
  const execution = runOpticalCenter(svg.absolutePath);
  if (execution.ok) {
    engineResult = execution.data;
  } else {
    engineError = execution.error;
    warnings.push(`The experimental optical-center engine failed: ${execution.error}`);
  }
}

let recommendation = null;
if (engineResult?.result && svg.viewBox) {
  const measuredDx = Number(engineResult.result.offset?.dxPercent);
  const measuredDy = Number(engineResult.result.offset?.dyPercent);
  if (Number.isFinite(measuredDx) && Number.isFinite(measuredDy)) {
    const dxPercent = args.rtl ? -measuredDx : measuredDx;
    const dyPercent = measuredDy;
    const magnitude = Math.hypot(dxPercent, dyPercent);
    const complex = context === 'logo'
      || svg.features.masks > 0
      || svg.features.clipPaths > 0
      || svg.features.filters > 0
      || svg.features.hasExternalReference;
    const confidence = complex || magnitude > 5 ? 'low' : 'medium';
    recommendation = {
      dxPercent,
      dyPercent,
      direction: {
        horizontal: dxPercent > 0 ? 'right' : dxPercent < 0 ? 'left' : 'none',
        vertical: dyPercent > 0 ? 'down' : dyPercent < 0 ? 'up' : 'none',
      },
      pixelOffsets: sizes.map((size) => ({
        size,
        dx: Number(((dxPercent / 100) * size).toFixed(4)),
        dy: Number(((dyPercent / 100) * size).toFixed(4)),
      })),
      originalViewBox: svg.viewBox.raw,
      newViewBox: offsetViewBox(svg.viewBox, dxPercent, dyPercent),
      confidence,
      requiresVisualApproval: true,
      clipDetectedByEngine: Boolean(engineResult.result.clipDetected),
    };
    warnings.push('Review horizontal and vertical axes independently; the experimental engine can introduce a model-level directional bias.');
    diagnosis.push({
      category: 'optical-perception',
      likelihood: magnitude < 0.25 ? 'low' : 'likely',
      evidence: `The engine proposes ${formatNumber(dxPercent)}% horizontally and ${formatNumber(dyPercent)}% vertically.`,
    });
    if (magnitude > 5) warnings.push('The proposed displacement exceeds 5%; investigate malformed bounds or semantically detached artwork before applying it.');
    if (engineResult.result.clipDetected) warnings.push('The engine detected potential clipping in the proposed viewBox.');
  }
}

if (!recommendation && engine === 'none') {
  diagnosis.push({ category: 'optical-perception', likelihood: 'unmeasured', evidence: 'No correction engine was requested.' });
}

const report = {
  schemaVersion: 1,
  tool: 'OptiAI',
  input: svg.absolutePath,
  context,
  rtl: Boolean(args.rtl),
  targetSizes: sizes,
  geometry: {
    viewBox: svg.viewBox,
    width: svg.attributes.width ?? null,
    height: svg.attributes.height ?? null,
    preserveAspectRatio: svg.attributes.preserveAspectRatio ?? svg.attributes.preserveaspectratio ?? null,
  },
  features: svg.features,
  diagnosis,
  recommendation,
  warnings,
  engine: {
    requested: engine,
    package: engineResult?.version?.package ?? null,
    algorithm: engineResult?.version?.algorithm ?? null,
    error: engineError,
  },
};

function markdown(audit) {
  const lines = [
    '# OptiAI SVG audit',
    '',
    `- Input: \`${audit.input}\``,
    `- Context: \`${audit.context}\``,
    `- ViewBox: \`${audit.geometry.viewBox?.raw ?? 'missing'}\``,
    `- Engine: \`${audit.engine.package ?? audit.engine.requested}\``,
    '',
    '## Diagnosis',
    '',
    ...audit.diagnosis.map((item) => `- **${item.category} (${item.likelihood})**: ${item.evidence}`),
    '',
    '## Recommendation',
    '',
  ];
  if (audit.recommendation) {
    lines.push(
      `- Horizontal: \`${formatNumber(audit.recommendation.dxPercent)}%\` (${audit.recommendation.direction.horizontal})`,
      `- Vertical: \`${formatNumber(audit.recommendation.dyPercent)}%\` (${audit.recommendation.direction.vertical})`,
      `- Proposed viewBox: \`${audit.recommendation.newViewBox}\``,
      `- Confidence: \`${audit.recommendation.confidence}\``,
      '- Visual approval required: `yes`',
      '',
      '| Size | dx | dy |',
      '| ---: | ---: | ---: |',
      ...audit.recommendation.pixelOffsets.map((item) => `| ${item.size}px | ${item.dx}px | ${item.dy}px |`),
    );
  } else {
    lines.push('- No optical correction was calculated.');
  }
  lines.push('', '## Warnings', '', ...(audit.warnings.length ? audit.warnings.map((warning) => `- ${warning}`) : ['- None.']));
  return `${lines.join('\n')}\n`;
}

const inferredFormat = args.output && extname(String(args.output)).toLowerCase() === '.md' ? 'markdown' : 'json';
const format = args.format ?? inferredFormat;
if (!['json', 'markdown'].includes(format)) fail(`Unsupported format: ${format}`);
writeOutput(args.output, format === 'markdown' ? markdown(report) : `${JSON.stringify(report, null, 2)}\n`);
if (engineError) process.exitCode = 2;

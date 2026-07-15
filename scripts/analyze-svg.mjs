#!/usr/bin/env node
import { extname } from 'node:path';
import { deriveAudit, derivedDigest } from './lib/audit-model.mjs';
import { loadSvg } from './lib/svg-document.mjs';
import { assertKnownArgs, guardOutput, handleCliError, parseArgs, parseSizes, writeOutput } from './lib/svg-utils.mjs';

const HELP = `Usage: analyze-svg.mjs <input.svg> [options]

Options:
  --engine centroid|none  Transparent alpha-centroid model (default: centroid)
  --context TYPE          icon-only, icon-text, logo, or unknown
  --sizes LIST            Comma-separated target sizes
  --rtl                   Mirror the horizontal proposal
  --format json|markdown  Output format
  --output PATH           Write the immutable audit
  --help                  Show this help
`;

function markdown(report) {
  const lines = ['# OptiAI audit', '', `- Source: \`${report.source.realpath}\``, `- Decision: \`${report.decision.status}\``, `- Security: \`${report.security.status}\``, `- ViewBox: \`${report.source.viewBox?.raw ?? 'invalid'}\``];
  if (report.recommendation) lines.push(`- Proposed offset: \`${report.recommendation.dxPercent}% ${report.recommendation.dyPercent}%\``);
  if (report.decision.reasonCodes.length) lines.push(`- Reasons: ${report.decision.reasonCodes.map((code) => `\`${code}\``).join(', ')}`);
  lines.push('', 'Every proposal requires explicit per-axis visual review before verification and application.');
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  assertKnownArgs(args, ['help', 'engine', 'context', 'sizes', 'rtl', 'format', 'output']);
  if (args.help) { process.stdout.write(HELP); process.exit(0); }
  const input = args._[0];
  if (!input) throw new Error('Provide an input SVG.');
  const engine = args.engine ?? 'centroid';
  if (!['centroid', 'none'].includes(engine)) throw new Error(`Unsupported engine: ${engine}`);
  const context = args.context ?? 'unknown';
  if (!['icon-only', 'icon-text', 'logo', 'unknown'].includes(context)) throw new Error(`Unsupported context: ${context}`);
  const sizes = parseSizes(args.sizes);
  if (!sizes.length) throw new Error('Provide at least one positive target size.');
  const svg = loadSvg(input);
  guardOutput(svg.realpath, args.output);
  let measurements = { reference: { paintedBounds: null, sideBearings: null, centroid: null }, bySize: [] };
  let decision = { status: 'ABSTAIN', reasonCodes: svg.security.issues.map((issue) => issue.code), manualReviewRequired: true };
  let recommendation = null;
  if (svg.security.status === 'safe') {
    ({ measurements, decision, recommendation } = deriveAudit(svg, sizes, engine, context, Boolean(args.rtl)));
  }
  const derived = { measurements, decision, recommendation };
  const primaryDiagnosis = svg.security.status !== 'safe' ? 'unsafe-source'
    : decision.reasonCodes.includes('fix-svg-bounds-first') ? 'svg-bounds'
      : decision.reasonCodes.includes('text-baseline-unverified') ? 'text-baseline'
        : 'optical-perception';
  const report = {
    schemaVersion: 2,
    tool: 'OptiAI',
    source: { realpath: svg.realpath, filename: svg.filename, sha256: svg.sha256, byteLength: svg.byteLength, viewBox: svg.viewBox, sanitizedSha256: svg.sanitizedSha256 },
    security: svg.security,
    context,
    rtl: Boolean(args.rtl),
    targetSizes: sizes,
    features: svg.features,
    diagnosis: { primary: primaryDiagnosis, containerLayout: 'NOT_MEASURED' },
    measurements,
    decision,
    recommendation,
    derivedSha256: derivedDigest(derived),
    engine: { name: engine, model: engine === 'centroid' ? 'alpha-centroid-v1' : null, networkAccess: false },
  };
  const inferred = args.output && extname(String(args.output)).toLowerCase() === '.md' ? 'markdown' : 'json';
  const format = args.format ?? inferred;
  if (!['json', 'markdown'].includes(format)) throw new Error(`Unsupported format: ${format}`);
  writeOutput(args.output, format === 'markdown' ? markdown(report) : `${JSON.stringify(report, null, 2)}\n`);
  if (svg.security.status !== 'safe' || decision.status === 'ABSTAIN') process.exitCode = 2;
} catch (error) { handleCliError(error); }

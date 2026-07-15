#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildPreferenceStudy, renderPreferenceLabHtml } from './lib/preference-lab.mjs';
import { loadSvg, sha256 } from './lib/svg-document.mjs';
import { assertKnownArgs, fail, guardOutput, handleCliError, parseArgs, parseCsv, parseSizes, readJson, writeOutput } from './lib/svg-utils.mjs';

const HELP = `Usage: create-preference-lab.mjs <input.svg> --analysis audit.json [options]

Options:
  --axis x|y|both        Compare one axis or both (default: both)
  --radius-percent N     Symmetric candidate radius, 0.1–5 (default: 2)
  --step-percent N       Candidate interval, 0.1–radius (default: 0.5)
  --sizes LIST           Comma-separated production sizes
  --themes LIST          light,dark (default: both)
  --seed TEXT            Reproducible A/B presentation seed
  --study-output PATH    Write the bound study manifest JSON
  --output PATH          Write the self-contained blinded HTML lab
  --help                 Show this help
`;

try {
  const args = parseArgs(process.argv.slice(2));
  assertKnownArgs(args, ['help', 'analysis', 'axis', 'radius-percent', 'step-percent', 'sizes', 'themes', 'seed', 'study-output', 'output']);
  if (args.help) { process.stdout.write(HELP); process.exit(0); }
  const input = args._[0];
  if (!input) fail('Provide an input SVG.');
  if (!args.analysis || args.analysis === true) fail('Provide --analysis audit.json.');
  if (!args['study-output'] || args['study-output'] === true) fail('Provide --study-output preference-study.json.');
  if (!args.output || args.output === true) fail('Provide --output preference-lab.html.');
  guardOutput(input, args['study-output']);
  guardOutput(input, args.output);
  guardOutput(args.analysis, args['study-output']);
  guardOutput(args.analysis, args.output);
  guardOutput(args['study-output'], args.output);

  const svg = loadSvg(input);
  const audit = readJson(args.analysis);
  const auditBytes = readFileSync(resolve(args.analysis));
  const sizes = parseSizes(args.sizes, audit.targetSizes);
  const themes = parseCsv(args.themes, ['light', 'dark']);
  if (!themes.length || themes.some((theme) => !['light', 'dark'].includes(theme))) fail('Themes must be light and/or dark.');
  const { study, display } = buildPreferenceStudy(svg, audit, sha256(auditBytes), {
    axis: args.axis ?? 'both',
    radiusPercent: args['radius-percent'] ?? 2,
    stepPercent: args['step-percent'] ?? 0.5,
    sizes,
    themes: [...new Set(themes)],
    seed: args.seed ?? 'optiai-v1',
  });
  const html = renderPreferenceLabHtml(study, display);
  writeOutput(args['study-output'], `${JSON.stringify(study, null, 2)}\n`);
  writeOutput(args.output, html);
} catch (error) { handleCliError(error); }

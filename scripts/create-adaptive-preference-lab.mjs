#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildAdaptiveStudy, renderAdaptivePreferenceLabHtml } from './lib/adaptive-preference.mjs';
import { buildPreferenceStudy } from './lib/preference-lab.mjs';
import { loadSvg, sha256 } from './lib/svg-document.mjs';
import { assertKnownArgs, fail, guardOutput, handleCliError, parseArgs, parseCsv, parseSizes, readJson, writeOutput } from './lib/svg-utils.mjs';

const HELP = `Usage: create-adaptive-preference-lab.mjs <input.svg> --analysis audit.json --study-output study.json --output lab.html [options]

Options:
  --axis x|y|both        Compare one axis or both (default: both)
  --radius-percent N     Symmetric candidate radius (default: 2)
  --step-percent N       Candidate interval (default: 0.5)
  --sizes LIST           Comma-separated production sizes
  --themes LIST          light,dark (default: both)
  --seed TEXT            Deterministic acquisition seed
  --max-trials N         Response-driven trials including one repeat (5–32, default: 16)
  --study-output PATH    Write immutable adaptive study JSON
  --output PATH          Write self-contained adaptive HTML lab
`;

try {
  const args = parseArgs(process.argv.slice(2));
  assertKnownArgs(args, ['help', 'analysis', 'axis', 'radius-percent', 'step-percent', 'sizes', 'themes', 'seed', 'max-trials', 'study-output', 'output']);
  if (args.help) { process.stdout.write(HELP); process.exit(0); }
  const input = args._[0];
  if (!input) fail('Provide an input SVG.');
  if (!args.analysis || args.analysis === true) fail('Provide --analysis audit.json.');
  if (!args['study-output'] || args['study-output'] === true) fail('Provide --study-output study.json.');
  if (!args.output || args.output === true) fail('Provide --output lab.html.');
  for (const source of [input, args.analysis]) for (const output of [args['study-output'], args.output]) guardOutput(source, output);
  guardOutput(args['study-output'], args.output);
  const svg = loadSvg(input);
  const audit = readJson(args.analysis);
  const auditBytes = readFileSync(resolve(args.analysis));
  const sizes = parseSizes(args.sizes, audit.targetSizes);
  const themes = [...new Set(parseCsv(args.themes, ['light', 'dark']))];
  if (!themes.length || themes.some((theme) => !['light', 'dark'].includes(theme))) fail('Themes must be light and/or dark.');
  const built = buildPreferenceStudy(svg, audit, sha256(auditBytes), {
    axis: args.axis ?? 'both', radiusPercent: args['radius-percent'] ?? 2, stepPercent: args['step-percent'] ?? 0.5,
    sizes, themes, seed: args.seed ?? 'optiai-v06',
  });
  const study = buildAdaptiveStudy(built.study, { seed: args.seed ?? 'optiai-v06', maxTrials: args['max-trials'] ?? 16 });
  writeOutput(args['study-output'], `${JSON.stringify(study, null, 2)}\n`);
  writeOutput(args.output, renderAdaptivePreferenceLabHtml(study, built.display));
} catch (error) { handleCliError(error); }

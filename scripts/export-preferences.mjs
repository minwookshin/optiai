#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildPreferenceStudy, preferenceRows, validatePreferenceStudy } from './lib/preference-lab.mjs';
import { loadSvg, sha256 } from './lib/svg-document.mjs';
import { assertKnownArgs, fail, guardOutput, handleCliError, parseArgs, readJson, writeOutput } from './lib/svg-utils.mjs';

const HELP = `Usage: export-preferences.mjs <input.svg> response.json [...] --analysis audit.json --study study.json --output training.jsonl

Options:
  --analysis PATH  Bound OptiAI audit
  --study PATH     Bound Preference Lab study manifest
  --output PATH    Write deterministic training JSONL
  --help           Show this help
`;

try {
  const args = parseArgs(process.argv.slice(2));
  assertKnownArgs(args, ['help', 'analysis', 'study', 'output']);
  if (args.help) { process.stdout.write(HELP); process.exit(0); }
  const input = args._[0];
  const responsePaths = args._.slice(1);
  if (!input) fail('Provide the source SVG.');
  if (!responsePaths.length) fail('Provide at least one preference response JSON.');
  if (!args.analysis || args.analysis === true) fail('Provide --analysis audit.json.');
  if (!args.study || args.study === true) fail('Provide --study study.json.');
  if (!args.output || args.output === true) fail('Provide --output training.jsonl.');
  for (const path of [input, args.analysis, args.study, ...responsePaths]) guardOutput(path, args.output);

  const svg = loadSvg(input);
  const audit = readJson(args.analysis);
  const study = readJson(args.study);
  validatePreferenceStudy(study);
  const auditBytes = readFileSync(resolve(args.analysis));
  const rebuilt = buildPreferenceStudy(svg, audit, sha256(auditBytes), {
    axis: study.config.axis,
    radiusPercent: study.config.radiusPercent,
    stepPercent: study.config.stepPercent,
    sizes: study.config.sizes,
    themes: study.config.themes,
    seed: study.config.seed,
  }).study;
  if (JSON.stringify(rebuilt) !== JSON.stringify(study)) fail('Study no longer matches its source, audit, or generated candidates.', 'preference-study-lineage-mismatch', 2);

  const responses = responsePaths.map((path) => readJson(path));
  responses.sort((a, b) => String(a.raterId).toLowerCase().localeCompare(String(b.raterId).toLowerCase()) || String(a.raterId).localeCompare(String(b.raterId)));
  const raters = new Set();
  const rows = [];
  for (const response of responses) {
    const canonicalRater = String(response.raterId).toLowerCase();
    if (raters.has(canonicalRater)) fail('Each export may contain only one case-insensitive response per rater ID.', 'preference-rater-duplicate', 2);
    raters.add(canonicalRater);
    rows.push(...preferenceRows(study, response, audit));
  }
  writeOutput(args.output, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
} catch (error) { handleCliError(error); }

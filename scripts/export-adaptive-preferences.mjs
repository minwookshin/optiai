#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { adaptivePreferenceRows, buildAdaptiveStudy, validateAdaptiveStudy } from './lib/adaptive-preference.mjs';
import { buildPreferenceStudy } from './lib/preference-lab.mjs';
import { loadSvg, sha256 } from './lib/svg-document.mjs';
import { assertKnownArgs, fail, guardOutput, handleCliError, parseArgs, readJson, writeOutput } from './lib/svg-utils.mjs';

try {
  const args = parseArgs(process.argv.slice(2));
  assertKnownArgs(args, ['help', 'analysis', 'study', 'output']);
  if (args.help) { process.stdout.write('Usage: export-adaptive-preferences.mjs <input.svg> response.json [...] --analysis audit.json --study study.json --output rows.jsonl\n'); process.exit(0); }
  const input = args._[0], responsePaths = args._.slice(1);
  if (!input || !responsePaths.length || !args.analysis || !args.study || !args.output) fail('Provide SVG, responses, --analysis, --study, and --output.');
  for (const path of [input, args.analysis, args.study, ...responsePaths]) guardOutput(path, args.output);
  const svg = loadSvg(input), audit = readJson(args.analysis), study = readJson(args.study);
  validateAdaptiveStudy(study);
  const auditBytes = readFileSync(resolve(args.analysis));
  const base = buildPreferenceStudy(svg, audit, sha256(auditBytes), study.baseConfig).study;
  const rebuilt = buildAdaptiveStudy(base, { seed: study.config.seed, maxTrials: study.config.maxTrials });
  if (JSON.stringify(rebuilt) !== JSON.stringify(study)) fail('Adaptive study no longer matches its source, audit, or generated candidates.', 'adaptive-study-lineage-mismatch', 2);
  const responses = responsePaths.map(readJson).sort((a, b) => String(a.raterId).toLowerCase().localeCompare(String(b.raterId).toLowerCase()));
  const raters = new Set(), rows = [];
  for (const response of responses) {
    const id = String(response.raterId).toLowerCase();
    if (raters.has(id)) fail('Each export may contain only one response per case-insensitive rater ID.', 'adaptive-rater-duplicate', 2);
    raters.add(id); rows.push(...adaptivePreferenceRows(study, response));
  }
  writeOutput(args.output, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
} catch (error) { handleCliError(error); }

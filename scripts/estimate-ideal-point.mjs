#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { estimateIdealPoint, validateAdaptiveDatum } from './lib/adaptive-preference.mjs';
import { assertKnownArgs, fail, guardOutput, handleCliError, parseArgs, writeOutput } from './lib/svg-utils.mjs';

try {
  const args = parseArgs(process.argv.slice(2));
  assertKnownArgs(args, ['help', 'output']);
  if (args.help) { process.stdout.write('Usage: estimate-ideal-point.mjs preferences.jsonl [...] --output ideal-point.json\n'); process.exit(0); }
  if (!args._.length || !args.output || args.output === true) fail('Provide preference JSONL files and --output.');
  const rows = [];
  for (const path of args._) {
    guardOutput(path, args.output);
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean)) { const row = JSON.parse(line); validateAdaptiveDatum(row); rows.push(row); }
  }
  writeOutput(args.output, `${JSON.stringify(estimateIdealPoint(rows), null, 2)}\n`);
} catch (error) { handleCliError(error); }

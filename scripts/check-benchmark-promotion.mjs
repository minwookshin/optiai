#!/usr/bin/env node
import { checkBenchmarkPromotion } from './lib/benchmark-model.mjs';
import { assertKnownArgs, fail, guardOutput, handleCliError, parseArgs, readJson, writeOutput } from './lib/svg-utils.mjs';

try {
  const args = parseArgs(process.argv.slice(2));
  assertKnownArgs(args, ['help', 'output']);
  if (args.help) { process.stdout.write('Usage: check-benchmark-promotion.mjs report.json --output gate.json\n'); process.exit(0); }
  if (!args._[0] || !args.output) fail('Provide report.json and --output.');
  guardOutput(args._[0], args.output);
  writeOutput(args.output, `${JSON.stringify(checkBenchmarkPromotion(readJson(args._[0])), null, 2)}\n`);
} catch (error) { handleCliError(error); }

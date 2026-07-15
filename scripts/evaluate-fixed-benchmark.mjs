#!/usr/bin/env node
import { evaluateFixedBenchmark } from './lib/benchmark-model.mjs';
import { assertKnownArgs, fail, guardOutput, handleCliError, parseArgs, readJson, writeOutput } from './lib/svg-utils.mjs';

try {
  const args = parseArgs(process.argv.slice(2));
  assertKnownArgs(args, ['help', 'study', 'output']);
  if (args.help) { process.stdout.write('Usage: evaluate-fixed-benchmark.mjs response.json [...] --study study.json --output report.json\n'); process.exit(0); }
  if (!args._.length || !args.study || !args.output) fail('Provide responses, --study, and --output.');
  for (const path of [args.study, ...args._]) guardOutput(path, args.output);
  writeOutput(args.output, `${JSON.stringify(evaluateFixedBenchmark(readJson(args.study), args._.map((path) => readJson(path))), null, 2)}\n`);
} catch (error) { handleCliError(error); }

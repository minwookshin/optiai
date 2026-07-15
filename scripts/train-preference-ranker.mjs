#!/usr/bin/env node
import { trainPreferenceRanker } from './lib/preference-model.mjs';
import { assertKnownArgs, fail, guardOutput, handleCliError, parseArgs, readJson, writeOutput } from './lib/svg-utils.mjs';

const HELP = `Usage: train-preference-ranker.mjs dataset.json --output ranker.json

Creates a deterministic transparent pairwise ranker with family/group out-of-fold evaluation.
The model is research-only and can never authorize an SVG correction.

Options:
  --output PATH  Write the non-authorizing model and evaluation artifact
  --help         Show this help
`;

try {
  const args = parseArgs(process.argv.slice(2));
  assertKnownArgs(args, ['help', 'output']);
  if (args.help) { process.stdout.write(HELP); process.exit(0); }
  const datasetPath = args._[0];
  if (!datasetPath) fail('Provide a preference dataset JSON.');
  if (!args.output || args.output === true) fail('Provide --output ranker.json.');
  guardOutput(datasetPath, args.output);
  const model = trainPreferenceRanker(readJson(datasetPath));
  writeOutput(args.output, `${JSON.stringify(model, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ evaluationStatus: model.evaluationStatus, recommendedForCalibration: model.recommendedForCalibration, familyEvaluationCoverage: model.evaluation.family.evaluationCoverage, familyLearned: model.evaluation.family.models.learned, familyZero: model.evaluation.family.models.zero, familyAlphaCentroid: model.evaluation.family.models.alphaCentroid })}\n`);
} catch (error) { handleCliError(error); }

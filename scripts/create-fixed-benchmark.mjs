#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { benchmarkTrainingSummary, buildFixedBenchmarkStudy, renderFixedBenchmarkHtml } from './lib/benchmark-model.mjs';
import { validatePreferenceDataset, validatePreferenceModel } from './lib/preference-model.mjs';
import { clippingIssues, rasterPng } from './lib/raster.mjs';
import { buildCandidate, loadSvg, withRootColor } from './lib/svg-document.mjs';
import { assertKnownArgs, fail, guardOutput, handleCliError, parseArgs, readJson, writeOutput } from './lib/svg-utils.mjs';

const COLORS = { light: { foreground: '#111827', background: '#ffffff' }, dark: { foreground: '#ffffff', background: '#111827' } };

try {
  const args = parseArgs(process.argv.slice(2));
  assertKnownArgs(args, ['help', 'dataset', 'model', 'study-output', 'output']);
  if (args.help) { process.stdout.write('Usage: create-fixed-benchmark.mjs manifest.json --dataset dataset.json --model model.json --study-output study.json --output lab.html\n'); process.exit(0); }
  const manifestPath = args._[0];
  if (!manifestPath || !args.dataset || !args.model || !args['study-output'] || !args.output) fail('Provide manifest, --dataset, --model, --study-output, and --output.');
  for (const path of [manifestPath, args.dataset, args.model]) for (const output of [args['study-output'], args.output]) guardOutput(path, output);
  guardOutput(args['study-output'], args.output);
  const manifest = readJson(manifestPath), dataset = readJson(args.dataset), model = readJson(args.model);
  validatePreferenceDataset(dataset); validatePreferenceModel(model);
  const study = buildFixedBenchmarkStudy(manifest, benchmarkTrainingSummary(dataset, model));
  if (!study.trials.length) fail('Fixed benchmark produced no distinct blinded comparisons.', 'benchmark-no-trials', 2);
  const manifestDir = dirname(resolve(manifestPath)), images = {};
  for (const sourceCase of manifest.cases) {
    const bound = study.cases.find((item) => item.caseId === sourceCase.caseId);
    if (!bound || !Object.values(bound.outputs).some((output) => output.status === 'VALUE')) continue;
    if (typeof sourceCase.svg !== 'string' || !sourceCase.svg) fail(`Benchmark case ${sourceCase.caseId} needs a relative svg path.`, 'benchmark-svg-missing', 2);
    const svg = loadSvg(resolve(manifestDir, sourceCase.svg));
    if (svg.sha256 !== sourceCase.sourceSha256) fail(`Benchmark source hash changed for ${sourceCase.caseId}.`, 'benchmark-source-mismatch', 2);
    for (const output of Object.values(bound.outputs)) {
      if (output.status !== 'VALUE' || images[output.candidateId]) continue;
      const correction = sourceCase.axis === 'x' ? { dxPercent: output.percent, dyPercent: 0 } : { dxPercent: 0, dyPercent: output.percent };
      const candidate = buildCandidate(svg, correction);
      const clipping = clippingIssues(svg.sanitized, svg.viewBox, candidate.bytes, candidate.viewBox, [sourceCase.condition.size]);
      if (clipping.clipped) fail(`Benchmark candidate clips for ${sourceCase.caseId}.`, 'benchmark-candidate-clipped', 2);
      const colors = COLORS[sourceCase.condition.theme];
      const png = rasterPng(withRootColor(candidate.bytes, colors.foreground), sourceCase.condition.size);
      images[output.candidateId] = { dataUrl: `data:image/png;base64,${png.toString('base64')}`, background: colors.background };
    }
  }
  writeOutput(args['study-output'], `${JSON.stringify(study, null, 2)}\n`);
  writeOutput(args.output, renderFixedBenchmarkHtml(study, images));
} catch (error) { handleCliError(error); }

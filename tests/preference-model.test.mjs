import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  aggregatePreferenceCorpus,
  finalizePreferenceDatum,
  trainPreferenceRanker,
  validatePreferenceDataset,
  validatePreferenceDatum,
  validatePreferenceModel,
} from '../scripts/lib/preference-model.mjs';
import { sha256 } from '../scripts/lib/svg-document.mjs';
import { derivedDigest } from '../scripts/lib/audit-model.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (script, args, options = {}) => spawnSync(process.execPath, [join(root, 'scripts', script), ...args], { cwd: root, encoding: 'utf8', ...options });

const candidate = (axis, value, suffix) => {
  const correction = axis === 'x' ? { dxPercent: value, dyPercent: 0 } : { dxPercent: 0, dyPercent: value };
  const candidateSha256 = sha256(`candidate:${axis}:${suffix}:${value}`);
  return {
    id: sha256(JSON.stringify({ version: 1, axis, correction, candidateSha256 })),
    correction,
    candidateSha256,
  };
};

function datum({
  family = 'family-0',
  group = 'group-0',
  source = 'a'.repeat(64),
  rater = 'expert-01',
  axis = 'x',
  a = candidate(axis, -0.5, 'a'),
  b = candidate(axis, 0.5, 'b'),
  choice = 'A',
  proposal = 0.75,
} = {}) {
  const preferredCandidateId = choice === 'A' ? a.id : choice === 'B' ? b.id : null;
  return finalizePreferenceDatum({
    schemaVersion: 2,
    tool: 'OptiAI Preference Datum',
    nonAuthorizing: true,
    studyId: sha256(`study:${source}`),
    studyDigest: 'd'.repeat(64),
    sourceSha256: source,
    sourceViewBox: '0 0 24 24',
    context: 'icon-only',
    rtl: false,
    targetSizes: [16, 24],
    themes: ['light', 'dark'],
    raterId: rater,
    trialId: sha256(JSON.stringify({ version: 1, axis, candidates: [a.id, b.id].sort() })),
    axis,
    candidateA: a,
    candidateB: b,
    choice,
    preferredCandidateId,
    tie: choice === 'TIE',
    abstain: choice === 'ABSTAIN',
    pairwiseWinnerEligible: choice === 'A' || choice === 'B',
    sourceFeatures: {
      proposalPercent: proposal,
      centroidOffsetPercent: proposal,
      bearingImbalancePercent: proposal * 4,
      extentPercent: 58,
      orthogonalExtentPercent: 64,
      connectedComponents: 1,
    },
    corpus: { familyId: family, groupId: group, sourceId: `source-${source.slice(0, 8)}` },
  });
}

function corpus({ families = 5, pairs = 8, raters = 3, includeResearchChoices = false, startFamily = 0 } = {}) {
  const rows = [];
  for (let familyIndex = 0; familyIndex < families; familyIndex += 1) {
    const actualFamily = startFamily + familyIndex;
    const source = String(actualFamily + 1).repeat(64).slice(0, 64);
    const proposal = -1.5 + actualFamily * 0.75;
    for (let pairIndex = 0; pairIndex < pairs; pairIndex += 1) {
      const left = -2 + pairIndex * 0.5;
      const right = left + 0.5;
      const a = candidate('x', left, String.fromCharCode(97 + actualFamily));
      const b = candidate('x', right, String.fromCharCode(102 + actualFamily));
      const target = proposal * 0.6;
      const winningChoice = Math.abs(left - target) <= Math.abs(right - target) ? 'A' : 'B';
      for (let raterIndex = 0; raterIndex < raters; raterIndex += 1) {
        let choice = winningChoice;
        if (includeResearchChoices && actualFamily === 0 && pairIndex === 0 && raterIndex === 2) choice = 'TIE';
        if (includeResearchChoices && actualFamily === 0 && pairIndex === 1 && raterIndex === 2) choice = 'ABSTAIN';
        rows.push(datum({
          family: `family-${actualFamily}`,
          group: `group-${actualFamily}`,
          source,
          rater: `expert-${raterIndex + 1}`,
          trial: `trial-${pairIndex}`,
          a,
          b,
          choice,
          proposal,
        }));
      }
    }
  }
  return rows;
}

function syntheticAudit(sourceSha256, proposal) {
  const measurements = {
    reference: {
      paintedBounds: { x: 5, y: 4, width: 13.92, height: 15.36, maxX: 18.92, maxY: 19.36 },
      sideBearings: { left: 5, right: 5 + 0.96 * proposal, top: 4, bottom: 4 },
      centroid: { x: 12 - (proposal / 100) * 24, y: 12 },
      alphaSum: 1000,
      connectedComponents: 1,
    },
    bySize: [],
  };
  const decision = { status: 'REVIEW', reasonCodes: [], manualReviewRequired: true };
  const recommendation = { dxPercent: proposal, dyPercent: 0, model: 'alpha-centroid-v1', evidenceQuality: 'experimental', evidence: {}, pixelOffsets: [] };
  return {
    schemaVersion: 2,
    tool: 'OptiAI',
    source: { sha256: sourceSha256, viewBox: { x: 0, y: 0, width: 24, height: 24, raw: '0 0 24 24' } },
    context: 'icon-only',
    rtl: false,
    targetSizes: [16, 24],
    measurements,
    decision,
    recommendation,
    derivedSha256: derivedDigest({ measurements, decision, recommendation }),
  };
}

test('preference datum rejects semantic tampering and authorizing data', () => {
  const valid = datum();
  assert.equal(validatePreferenceDatum(valid), true);
  for (const mutate of [
    (row) => { row.nonAuthorizing = false; },
    (row) => { row.preferredCandidateId = row.candidateB.id; },
    (row) => { row.candidateA.correction.dyPercent = 0.5; },
    (row) => { row.candidateA.correction.dxPercent = 5.1; },
    (row) => { row.datumDigest = '0'.repeat(64); },
  ]) {
    const changed = structuredClone(valid);
    mutate(changed);
    assert.throws(() => validatePreferenceDatum(changed));
  }
});

test('aggregation canonicalizes reversed A/B and rejects case-insensitive duplicate raters', () => {
  const first = datum({ rater: 'Expert-01', choice: 'A' });
  const reversed = datum({
    rater: 'expert-02',
    a: first.candidateB,
    b: first.candidateA,
    choice: 'B',
  });
  const third = datum({ rater: 'expert-03', choice: 'A' });
  const dataset = aggregatePreferenceCorpus([first, reversed, third], { minRaters: 3, folds: 2, seed: 'canonical' });
  assert.equal(dataset.pairs.length, 1);
  assert.equal(dataset.pairs[0].votes.candidate1 + dataset.pairs[0].votes.candidate2, 3);
  assert.equal(dataset.pairs[0].panel.winnerCandidateId, first.candidateA.id);

  const duplicate = finalizePreferenceDatum({ ...structuredClone(first), raterId: 'expert-01' });
  assert.throws(
    () => aggregatePreferenceCorpus([first, duplicate, third], { minRaters: 3, folds: 2, seed: 'canonical' }),
    /duplicate/i,
  );
});

test('aggregation is deterministic, separates TIE and ABSTAIN, and prevents fold leakage', () => {
  const rows = corpus({ includeResearchChoices: true });
  const first = aggregatePreferenceCorpus(rows, { minRaters: 3, folds: 5, seed: 'fold-test' });
  const second = aggregatePreferenceCorpus([...rows].reverse(), { minRaters: 3, folds: 5, seed: 'fold-test' });
  assert.deepEqual(second, first);
  assert.equal(validatePreferenceDataset(first), true);
  assert.equal(first.stats.tieVotes, 1);
  assert.equal(first.stats.abstainVotes, 1);
  assert.equal(first.readiness.status, 'READY');
  for (const mode of ['family', 'group']) {
    const seen = new Map();
    for (const pair of first.pairs) {
      const unit = mode === 'family' ? pair.familyId : `${pair.familyId}/${pair.groupId}`;
      const fold = first.folds[mode].assignments[unit];
      if (seen.has(unit)) assert.equal(seen.get(unit), fold);
      seen.set(unit, fold);
    }
  }
});

test('one source cannot cross family or group fold boundaries', () => {
  const rows = corpus({ families: 1, pairs: 2, raters: 3 });
  for (const row of rows.slice(3)) row.corpus = { ...row.corpus, familyId: 'leaked-family', groupId: 'leaked-group' };
  assert.throws(() => aggregatePreferenceCorpus(rows, { minRaters: 3, folds: 2, seed: 'leak' }), /one source|mapping|conflict/i);
});

test('underpowered filler families cannot inflate readiness', () => {
  const rows = [
    ...corpus({ families: 2, pairs: 10, raters: 3 }),
    ...corpus({ families: 3, pairs: 10, raters: 2, startFamily: 2 }),
  ];
  const dataset = aggregatePreferenceCorpus(rows, { minRaters: 3, folds: 5, seed: 'eligible-only' });
  assert.equal(dataset.stats.familyCount, 5);
  assert.equal(dataset.stats.eligibleFamilyCount, 2);
  assert.equal(dataset.readiness.status, 'UNDERPOWERED');
  assert.ok(dataset.readiness.reasons.includes('fewer-than-4-eligible-families'));
});

test('TIE and ABSTAIN never change learned weights', () => {
  const baseRows = corpus();
  const extraRows = [...baseRows];
  for (let index = 0; index < 12; index += 1) {
    const original = baseRows[index];
    extraRows.push(finalizePreferenceDatum({
      ...structuredClone(original),
      raterId: `research-${index}`,
      choice: index % 2 === 0 ? 'TIE' : 'ABSTAIN',
      preferredCandidateId: null,
      tie: index % 2 === 0,
      abstain: index % 2 === 1,
      pairwiseWinnerEligible: false,
    }));
  }
  const baseModel = trainPreferenceRanker(aggregatePreferenceCorpus(baseRows, { folds: 5, seed: 'loss' }));
  const extraModel = trainPreferenceRanker(aggregatePreferenceCorpus(extraRows, { folds: 5, seed: 'loss' }));
  assert.deepEqual(extraModel.weights, baseModel.weights);
});

test('ranker is deterministic, evaluated out of family, and cannot authorize correction', () => {
  const dataset = aggregatePreferenceCorpus(corpus(), { folds: 5, seed: 'ranker' });
  const first = trainPreferenceRanker(dataset, { iterations: 600, learningRate: 0.2, l2: 0.01 });
  const second = trainPreferenceRanker(structuredClone(dataset), { iterations: 600, learningRate: 0.2, l2: 0.01 });
  assert.deepEqual(second, first);
  assert.equal(validatePreferenceModel(first), true);
  assert.equal(first.nonAuthorizing, true);
  assert.equal(first.safety.authorizesCorrection, false);
  assert.equal(first.safety.acceptedByApplyCorrection, false);
  assert.ok(first.evaluation.family.models.learned.eligiblePairs > 0);
  assert.equal(first.evaluation.family.evaluationCoverage, 1);
  assert.equal(first.evaluation.family.models.learned.eligiblePairs, first.evaluation.family.models.zero.eligiblePairs);
  assert.equal(first.evaluation.family.models.learned.eligiblePairs, first.evaluation.family.models.alphaCentroid.eligiblePairs);
  assert.ok(Number.isFinite(first.evaluation.family.models.learned.logLoss));
  assert.doesNotMatch(JSON.stringify(first), /raterId|realpath|approved|verification/i);

  const tampered = structuredClone(dataset);
  tampered.pairs[0].votes.candidate1 += 1;
  const { datasetDigest: _ignored, ...tamperedCore } = tampered;
  tampered.datasetDigest = sha256(JSON.stringify(tamperedCore));
  assert.throws(() => trainPreferenceRanker(tampered), /vote|panel|statistics/i);

  const forged = structuredClone(first);
  forged.weights = { x: 'garbage', y: null };
  const { modelDigest: _modelDigest, ...forgedCore } = forged;
  forged.modelDigest = sha256(JSON.stringify(forgedCore));
  assert.throws(() => validatePreferenceModel(forged), /weights/i);
});

test('underpowered data fails closed without producing a model', () => {
  const dataset = aggregatePreferenceCorpus(corpus({ families: 2, pairs: 2, raters: 2 }), { minRaters: 3, folds: 5, seed: 'small' });
  assert.equal(dataset.readiness.status, 'UNDERPOWERED');
  assert.throws(() => trainPreferenceRanker(dataset), /underpowered/i);
});

test('corpus manifest aggregates and trains through deterministic CLIs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optiai-model-cli-'));
  const rows = corpus();
  const sources = [];
  for (let familyIndex = 0; familyIndex < 5; familyIndex += 1) {
    const familyRows = rows.filter((row) => row.corpus.familyId === `family-${familyIndex}`);
    const auditPath = join(dir, `audit-${familyIndex}.json`);
    const preferencesPath = join(dir, `preferences-${familyIndex}.jsonl`);
    const audit = syntheticAudit(familyRows[0].sourceSha256, familyRows[0].sourceFeatures.proposalPercent);
    writeFileSync(auditPath, `${JSON.stringify(audit)}\n`);
    writeFileSync(preferencesPath, `${familyRows.map((row) => JSON.stringify(finalizePreferenceDatum({ ...row, corpus: undefined }))).join('\n')}\n`);
    sources.push({ sourceId: `source-${familyIndex}`, familyId: `family-${familyIndex}`, groupId: `group-${familyIndex}`, audit: `audit-${familyIndex}.json`, preferences: [`preferences-${familyIndex}.jsonl`] });
  }
  const manifest = join(dir, 'corpus.json');
  writeFileSync(manifest, `${JSON.stringify({ schemaVersion: 1, tool: 'OptiAI Preference Corpus', nonAuthorizing: true, sources })}\n`);
  const dataset = join(dir, 'dataset.json');
  const secondDataset = join(dir, 'dataset-2.json');
  const model = join(dir, 'ranker.json');
  const aggregated = run('aggregate-preferences.mjs', [manifest, '--seed', 'cli-test', '--output', dataset]);
  assert.equal(aggregated.status, 0, aggregated.stderr);
  assert.equal(run('aggregate-preferences.mjs', [manifest, '--seed', 'cli-test', '--output', secondDataset], { env: { ...process.env, TZ: 'Asia/Seoul', LANG: 'C' } }).status, 0);
  assert.equal(readFileSync(secondDataset, 'utf8'), readFileSync(dataset, 'utf8'));
  const trained = run('train-preference-ranker.mjs', [dataset, '--output', model]);
  assert.equal(trained.status, 0, trained.stderr);
  const artifact = JSON.parse(readFileSync(model, 'utf8'));
  assert.equal(validatePreferenceModel(artifact), true);
  assert.equal(artifact.nonAuthorizing, true);
  assert.doesNotMatch(readFileSync(model, 'utf8'), /expert-|raterId|\/tmp\//i);
});

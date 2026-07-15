import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFixedBenchmarkStudy,
  checkBenchmarkPromotion,
  evaluateFixedBenchmark,
  renderFixedBenchmarkHtml,
  validateBenchmarkGate,
  validateFixedBenchmarkStudy,
} from '../scripts/lib/benchmark-model.mjs';
import { sha256 } from '../scripts/lib/svg-document.mjs';

const value = (percent) => ({ status: 'VALUE', percent });
const training = {
  datasetDigest: 'a'.repeat(64), modelDigest: 'b'.repeat(64),
  sourceSha256s: ['1'.repeat(64)], familyIds: ['training-family'], groupIds: ['training-family/training-group'],
};
const hazardTypes = ['active-content', 'external-reference', 'malformed-bounds', 'detached-mark', 'signal-disagreement', 'full-bleed-clipping', 'already-centered', 'out-of-range-proposal'];

function manifest(count = 4) {
  return {
    schemaVersion: 1,
    tool: 'OptiAI Fixed Benchmark Manifest',
    nonAuthorizing: true,
    benchmarkId: 'public-holdout-v1',
    holdoutOnly: true,
    seed: 'benchmark-seed',
    cases: Array.from({ length: count }, (_, index) => ({
      caseId: `case-${index}`,
      sourceId: `source-${index}`,
      familyId: `family-${index % 6}`,
      groupId: `group-${index % 8}`,
      sourceSha256: sha256(`holdout:${index}`),
      axis: index % 2 ? 'x' : 'y',
      condition: { size: 24, theme: 'light', context: 'icon-only' },
      outputs: {
        'zero-v1': value(0),
        'alpha-centroid-v1': value(index % 2 ? 0.5 : -0.5),
        'ensemble-v05': value(index % 2 ? 1 : -1),
        'learned-v06': { ...value(index % 2 ? 1.5 : -1.5), modelDigest: training.modelDigest },
      },
    })),
    hazards: hazardTypes.map((hazardType, index) => ({ caseId: `hazard-${index + 1}`, hazardType, expectedStatus: 'ABSTAIN', expectedReasonCode: hazardType, learnedOutput: { status: 'ABSTAIN', reasonCode: hazardType, modelDigest: training.modelDigest } })),
  };
}

function completeResponse(study, raterId, learnedWins = true) {
  return {
    schemaVersion: 1, tool: 'OptiAI Fixed Benchmark Response', nonAuthorizing: true,
    studyId: study.studyId, studyDigest: study.studyDigest, raterId,
    responses: study.trials.map((trial) => ({
      trialId: trial.participantId,
      choice: learnedWins
        ? (trial.presentation.A === study.trialBindings[trial.id].learnedCandidateId ? 'A' : 'B')
        : (trial.presentation.A === study.trialBindings[trial.id].learnedCandidateId ? 'B' : 'A'),
    })),
  };
}

test('fixed study is deterministic, label-blind, and rejects training overlap', () => {
  const study = buildFixedBenchmarkStudy(manifest(), training);
  assert.deepEqual(buildFixedBenchmarkStudy(manifest(), training), study);
  assert.equal(validateFixedBenchmarkStudy(study), true);
  assert.doesNotMatch(JSON.stringify(study.trials), /learned-v06|ensemble-v05|centroid|zero-v1/i);
  const overlap = manifest();
  overlap.cases[0].sourceSha256 = training.sourceSha256s[0];
  assert.throws(() => buildFixedBenchmarkStudy(overlap, training), /overlap/i);
  const familyOverlap = manifest();
  familyOverlap.cases[0].familyId = 'training-family';
  assert.throws(() => buildFixedBenchmarkStudy(familyOverlap, training), /overlap/i);
  const duplicateSource = manifest();
  duplicateSource.cases[1].sourceSha256 = duplicateSource.cases[0].sourceSha256;
  assert.throws(() => buildFixedBenchmarkStudy(duplicateSource, training), /one-to-one|source IDs/i);
  const wrongModel = manifest();
  wrongModel.cases[0].outputs['learned-v06'].modelDigest = 'f'.repeat(64);
  assert.throws(() => buildFixedBenchmarkStudy(wrongModel, training), /frozen model|model output/i);
  const images = Object.fromEntries(study.trials.flatMap((trial) => Object.values(trial.presentation)).map((id) => [id, { dataUrl: 'data:image/png;base64,AA==', background: '#fff' }]));
  const html = renderFixedBenchmarkHtml(study, images);
  assert.doesNotMatch(html, /learned-v06|ensemble-v05|alpha-centroid-v1|zero-v1/i);
  for (const trial of study.trials) for (const candidateId of Object.values(trial.presentation)) assert.equal(html.includes(candidateId), false);
});

test('report uses direct head-to-head preference and remains underpowered without enough evidence', () => {
  const study = buildFixedBenchmarkStudy(manifest(), training);
  const responses = ['panel-1', 'panel-2', 'panel-3'].map((id) => completeResponse(study, id));
  const report = evaluateFixedBenchmark(study, responses);
  assert.equal(report.nonAuthorizing, true);
  assert.equal(report.headToHead['learned-v06__ensemble-v05'].learnedWins > 0, true);
  assert.equal(report.headToHead['learned-v06__ensemble-v05'].decisiveWinRate, 1);
  const gate = checkBenchmarkPromotion(report);
  assert.equal(gate.status, 'UNDERPOWERED');
  assert.equal(gate.recommendedForCalibration, false);
  assert.equal(validateBenchmarkGate(gate), true);
  assert.doesNotMatch(JSON.stringify(report), /"raterId"|realpath|expert accuracy|production.ready/i);
});

test('TIE and ABSTAIN are excluded from decisive wins and duplicate raters are rejected', () => {
  const study = buildFixedBenchmarkStudy(manifest(), training);
  const tie = completeResponse(study, 'panel-1');
  tie.responses.forEach((item, index) => { item.choice = index % 2 ? 'TIE' : 'ABSTAIN'; });
  const report = evaluateFixedBenchmark(study, [tie]);
  const head = report.headToHead['learned-v06__zero-v1'];
  assert.equal(head.decisiveVotes, 0);
  assert.equal(head.ties + head.cannotJudge, head.distinctOutputCases);
  assert.throws(() => evaluateFixedBenchmark(study, [tie, structuredClone(tie)]), /duplicate/i);
});

test('promotion requires beating every baseline, fixed evidence thresholds, and safety pass', () => {
  const study = buildFixedBenchmarkStudy(manifest(48), training);
  const winning = Array.from({ length: 5 }, (_, index) => completeResponse(study, `panel-${index + 1}`, true));
  const report = evaluateFixedBenchmark(study, winning);
  const gate = checkBenchmarkPromotion(report);
  assert.equal(gate.status, 'PROMISING_RESEARCH_ONLY');
  assert.equal(gate.recommendedForCalibration, true);
  const allTies = winning.map((response) => ({ ...response, responses: response.responses.map((item) => ({ ...item, choice: 'TIE' })) }));
  assert.equal(checkBenchmarkPromotion(evaluateFixedBenchmark(study, allTies)).status, 'UNDERPOWERED');
  const losing = evaluateFixedBenchmark(study, winning.map((response, index) => index < 3 ? completeResponse(study, `panel-${index + 1}`, false) : response));
  assert.equal(checkBenchmarkPromotion(losing).status, 'BASELINE_NOT_BEATEN');
  const unsafe = structuredClone(report);
  unsafe.safety.status = 'FAIL';
  unsafe.safety.failures = ['hazard-regression'];
  const { reportDigest: _ignored, ...core } = unsafe;
  unsafe.reportDigest = sha256(JSON.stringify(core));
  assert.equal(checkBenchmarkPromotion(unsafe).status, 'BASELINE_NOT_BEATEN');
});

test('learned output can never bypass ensemble abstention', () => {
  const unsafe = manifest();
  unsafe.cases[0].outputs['ensemble-v05'] = { status: 'ABSTAIN', reasonCode: 'signal-disagreement' };
  assert.throws(() => buildFixedBenchmarkStudy(unsafe, training), /safety wrapper|abstain/i);
});

test('one baseline abstention does not suppress other direct comparisons', () => {
  const selective = manifest();
  selective.cases[0].outputs['alpha-centroid-v1'] = { status: 'ABSTAIN', reasonCode: 'baseline-unavailable' };
  const study = buildFixedBenchmarkStudy(selective, training);
  const caseTrials = study.trials.filter((trial) => trial.caseId === 'case-0');
  assert.equal(caseTrials.length, 2);
  assert.deepEqual(caseTrials.map((trial) => study.trialBindings[trial.id].baseline).sort(), ['ensemble-v05', 'zero-v1']);
});

test('empty or incomplete hazard suites fail closed', () => {
  const empty = manifest(); empty.hazards = [];
  assert.throws(() => buildFixedBenchmarkStudy(empty, training), /hazard suite/i);
  const missing = manifest(); missing.hazards.pop();
  assert.throws(() => buildFixedBenchmarkStudy(missing, training), /hazard/i);
});

test('abstaining filler sources cannot hide a five-source decisive cohort', () => {
  const padded = manifest(59);
  for (let index = 5; index < 24; index += 1) {
    const original = padded.cases[index % 5];
    padded.cases[index].sourceId = original.sourceId;
    padded.cases[index].sourceSha256 = original.sourceSha256;
    padded.cases[index].familyId = original.familyId;
    padded.cases[index].groupId = original.groupId;
  }
  for (let index = 24; index < padded.cases.length; index += 1) {
    padded.cases[index].outputs['ensemble-v05'] = { status: 'ABSTAIN', reasonCode: 'signal-disagreement' };
    padded.cases[index].outputs['learned-v06'] = { status: 'ABSTAIN', reasonCode: 'signal-disagreement', modelDigest: training.modelDigest };
  }
  const study = buildFixedBenchmarkStudy(padded, training);
  const responses = Array.from({ length: 5 }, (_, index) => completeResponse(study, `panel-${index + 1}`));
  const report = evaluateFixedBenchmark(study, responses);
  assert.equal(report.evidence.sourceCount, 40);
  assert.equal(report.headToHead['learned-v06__zero-v1'].decisiveVotes, 120);
  assert.equal(report.headToHead['learned-v06__zero-v1'].sourcesWithAtLeastFiveDecisiveVotes, 5);
  assert.equal(checkBenchmarkPromotion(report).status, 'UNDERPOWERED');
});

test('tie-only filler sources do not count as decisive contributing sources', () => {
  const padded = manifest(59);
  for (let index = 5; index < 24; index += 1) {
    const original = padded.cases[index % 5];
    Object.assign(padded.cases[index], { sourceId: original.sourceId, sourceSha256: original.sourceSha256, familyId: original.familyId, groupId: original.groupId });
  }
  const study = buildFixedBenchmarkStudy(padded, training);
  const responses = Array.from({ length: 5 }, (_, index) => completeResponse(study, `panel-${index + 1}`));
  for (const response of responses) for (const item of response.responses) {
    const trial = study.trials.find((candidate) => candidate.participantId === item.trialId);
    if (Number(trial.caseId.split('-')[1]) >= 24) item.choice = 'TIE';
  }
  const report = evaluateFixedBenchmark(study, responses);
  assert.equal(report.headToHead['learned-v06__zero-v1'].decisiveVotes, 120);
  assert.equal(report.headToHead['learned-v06__zero-v1'].sourcesWithAtLeastFiveDecisiveVotes, 5);
  assert.equal(checkBenchmarkPromotion(report).status, 'UNDERPOWERED');
});

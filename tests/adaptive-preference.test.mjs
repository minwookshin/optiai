import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adaptivePreferenceRows,
  buildAdaptiveStudy,
  estimateIdealPoint,
  nextAdaptiveTrial,
  validateAdaptiveResponse,
  validateAdaptiveStudy,
} from '../scripts/lib/adaptive-preference.mjs';
import { sha256 } from '../scripts/lib/svg-document.mjs';

const candidate = (axis, value) => ({
  id: sha256(`${axis}:${value}`),
  axis,
  correction: axis === 'x' ? { dxPercent: value, dyPercent: 0 } : { dxPercent: 0, dyPercent: value },
  candidateSha256: sha256(`candidate:${axis}:${value}`),
});

const base = {
  schemaVersion: 1,
  tool: 'OptiAI Preference Lab',
  nonAuthorizing: true,
  studyId: 'a'.repeat(64),
  studyDigest: 'b'.repeat(64),
  source: { sha256: 'c'.repeat(64), viewBox: { raw: '0 0 24 24' } },
  audit: { documentSha256: 'd'.repeat(64), derivedSha256: 'e'.repeat(64) },
  context: 'icon-only',
  rtl: false,
  config: { sizes: [16, 24], themes: ['light', 'dark'] },
  candidates: [-2, -1, 0, 1, 2].flatMap((value) => [candidate('x', value), candidate('y', value)]),
};

function responseFor(study, raterId, ideal = 0.7) {
  const responses = [];
  while (responses.length < study.config.maxTrials) {
    const trial = nextAdaptiveTrial(study, responses);
    const a = trial.values.A;
    const b = trial.values.B;
    const delta = Math.abs(a - ideal) - Math.abs(b - ideal);
    const choice = Math.abs(delta) < 0.18 ? 'TIE' : delta < 0 ? 'A' : 'B';
    responses.push({ trialId: trial.id, choice, presentedIndex: responses.length, responseTimeMs: 900 + responses.length * 10 });
  }
  return { schemaVersion: 1, tool: 'OptiAI Adaptive Preference Response', nonAuthorizing: true, studyId: study.studyId, studyDigest: study.studyDigest, raterId, responses };
}

function forcedResponse(study, raterId, forcedChoice) {
  const responses = [];
  while (responses.length < study.config.maxTrials) {
    const trial = nextAdaptiveTrial(study, responses);
    responses.push({ trialId: trial.id, choice: forcedChoice, presentedIndex: responses.length, responseTimeMs: 1000 });
  }
  return { schemaVersion: 1, tool: 'OptiAI Adaptive Preference Response', nonAuthorizing: true, studyId: study.studyId, studyDigest: study.studyDigest, raterId, responses };
}

test('adaptive study is deterministic and every trial has exactly one condition', () => {
  const one = buildAdaptiveStudy(base, { seed: 'adaptive-test', maxTrials: 8 });
  const two = buildAdaptiveStudy(structuredClone(base), { seed: 'adaptive-test', maxTrials: 8 });
  assert.deepEqual(two, one);
  assert.equal(validateAdaptiveStudy(one), true);
  for (const trial of one.pool) {
    assert.deepEqual(Object.keys(trial.condition).sort(), ['size', 'theme']);
    assert.ok(Number.isInteger(trial.condition.size));
    assert.equal(typeof trial.condition.theme, 'string');
  }
});

test('the next trial depends on prior answers and response order is replay validated', () => {
  const study = buildAdaptiveStudy(base, { seed: 'response-driven', maxTrials: 8 });
  const first = nextAdaptiveTrial(study, []);
  const aPath = [];
  const bPath = [];
  let diverged = false;
  for (let index = 0; index < 4; index += 1) {
    const aTrial = nextAdaptiveTrial(study, aPath);
    const bTrial = nextAdaptiveTrial(study, bPath);
    if (aTrial.id !== bTrial.id) diverged = true;
    aPath.push({ trialId: aTrial.id, choice: 'A', presentedIndex: index, responseTimeMs: 1000 });
    bPath.push({ trialId: bTrial.id, choice: 'B', presentedIndex: index, responseTimeMs: 1000 });
  }
  assert.equal(diverged, true);
  const response = responseFor(study, 'panel-01');
  assert.equal(validateAdaptiveResponse(study, response).length, study.config.maxTrials);
  const reordered = structuredClone(response);
  [reordered.responses[1], reordered.responses[2]] = [reordered.responses[2], reordered.responses[1]];
  assert.throws(() => validateAdaptiveResponse(study, reordered), /sequence|replay/i);
});

test('repeat trials are independently flipped and expose reliability evidence', () => {
  const study = buildAdaptiveStudy(base, { seed: 'repeat-test', maxTrials: 8 });
  const response = responseFor(study, 'panel-01');
  const trials = response.responses.map((_, index) => nextAdaptiveTrial(study, response.responses.slice(0, index)));
  const repeat = trials.at(-1);
  assert.equal(repeat.repeatOf, trials[0].id);
  assert.equal(repeat.presentation.A, trials[0].presentation.B);
  assert.equal(repeat.presentation.B, trials[0].presentation.A);
});

test('tie-aware ideal point uses TIE evidence while ABSTAIN does not change the fit', () => {
  const study = buildAdaptiveStudy(base, { seed: 'ideal-test', maxTrials: 8 });
  const responses = ['panel-01', 'panel-02', 'panel-03'].map((id) => responseFor(study, id));
  const rows = responses.flatMap((response) => adaptivePreferenceRows(study, response));
  const model = estimateIdealPoint(rows);
  assert.equal(model.nonAuthorizing, true);
  assert.equal(model.readiness.status, 'ESTIMATED');
  assert.ok(Number.isFinite(model.axes.x.idealPercent));
  const tied = estimateIdealPoint(['tie-01', 'tie-02', 'tie-03'].flatMap((id) => adaptivePreferenceRows(study, forcedResponse(study, id, 'TIE'))));
  assert.notDeepEqual(tied.axes.x, model.axes.x);
  const withAbstain = [...rows, ...adaptivePreferenceRows(study, forcedResponse(study, 'panel-extra', 'ABSTAIN'))];
  assert.deepEqual(estimateIdealPoint(withAbstain).axes, model.axes);
  assert.doesNotMatch(JSON.stringify(model), /raterId|realpath|authorizesCorrection/i);
});

test('ideal-point estimation rejects mixed provenance and abstain-only raters do not satisfy readiness', () => {
  const study = buildAdaptiveStudy(base, { seed: 'provenance-test', maxTrials: 8 });
  const one = adaptivePreferenceRows(study, responseFor(study, 'panel-01'));
  const abstain = ['panel-02', 'panel-03'].flatMap((id) => adaptivePreferenceRows(study, forcedResponse(study, id, 'ABSTAIN')));
  assert.equal(estimateIdealPoint([...one, ...abstain]).readiness.status, 'UNDERPOWERED');
  const mixed = structuredClone(one);
  mixed[0].studyId = 'f'.repeat(64);
  const { datumDigest: _ignored, ...core } = mixed[0];
  mixed[0].datumDigest = sha256(JSON.stringify(core));
  assert.throws(() => estimateIdealPoint([...one, mixed[0]]), /mixes different studies|provenance/i);
});

test('ideal-point estimation rejects rehashed malformed values and cherry-picked sequences', () => {
  const study = buildAdaptiveStudy(base, { seed: 'adversarial-test', maxTrials: 8 });
  const rows = ['panel-01', 'panel-02', 'panel-03'].flatMap((id) => adaptivePreferenceRows(study, responseFor(study, id)));
  const malformed = structuredClone(rows);
  malformed[0].trial.values.A = 'not-a-number';
  const { datumDigest: _ignored, ...malformedCore } = malformed[0];
  malformed[0].datumDigest = sha256(JSON.stringify(malformedCore));
  assert.throws(() => estimateIdealPoint(malformed), /semantics|invalid/i);
  assert.throws(() => estimateIdealPoint(rows.filter((row) => row.presentedIndex < 2)), /incomplete|sequence/i);
});

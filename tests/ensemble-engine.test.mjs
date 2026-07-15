import assert from 'node:assert/strict';
import test from 'node:test';
import { combineAxisSignals } from '../scripts/lib/audit-model.mjs';

const entries = (alpha, edge, convexHull) => [
  { name: 'alpha', value: alpha },
  { name: 'edge', value: edge },
  { name: 'convexHull', value: convexHull },
];

test('signal combiner separates strong, mixed, and conflicting evidence', () => {
  const balanced = combineAxisSignals(entries(0.02, -0.03, 0));
  assert.equal(balanced.band, 'strong');
  assert.equal(balanced.status, 'NO_CHANGE');

  const strong = combineAxisSignals(entries(1, 1.2, 1.4));
  assert.equal(strong.band, 'strong');
  assert.equal(strong.status, 'REVIEW');

  const mixed = combineAxisSignals(entries(0.5, 1.2, 1.8));
  assert.equal(mixed.band, 'mixed');
  assert.equal(mixed.status, 'REVIEW');

  const conflict = combineAxisSignals(entries(-1.2, 0, 1.2));
  assert.equal(conflict.band, 'conflict');
  assert.equal(conflict.status, 'ABSTAIN');
  assert.equal(conflict.reasonCode, 'perceptual-signals-disagree');
});

test('signal combiner tolerates a lone edge outlier but fails closed on insufficient values', () => {
  const edgeOutlier = combineAxisSignals(entries(1.39, -1.86, 1.31));
  assert.equal(edgeOutlier.band, 'mixed');
  assert.equal(edgeOutlier.status, 'REVIEW');
  assert.equal(edgeOutlier.consensus, 1.31);

  const insufficient = combineAxisSignals([
    { name: 'alpha', value: Number.NaN },
    { name: 'edge', value: 1 },
    { name: 'convexHull', value: Number.POSITIVE_INFINITY },
  ]);
  assert.equal(insufficient.status, 'ABSTAIN');
  assert.equal(insufficient.reasonCode, 'insufficient-optical-signals');
});

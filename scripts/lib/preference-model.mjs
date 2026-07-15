import { sha256 } from './svg-document.mjs';
import { fail, formatNumber } from './svg-utils.mjs';

const DATUM_TOOL = 'OptiAI Preference Datum';
const DATASET_TOOL = 'OptiAI Preference Dataset';
const MODEL_TOOL = 'OptiAI Pairwise Ranker';
const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const CHOICES = new Set(['A', 'B', 'TIE', 'ABSTAIN']);
const FEATURE_NAMES = ['quadraticCentering', 'proposalInteraction', 'magnitudePenalty'];

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`, 'preference-model-schema-invalid', 2);
  const expected = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) fail(`${label} has unknown or missing fields.`, 'preference-model-schema-invalid', 2);
}

function containsForbiddenKey(value, forbidden) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsForbiddenKey(item, forbidden));
  return Object.entries(value).some(([key, item]) => forbidden.has(key) || containsForbiddenKey(item, forbidden));
}

function finite(value, label, minimum = -Infinity, maximum = Infinity) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) fail(`${label} is out of range.`, 'preference-model-value-invalid', 2);
  return value;
}

function datumCore(row) {
  const core = {};
  for (const [key, value] of Object.entries(row)) {
    if (key !== 'datumDigest' && key !== 'corpus') core[key] = value;
  }
  return core;
}

export function finalizePreferenceDatum(row) {
  const core = datumCore(row);
  return { ...core, ...(row.corpus ? { corpus: row.corpus } : {}), datumDigest: sha256(JSON.stringify(core)) };
}

function validateCandidate(candidate, axis, label) {
  exactKeys(candidate, ['id', 'correction', 'candidateSha256'], label);
  if (!HASH.test(candidate.id) || !HASH.test(candidate.candidateSha256)) fail(`${label} hashes are invalid.`, 'preference-candidate-invalid', 2);
  exactKeys(candidate.correction, ['dxPercent', 'dyPercent'], `${label} correction`);
  const dx = finite(candidate.correction.dxPercent, `${label} dxPercent`, -5, 5);
  const dy = finite(candidate.correction.dyPercent, `${label} dyPercent`, -5, 5);
  if ((axis === 'x' && dy !== 0) || (axis === 'y' && dx !== 0)) fail('Preference candidates must change only their declared axis.', 'preference-candidate-axis-invalid', 2);
  const expectedId = sha256(JSON.stringify({ version: 1, axis, correction: candidate.correction, candidateSha256: candidate.candidateSha256 }));
  if (candidate.id !== expectedId) fail(`${label} ID does not match its correction lineage.`, 'preference-candidate-lineage-invalid', 2);
}

function validateSourceFeatures(features) {
  exactKeys(features, ['proposalPercent', 'centroidOffsetPercent', 'bearingImbalancePercent', 'extentPercent', 'orthogonalExtentPercent', 'connectedComponents'], 'Source features');
  finite(features.proposalPercent, 'Proposal percent', -5, 5);
  finite(features.centroidOffsetPercent, 'Centroid offset percent', -100, 100);
  finite(features.bearingImbalancePercent, 'Bearing imbalance percent', -100, 100);
  finite(features.extentPercent, 'Extent percent', 0, 100);
  finite(features.orthogonalExtentPercent, 'Orthogonal extent percent', 0, 100);
  if (!Number.isInteger(features.connectedComponents) || features.connectedComponents < 1 || features.connectedComponents > 10000) fail('Connected components are invalid.', 'preference-source-features-invalid', 2);
}

export function validatePreferenceDatum(row) {
  exactKeys(row, ['schemaVersion', 'tool', 'nonAuthorizing', 'studyId', 'studyDigest', 'sourceSha256', 'sourceViewBox', 'context', 'rtl', 'targetSizes', 'themes', 'raterId', 'trialId', 'axis', 'candidateA', 'candidateB', 'choice', 'preferredCandidateId', 'tie', 'abstain', 'pairwiseWinnerEligible', 'sourceFeatures', ...(row?.corpus ? ['corpus'] : []), 'datumDigest'], 'Preference datum');
  if (row.schemaVersion !== 2 || row.tool !== DATUM_TOOL || row.nonAuthorizing !== true) fail('Unsupported or authorizing preference datum.', 'preference-datum-schema-invalid', 2);
  for (const [label, value] of [['study ID', row.studyId], ['study digest', row.studyDigest], ['source hash', row.sourceSha256], ['trial ID', row.trialId], ['datum digest', row.datumDigest]]) {
    if (!HASH.test(value)) fail(`Preference ${label} is invalid.`, 'preference-datum-hash-invalid', 2);
  }
  if (typeof row.sourceViewBox !== 'string' || !row.sourceViewBox || !SAFE_ID.test(row.raterId)) fail('Preference datum identity fields are invalid.', 'preference-datum-identity-invalid', 2);
  if (!['x', 'y'].includes(row.axis) || !CHOICES.has(row.choice) || typeof row.rtl !== 'boolean') fail('Preference datum choice or axis is invalid.', 'preference-datum-value-invalid', 2);
  if (!Array.isArray(row.targetSizes) || !row.targetSizes.length || row.targetSizes.some((size) => !Number.isInteger(size) || size < 1 || size > 512)) fail('Preference target sizes are invalid.', 'preference-datum-value-invalid', 2);
  if (!Array.isArray(row.themes) || !row.themes.length || row.themes.some((theme) => !['light', 'dark'].includes(theme))) fail('Preference themes are invalid.', 'preference-datum-value-invalid', 2);
  validateCandidate(row.candidateA, row.axis, 'Candidate A');
  validateCandidate(row.candidateB, row.axis, 'Candidate B');
  if (row.candidateA.id === row.candidateB.id) fail('Preference candidates must be distinct.', 'preference-candidate-duplicate', 2);
  const expectedTrialId = sha256(JSON.stringify({ version: 1, axis: row.axis, candidates: [row.candidateA.id, row.candidateB.id].sort() }));
  if (row.trialId !== expectedTrialId) fail('Preference trial ID does not match its candidate lineage.', 'preference-trial-lineage-invalid', 2);
  validateSourceFeatures(row.sourceFeatures);
  const expectedPreferred = row.choice === 'A' ? row.candidateA.id : row.choice === 'B' ? row.candidateB.id : null;
  if (row.preferredCandidateId !== expectedPreferred || row.tie !== (row.choice === 'TIE') || row.abstain !== (row.choice === 'ABSTAIN') || row.pairwiseWinnerEligible !== (row.choice === 'A' || row.choice === 'B')) {
    fail('Preference datum choice fields disagree.', 'preference-datum-choice-inconsistent', 2);
  }
  if (row.corpus) {
    exactKeys(row.corpus, ['familyId', 'groupId', 'sourceId'], 'Corpus identity');
    if (![row.corpus.familyId, row.corpus.groupId, row.corpus.sourceId].every((value) => SAFE_ID.test(value))) fail('Corpus identifiers are invalid.', 'preference-corpus-id-invalid', 2);
  }
  if (sha256(JSON.stringify(datumCore(row))) !== row.datumDigest) fail('Preference datum was modified after export.', 'preference-datum-tampered', 2);
  return true;
}

export function auditSourceFeatures(audit, axis) {
  const viewBox = audit?.source?.viewBox;
  const reference = audit?.measurements?.reference;
  const bounds = reference?.paintedBounds;
  const bearings = reference?.sideBearings;
  const centroid = reference?.centroid;
  if (!viewBox || !bounds || !bearings || !centroid) fail('Audit lacks source features required for preference training.', 'preference-audit-features-missing', 2);
  const horizontal = axis === 'x';
  const dimension = horizontal ? viewBox.width : viewBox.height;
  const orthogonalDimension = horizontal ? viewBox.height : viewBox.width;
  const center = (horizontal ? viewBox.x : viewBox.y) + dimension / 2;
  const centroidValue = horizontal ? centroid.x : centroid.y;
  const firstBearing = horizontal ? bearings.left : bearings.top;
  const secondBearing = horizontal ? bearings.right : bearings.bottom;
  const extent = horizontal ? bounds.width : bounds.height;
  const orthogonalExtent = horizontal ? bounds.height : bounds.width;
  const proposal = horizontal ? audit.recommendation?.dxPercent : audit.recommendation?.dyPercent;
  const features = {
    proposalPercent: formatNumber(Number.isFinite(proposal) ? proposal : 0, 6),
    centroidOffsetPercent: formatNumber(((center - centroidValue) / dimension) * 100, 6),
    bearingImbalancePercent: formatNumber(((secondBearing - firstBearing) / dimension) * 100, 6),
    extentPercent: formatNumber((extent / dimension) * 100, 6),
    orthogonalExtentPercent: formatNumber((orthogonalExtent / orthogonalDimension) * 100, 6),
    connectedComponents: reference.connectedComponents,
  };
  validateSourceFeatures(features);
  return features;
}

function axisValue(candidate, axis) {
  return axis === 'x' ? candidate.correction.dxPercent : candidate.correction.dyPercent;
}

function normalizedDatum(row) {
  validatePreferenceDatum(row);
  if (!row.corpus) fail('Preference datum is not assigned to a corpus source, group, and family.', 'preference-corpus-mapping-missing', 2);
  const ordered = [row.candidateA, row.candidateB].sort((a, b) => axisValue(a, row.axis) - axisValue(b, row.axis) || a.id.localeCompare(b.id));
  const key = sha256(JSON.stringify({ version: 1, sourceSha256: row.sourceSha256, axis: row.axis, candidates: ordered.map((item) => item.id) }));
  let vote = row.choice;
  if (row.choice === 'A' || row.choice === 'B') {
    const chosen = row.choice === 'A' ? row.candidateA.id : row.candidateB.id;
    vote = chosen === ordered[0].id ? 'candidate1' : 'candidate2';
  }
  return { row, key, candidates: ordered, vote, canonicalRater: row.raterId.toLowerCase() };
}

function choose2(number) {
  return number < 2 ? 0 : (number * (number - 1)) / 2;
}

function agreement(pairs, categories) {
  let observedNumerator = 0;
  let observedDenominator = 0;
  const totals = Object.fromEntries(categories.map((category) => [category, 0]));
  for (const pair of pairs) {
    const counts = categories.map((category) => pair.votes[category]);
    const n = counts.reduce((sum, count) => sum + count, 0);
    if (n >= 2) {
      observedNumerator += counts.reduce((sum, count) => sum + choose2(count), 0);
      observedDenominator += choose2(n);
    }
    categories.forEach((category, index) => { totals[category] += counts[index]; });
  }
  const observed = observedDenominator ? observedNumerator / observedDenominator : null;
  const total = Object.values(totals).reduce((sum, count) => sum + count, 0);
  const expected = total ? Object.values(totals).reduce((sum, count) => sum + (count / total) ** 2, 0) : null;
  const corrected = observed === null || expected === null || expected === 1 ? null : (observed - expected) / (1 - expected);
  return { observed: formatNumber(observed, 8), expected: formatNumber(expected, 8), chanceCorrected: formatNumber(corrected, 8), ratedPairs: pairs.filter((pair) => categories.reduce((sum, category) => sum + pair.votes[category], 0) >= 2).length };
}

function assignFolds(pairs, mode, requested, seed) {
  const weights = new Map();
  for (const pair of pairs.filter((item) => item.trainingEligible)) {
    const unit = mode === 'family' ? pair.familyId : `${pair.familyId}/${pair.groupId}`;
    weights.set(unit, (weights.get(unit) ?? 0) + pair.sampleWeight);
  }
  const units = [...weights].map(([id, weight]) => ({ id, weight }));
  const effectiveFolds = Math.min(requested, units.length);
  if (effectiveFolds < 2) return { requestedFolds: requested, effectiveFolds, status: 'INSUFFICIENT', assignments: {} };
  units.sort((a, b) => b.weight - a.weight || sha256(`${seed}:${mode}:${a.id}`).localeCompare(sha256(`${seed}:${mode}:${b.id}`)));
  const totals = Array(effectiveFolds).fill(0);
  const assignments = {};
  for (const unit of units) {
    let fold = 0;
    for (let index = 1; index < effectiveFolds; index += 1) if (totals[index] < totals[fold]) fold = index;
    assignments[unit.id] = fold;
    totals[fold] += unit.weight;
  }
  return { requestedFolds: requested, effectiveFolds, status: units.length >= requested ? 'READY' : 'LIMITED', assignments };
}

function datasetCore(dataset) {
  const { datasetDigest: _ignored, ...core } = dataset;
  return core;
}

export function aggregatePreferenceCorpus(rows, options = {}) {
  const minRaters = Number(options.minRaters ?? 3);
  const requestedFolds = Number(options.folds ?? 5);
  const seed = String(options.seed ?? 'optiai-v04');
  if (!Number.isInteger(minRaters) || minRaters < 3 || minRaters > 20) fail('Minimum raters must be an integer from 3 to 20.', 'preference-min-raters-invalid');
  if (!Number.isInteger(requestedFolds) || requestedFolds < 2 || requestedFolds > 10) fail('Folds must be an integer from 2 to 10.', 'preference-folds-invalid');
  if (!SAFE_ID.test(seed)) fail('Dataset seed must be a safe 1–64 character ID.', 'preference-seed-invalid');
  if (!Array.isArray(rows) || !rows.length || rows.length > 100000) fail('Preference corpus must contain 1–100000 rows.', 'preference-corpus-size-invalid', 2);

  const normalized = rows.map(normalizedDatum).sort((a, b) => `${a.row.sourceSha256}:${a.key}:${a.canonicalRater}`.localeCompare(`${b.row.sourceSha256}:${b.key}:${b.canonicalRater}`));
  const sourceIds = new Map();
  const sourceHashes = new Map();
  const sourceCorpus = new Map();
  const seenRaters = new Set();
  const pairs = new Map();
  for (const entry of normalized) {
    const { row } = entry;
    const priorHash = sourceIds.get(row.corpus.sourceId);
    const priorSource = sourceHashes.get(row.sourceSha256);
    if ((priorHash && priorHash !== row.sourceSha256) || (priorSource && priorSource !== row.corpus.sourceId)) fail('Corpus source IDs and source hashes must map one-to-one.', 'preference-corpus-source-conflict', 2);
    sourceIds.set(row.corpus.sourceId, row.sourceSha256);
    sourceHashes.set(row.sourceSha256, row.corpus.sourceId);
    const corpusIdentity = JSON.stringify(row.corpus);
    if (sourceCorpus.has(row.sourceSha256) && sourceCorpus.get(row.sourceSha256) !== corpusIdentity) fail('A source must keep one source, family, and group mapping.', 'preference-corpus-source-conflict', 2);
    sourceCorpus.set(row.sourceSha256, corpusIdentity);
    const duplicateKey = `${entry.key}:${entry.canonicalRater}`;
    if (seenRaters.has(duplicateKey)) fail('Duplicate canonical rater vote on the same pair.', 'preference-rater-pair-duplicate', 2);
    seenRaters.add(duplicateKey);
    let pair = pairs.get(entry.key);
    if (!pair) {
      pair = {
        key: entry.key,
        sourceId: row.corpus.sourceId,
        familyId: row.corpus.familyId,
        groupId: row.corpus.groupId,
        sourceSha256: row.sourceSha256,
        axis: row.axis,
        sourceFeatures: row.sourceFeatures,
        candidates: entry.candidates,
        votes: { candidate1: 0, candidate2: 0, TIE: 0, ABSTAIN: 0 },
      };
      pairs.set(entry.key, pair);
    } else if (JSON.stringify({ sourceId: pair.sourceId, familyId: pair.familyId, groupId: pair.groupId, sourceFeatures: pair.sourceFeatures, candidates: pair.candidates }) !== JSON.stringify({ sourceId: row.corpus.sourceId, familyId: row.corpus.familyId, groupId: row.corpus.groupId, sourceFeatures: row.sourceFeatures, candidates: entry.candidates })) {
      fail('Canonical pair metadata disagrees across rows.', 'preference-pair-metadata-conflict', 2);
    }
    pair.votes[entry.vote] += 1;
  }

  const pairList = [...pairs.values()].sort((a, b) => a.key.localeCompare(b.key));
  for (const pair of pairList) {
    const decisive = pair.votes.candidate1 + pair.votes.candidate2;
    const total = decisive + pair.votes.TIE + pair.votes.ABSTAIN;
    const winnerCandidateId = decisive >= minRaters && pair.votes.candidate1 !== pair.votes.candidate2
      ? pair.candidates[pair.votes.candidate1 > pair.votes.candidate2 ? 0 : 1].id
      : null;
    pair.votes = { ...pair.votes, decisive, total };
    pair.panel = {
      status: decisive < minRaters ? 'UNDERPOWERED' : winnerCandidateId ? 'WINNER' : 'UNRESOLVED',
      winnerCandidateId,
      majorityShare: decisive ? formatNumber(Math.max(pair.votes.candidate1, pair.votes.candidate2) / decisive, 8) : null,
    };
    pair.trainingEligible = decisive >= minRaters;
    pair.targetCandidate1 = pair.trainingEligible ? formatNumber(pair.votes.candidate1 / decisive, 8) : null;
  }
  const sourceAxisTotals = new Map();
  for (const pair of pairList.filter((item) => item.trainingEligible)) {
    const key = `${pair.sourceSha256}:${pair.axis}`;
    sourceAxisTotals.set(key, (sourceAxisTotals.get(key) ?? 0) + pair.votes.decisive);
  }
  for (const pair of pairList) {
    const total = sourceAxisTotals.get(`${pair.sourceSha256}:${pair.axis}`) ?? 0;
    pair.sampleWeight = pair.trainingEligible ? formatNumber(pair.votes.decisive / total, 10) : 0;
  }

  const families = [...new Set(pairList.map((pair) => pair.familyId))].sort();
  const groups = [...new Set(pairList.map((pair) => `${pair.familyId}/${pair.groupId}`))].sort();
  const eligibleFamilies = [...new Set(pairList.filter((pair) => pair.trainingEligible).map((pair) => pair.familyId))].sort();
  const eligibleGroups = [...new Set(pairList.filter((pair) => pair.trainingEligible).map((pair) => `${pair.familyId}/${pair.groupId}`))].sort();
  const eligiblePairs = pairList.filter((pair) => pair.trainingEligible).length;
  const reasons = [];
  if (eligibleFamilies.length < 4) reasons.push('fewer-than-4-eligible-families');
  if (eligibleGroups.length < 4) reasons.push('fewer-than-4-eligible-groups');
  if (eligiblePairs < 20) reasons.push('fewer-than-20-eligible-pairs');
  const folds = {
    family: assignFolds(pairList, 'family', requestedFolds, seed),
    group: assignFolds(pairList, 'group', requestedFolds, seed),
  };
  if (folds.family.effectiveFolds < 2) reasons.push('family-holdout-unavailable');
  if (folds.group.effectiveFolds < 2) reasons.push('group-holdout-unavailable');
  const core = {
    schemaVersion: 1,
    tool: DATASET_TOOL,
    nonAuthorizing: true,
    config: { minRaters, requestedFolds, seed, splitUnit: 'family-and-group' },
    stats: {
      rowCount: rows.length,
      sourceCount: sourceHashes.size,
      familyCount: families.length,
      groupCount: groups.length,
      eligibleFamilyCount: eligibleFamilies.length,
      eligibleGroupCount: eligibleGroups.length,
      pairCount: pairList.length,
      eligiblePairs,
      tieVotes: pairList.reduce((sum, pair) => sum + pair.votes.TIE, 0),
      abstainVotes: pairList.reduce((sum, pair) => sum + pair.votes.ABSTAIN, 0),
    },
    agreement: {
      fourWay: agreement(pairList, ['candidate1', 'candidate2', 'TIE', 'ABSTAIN']),
      preferenceOnly: agreement(pairList, ['candidate1', 'candidate2']),
    },
    folds,
    readiness: { status: reasons.length ? 'UNDERPOWERED' : 'READY', reasons },
    pairs: pairList,
  };
  return { ...core, datasetDigest: sha256(JSON.stringify(core)) };
}

export function validatePreferenceDataset(dataset) {
  exactKeys(dataset, ['schemaVersion', 'tool', 'nonAuthorizing', 'config', 'stats', 'agreement', 'folds', 'readiness', 'pairs', 'datasetDigest'], 'Preference dataset');
  if (dataset?.schemaVersion !== 1 || dataset?.tool !== DATASET_TOOL || dataset?.nonAuthorizing !== true) fail('Unsupported or authorizing preference dataset.', 'preference-dataset-schema-invalid', 2);
  if (!HASH.test(dataset.datasetDigest) || sha256(JSON.stringify(datasetCore(dataset))) !== dataset.datasetDigest) fail('Preference dataset was modified after aggregation.', 'preference-dataset-tampered', 2);
  if (!Array.isArray(dataset.pairs) || !dataset.pairs.length) fail('Preference dataset contains no pairs.', 'preference-dataset-empty', 2);
  exactKeys(dataset.config, ['minRaters', 'requestedFolds', 'seed', 'splitUnit'], 'Preference dataset config');
  if (!Number.isInteger(dataset.config.minRaters) || dataset.config.minRaters < 3 || !Number.isInteger(dataset.config.requestedFolds) || dataset.config.requestedFolds < 2 || !SAFE_ID.test(dataset.config.seed) || dataset.config.splitUnit !== 'family-and-group') fail('Preference dataset config is invalid.', 'preference-dataset-config-invalid', 2);
  if (containsForbiddenKey(dataset, new Set(['raterId', 'realpath']))) fail('Preference dataset leaks rater identity or local paths.', 'preference-dataset-privacy-invalid', 2);
  const pairKeys = new Set();
  const sourceIds = new Map();
  const sourceHashes = new Map();
  const sourceCorpus = new Map();
  const sourceAxisTotals = new Map();
  for (const pair of dataset.pairs) {
    exactKeys(pair, ['key', 'sourceId', 'familyId', 'groupId', 'sourceSha256', 'axis', 'sourceFeatures', 'candidates', 'votes', 'panel', 'trainingEligible', 'targetCandidate1', 'sampleWeight'], 'Preference dataset pair');
    if (!HASH.test(pair.key) || !HASH.test(pair.sourceSha256) || !['x', 'y'].includes(pair.axis) || pair.candidates?.length !== 2) fail('Preference dataset pair is invalid.', 'preference-dataset-pair-invalid', 2);
    if (![pair.sourceId, pair.familyId, pair.groupId].every((value) => SAFE_ID.test(value)) || pairKeys.has(pair.key)) fail('Preference dataset pair identity is invalid.', 'preference-dataset-pair-invalid', 2);
    pairKeys.add(pair.key);
    const priorHash = sourceIds.get(pair.sourceId);
    const priorId = sourceHashes.get(pair.sourceSha256);
    if ((priorHash && priorHash !== pair.sourceSha256) || (priorId && priorId !== pair.sourceId)) fail('Preference dataset source mapping is inconsistent.', 'preference-dataset-source-invalid', 2);
    sourceIds.set(pair.sourceId, pair.sourceSha256);
    sourceHashes.set(pair.sourceSha256, pair.sourceId);
    const corpusIdentity = JSON.stringify({ sourceId: pair.sourceId, familyId: pair.familyId, groupId: pair.groupId });
    if (sourceCorpus.has(pair.sourceSha256) && sourceCorpus.get(pair.sourceSha256) !== corpusIdentity) fail('Preference dataset splits one source across corpus units.', 'preference-dataset-source-invalid', 2);
    sourceCorpus.set(pair.sourceSha256, corpusIdentity);
    exactKeys(pair.votes, ['candidate1', 'candidate2', 'TIE', 'ABSTAIN', 'decisive', 'total'], 'Preference dataset votes');
    if (Object.values(pair.votes).some((count) => !Number.isInteger(count) || count < 0)) fail('Preference dataset vote counts are invalid.', 'preference-dataset-votes-invalid', 2);
    if (pair.votes.total !== pair.votes.candidate1 + pair.votes.candidate2 + pair.votes.TIE + pair.votes.ABSTAIN || pair.votes.decisive !== pair.votes.candidate1 + pair.votes.candidate2) fail('Preference dataset vote totals disagree.', 'preference-dataset-votes-invalid', 2);
    validateSourceFeatures(pair.sourceFeatures);
    pair.candidates.forEach((candidate) => validateCandidate(candidate, pair.axis, 'Dataset candidate'));
    if (axisValue(pair.candidates[0], pair.axis) > axisValue(pair.candidates[1], pair.axis)) fail('Preference dataset candidates are not canonicalized.', 'preference-dataset-pair-invalid', 2);
    const expectedKey = sha256(JSON.stringify({ version: 1, sourceSha256: pair.sourceSha256, axis: pair.axis, candidates: pair.candidates.map((candidate) => candidate.id) }));
    if (pair.key !== expectedKey) fail('Preference dataset pair key is invalid.', 'preference-dataset-pair-invalid', 2);
    const eligible = pair.votes.decisive >= dataset.config.minRaters;
    const expectedWinner = eligible && pair.votes.candidate1 !== pair.votes.candidate2 ? pair.candidates[pair.votes.candidate1 > pair.votes.candidate2 ? 0 : 1].id : null;
    const expectedPanel = {
      status: !eligible ? 'UNDERPOWERED' : expectedWinner ? 'WINNER' : 'UNRESOLVED',
      winnerCandidateId: expectedWinner,
      majorityShare: pair.votes.decisive ? formatNumber(Math.max(pair.votes.candidate1, pair.votes.candidate2) / pair.votes.decisive, 8) : null,
    };
    if (pair.trainingEligible !== eligible || pair.targetCandidate1 !== (eligible ? formatNumber(pair.votes.candidate1 / pair.votes.decisive, 8) : null) || JSON.stringify(pair.panel) !== JSON.stringify(expectedPanel)) fail('Preference dataset panel outcome is inconsistent.', 'preference-dataset-panel-invalid', 2);
    if (eligible) {
      const sourceAxis = `${pair.sourceSha256}:${pair.axis}`;
      sourceAxisTotals.set(sourceAxis, (sourceAxisTotals.get(sourceAxis) ?? 0) + pair.votes.decisive);
    }
  }
  const weightTotals = new Map();
  for (const pair of dataset.pairs) {
    const sourceAxis = `${pair.sourceSha256}:${pair.axis}`;
    const expectedWeight = pair.trainingEligible ? formatNumber(pair.votes.decisive / sourceAxisTotals.get(sourceAxis), 10) : 0;
    if (pair.sampleWeight !== expectedWeight) fail('Preference dataset sample weights are inconsistent.', 'preference-dataset-weight-invalid', 2);
    if (pair.trainingEligible) weightTotals.set(sourceAxis, (weightTotals.get(sourceAxis) ?? 0) + pair.sampleWeight);
  }
  if ([...weightTotals.values()].some((total) => Math.abs(total - 1) > 1e-8)) fail('Preference dataset source-axis weights are not normalized.', 'preference-dataset-weight-invalid', 2);
  const families = [...new Set(dataset.pairs.map((pair) => pair.familyId))].sort();
  const groups = [...new Set(dataset.pairs.map((pair) => `${pair.familyId}/${pair.groupId}`))].sort();
  const eligibleFamilies = [...new Set(dataset.pairs.filter((pair) => pair.trainingEligible).map((pair) => pair.familyId))].sort();
  const eligibleGroups = [...new Set(dataset.pairs.filter((pair) => pair.trainingEligible).map((pair) => `${pair.familyId}/${pair.groupId}`))].sort();
  const eligiblePairs = dataset.pairs.filter((pair) => pair.trainingEligible).length;
  const expectedStats = {
    rowCount: dataset.pairs.reduce((sum, pair) => sum + pair.votes.total, 0),
    sourceCount: sourceHashes.size,
    familyCount: families.length,
    groupCount: groups.length,
    eligibleFamilyCount: eligibleFamilies.length,
    eligibleGroupCount: eligibleGroups.length,
    pairCount: dataset.pairs.length,
    eligiblePairs,
    tieVotes: dataset.pairs.reduce((sum, pair) => sum + pair.votes.TIE, 0),
    abstainVotes: dataset.pairs.reduce((sum, pair) => sum + pair.votes.ABSTAIN, 0),
  };
  if (JSON.stringify(dataset.stats) !== JSON.stringify(expectedStats)) fail('Preference dataset statistics are inconsistent.', 'preference-dataset-stats-invalid', 2);
  const expectedAgreement = {
    fourWay: agreement(dataset.pairs, ['candidate1', 'candidate2', 'TIE', 'ABSTAIN']),
    preferenceOnly: agreement(dataset.pairs, ['candidate1', 'candidate2']),
  };
  if (JSON.stringify(dataset.agreement) !== JSON.stringify(expectedAgreement)) fail('Preference dataset agreement is inconsistent.', 'preference-dataset-agreement-invalid', 2);
  const expectedFolds = {
    family: assignFolds(dataset.pairs, 'family', dataset.config.requestedFolds, dataset.config.seed),
    group: assignFolds(dataset.pairs, 'group', dataset.config.requestedFolds, dataset.config.seed),
  };
  if (JSON.stringify(dataset.folds) !== JSON.stringify(expectedFolds)) fail('Preference dataset fold assignments are inconsistent.', 'preference-dataset-fold-invalid', 2);
  const reasons = [];
  if (eligibleFamilies.length < 4) reasons.push('fewer-than-4-eligible-families');
  if (eligibleGroups.length < 4) reasons.push('fewer-than-4-eligible-groups');
  if (eligiblePairs < 20) reasons.push('fewer-than-20-eligible-pairs');
  if (expectedFolds.family.effectiveFolds < 2) reasons.push('family-holdout-unavailable');
  if (expectedFolds.group.effectiveFolds < 2) reasons.push('group-holdout-unavailable');
  const expectedReadiness = { status: reasons.length ? 'UNDERPOWERED' : 'READY', reasons };
  if (JSON.stringify(dataset.readiness) !== JSON.stringify(expectedReadiness)) fail('Preference dataset readiness is inconsistent.', 'preference-dataset-readiness-invalid', 2);
  return true;
}

function candidateFeatures(candidate, pair) {
  const q = axisValue(candidate, pair.axis) / 5;
  const r = pair.sourceFeatures.proposalPercent / 5;
  return [-q * q, 2 * q * r, -Math.abs(q)];
}

function featureDifference(pair) {
  const first = candidateFeatures(pair.candidates[0], pair);
  const second = candidateFeatures(pair.candidates[1], pair);
  return first.map((value, index) => value - second[index]);
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function dot(left, right) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

export function trainAxis(pairs, options = {}) {
  const iterations = Number(options.iterations ?? 1500);
  const learningRate = Number(options.learningRate ?? 0.15);
  const l2 = Number(options.l2 ?? 0.01);
  if (!Number.isInteger(iterations) || iterations < 100 || iterations > 10000 || !Number.isFinite(learningRate) || learningRate <= 0 || learningRate > 1 || !Number.isFinite(l2) || l2 < 0 || l2 > 1) fail('Ranker training options are invalid.', 'preference-training-options-invalid');
  const examples = pairs.filter((pair) => pair.trainingEligible).sort((a, b) => a.key.localeCompare(b.key)).map((pair) => ({ x: featureDifference(pair), y: pair.targetCandidate1, weight: pair.sampleWeight }));
  if (examples.length < 5) return null;
  if (FEATURE_NAMES.every((_, index) => examples.every((example) => Math.abs(example.x[index] - examples[0].x[index]) < 1e-12))) return null;
  const weights = [0, 0, 0];
  const totalWeight = examples.reduce((sum, example) => sum + example.weight, 0);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const gradient = [0, 0, 0];
    for (const example of examples) {
      const error = sigmoid(dot(weights, example.x)) - example.y;
      for (let index = 0; index < gradient.length; index += 1) gradient[index] += example.weight * error * example.x[index];
    }
    for (let index = 0; index < weights.length; index += 1) {
      gradient[index] = gradient[index] / totalWeight + l2 * weights[index];
      weights[index] -= learningRate * gradient[index];
    }
  }
  return weights.map((value) => formatNumber(value, 10));
}

function prediction(pair, weights) {
  return sigmoid(dot(weights, featureDifference(pair)));
}

function evaluateRecords(records, modelName) {
  const eligible = records.filter((record) => Number.isFinite(record[modelName]));
  const totalWeight = eligible.reduce((sum, record) => sum + record.weight, 0);
  if (!eligible.length || !totalWeight) return { eligiblePairs: 0, winnerPairs: 0, winnerAccuracy: null, logLoss: null, brier: null, riskCoverage: [] };
  let logLoss = 0;
  let brier = 0;
  let winnerWeight = 0;
  let correctWeight = 0;
  for (const record of eligible) {
    const probability = Math.min(1 - 1e-12, Math.max(1e-12, record[modelName]));
    logLoss += record.weight * (-(record.target * Math.log(probability) + (1 - record.target) * Math.log(1 - probability)));
    brier += record.weight * (probability - record.target) ** 2;
    if (record.target !== 0.5) {
      winnerWeight += record.weight;
      if ((probability > 0.5) === (record.target > 0.5)) correctWeight += record.weight;
    }
  }
  const riskCoverage = [0.5, 0.6, 0.7, 0.8, 0.9].map((threshold) => {
    const selected = eligible.filter((record) => record.target !== 0.5 && Math.max(record[modelName], 1 - record[modelName]) >= threshold);
    const selectedWeight = selected.reduce((sum, record) => sum + record.weight, 0);
    const correct = selected.reduce((sum, record) => sum + (((record[modelName] > 0.5) === (record.target > 0.5)) ? record.weight : 0), 0);
    return { threshold, coverage: formatNumber(winnerWeight ? selectedWeight / winnerWeight : null, 8), risk: formatNumber(selectedWeight ? 1 - correct / selectedWeight : null, 8) };
  });
  return {
    eligiblePairs: eligible.length,
    winnerPairs: eligible.filter((record) => record.target !== 0.5).length,
    winnerAccuracy: formatNumber(winnerWeight ? correctWeight / winnerWeight : null, 8),
    logLoss: formatNumber(logLoss / totalWeight, 8),
    brier: formatNumber(brier / totalWeight, 8),
    riskCoverage,
  };
}

function crossValidate(dataset, mode, options) {
  const foldConfig = dataset.folds[mode];
  if (foldConfig.effectiveFolds < 2) return { status: 'INSUFFICIENT', folds: 0, holdoutPairs: 0, evaluatedPairs: 0, evaluationCoverage: null, models: { learned: evaluateRecords([], 'learned'), zero: evaluateRecords([], 'zero'), alphaCentroid: evaluateRecords([], 'alphaCentroid') } };
  const records = [];
  let holdoutPairs = 0;
  for (let fold = 0; fold < foldConfig.effectiveFolds; fold += 1) {
    const unitFor = (pair) => mode === 'family' ? pair.familyId : `${pair.familyId}/${pair.groupId}`;
    const training = dataset.pairs.filter((pair) => pair.trainingEligible && foldConfig.assignments[unitFor(pair)] !== fold);
    const holdout = dataset.pairs.filter((pair) => pair.trainingEligible && foldConfig.assignments[unitFor(pair)] === fold);
    const weights = {
      x: trainAxis(training.filter((pair) => pair.axis === 'x'), options),
      y: trainAxis(training.filter((pair) => pair.axis === 'y'), options),
    };
    for (const pair of holdout) {
      holdoutPairs += 1;
      const learnedWeights = weights[pair.axis];
      if (!learnedWeights) continue;
      records.push({
        target: pair.targetCandidate1,
        weight: pair.sampleWeight,
        learned: learnedWeights ? prediction(pair, learnedWeights) : null,
        zero: prediction(pair, [1, 0, 0]),
        alphaCentroid: prediction(pair, [1, 1, 0]),
      });
    }
  }
  return {
    status: foldConfig.status,
    folds: foldConfig.effectiveFolds,
    holdoutPairs,
    evaluatedPairs: records.length,
    evaluationCoverage: formatNumber(holdoutPairs ? records.length / holdoutPairs : null, 8),
    models: {
      learned: evaluateRecords(records, 'learned'),
      zero: evaluateRecords(records, 'zero'),
      alphaCentroid: evaluateRecords(records, 'alphaCentroid'),
    },
  };
}

function modelCore(model) {
  const { modelDigest: _ignored, ...core } = model;
  return core;
}

export function trainPreferenceRanker(dataset, options = {}) {
  validatePreferenceDataset(dataset);
  if (dataset.readiness?.status !== 'READY') fail(`Preference dataset is underpowered: ${(dataset.readiness?.reasons ?? []).join(', ')}`, 'preference-dataset-underpowered', 2);
  const eligible = dataset.pairs.filter((pair) => pair.trainingEligible);
  const weights = {
    x: trainAxis(eligible.filter((pair) => pair.axis === 'x'), options),
    y: trainAxis(eligible.filter((pair) => pair.axis === 'y'), options),
  };
  if (!weights.x && !weights.y) fail('Preference dataset has no trainable axis with feature variance.', 'preference-training-no-variance', 2);
  const evaluation = {
    family: crossValidate(dataset, 'family', options),
    group: crossValidate(dataset, 'group', options),
  };
  const family = evaluation.family.models;
  const learned = family.learned;
  const beatsBaselines = learned.winnerPairs >= 10
    && evaluation.family.evaluationCoverage === 1
    && learned.eligiblePairs === family.zero.eligiblePairs
    && learned.eligiblePairs === family.alphaCentroid.eligiblePairs
    && learned.winnerAccuracy !== null
    && learned.winnerAccuracy > Math.max(family.zero.winnerAccuracy ?? 0, family.alphaCentroid.winnerAccuracy ?? 0)
    && learned.logLoss < Math.min(family.zero.logLoss ?? Infinity, family.alphaCentroid.logLoss ?? Infinity)
    && dataset.stats.eligibleFamilyCount >= 5;
  const core = {
    schemaVersion: 1,
    tool: MODEL_TOOL,
    nonAuthorizing: true,
    modelKind: 'transparent-logistic-pairwise-v1',
    featureVersion: 'optiai-calibration-v1',
    featureNames: FEATURE_NAMES,
    scalePercent: 5,
    dataset: { digest: dataset.datasetDigest, eligiblePairs: dataset.stats.eligiblePairs, eligibleFamilies: dataset.stats.eligibleFamilyCount, eligibleGroups: dataset.stats.eligibleGroupCount },
    training: {
      iterations: Number(options.iterations ?? 1500),
      learningRate: Number(options.learningRate ?? 0.15),
      l2: Number(options.l2 ?? 0.01),
      deterministic: true,
      finalFit: 'all-eligible-pairs',
    },
    weights,
    evaluation,
    evaluationStatus: beatsBaselines ? 'PROMISING_RESEARCH_ONLY' : 'RESEARCH_ONLY_BASELINE_NOT_BEATEN',
    recommendedForCalibration: beatsBaselines,
    safety: {
      authorizesCorrection: false,
      acceptedByVerifyExport: false,
      acceptedByApplyCorrection: false,
      humanComparisonRequired: true,
    },
  };
  return { ...core, modelDigest: sha256(JSON.stringify(core)) };
}

export function validatePreferenceModel(model) {
  exactKeys(model, ['schemaVersion', 'tool', 'nonAuthorizing', 'modelKind', 'featureVersion', 'featureNames', 'scalePercent', 'dataset', 'training', 'weights', 'evaluation', 'evaluationStatus', 'recommendedForCalibration', 'safety', 'modelDigest'], 'Preference model');
  if (model?.schemaVersion !== 1 || model?.tool !== MODEL_TOOL || model?.nonAuthorizing !== true || model.modelKind !== 'transparent-logistic-pairwise-v1' || model.featureVersion !== 'optiai-calibration-v1' || JSON.stringify(model.featureNames) !== JSON.stringify(FEATURE_NAMES) || model.scalePercent !== 5) fail('Unsupported or authorizing preference model.', 'preference-model-schema-invalid', 2);
  if (!HASH.test(model.modelDigest) || sha256(JSON.stringify(modelCore(model))) !== model.modelDigest) fail('Preference model was modified after training.', 'preference-model-tampered', 2);
  exactKeys(model.dataset, ['digest', 'eligiblePairs', 'eligibleFamilies', 'eligibleGroups'], 'Preference model dataset');
  if (!HASH.test(model.dataset.digest) || [model.dataset.eligiblePairs, model.dataset.eligibleFamilies, model.dataset.eligibleGroups].some((value) => !Number.isInteger(value) || value < 0)) fail('Preference model dataset evidence is invalid.', 'preference-model-dataset-invalid', 2);
  exactKeys(model.training, ['iterations', 'learningRate', 'l2', 'deterministic', 'finalFit'], 'Preference model training');
  if (!Number.isInteger(model.training.iterations) || model.training.iterations < 100 || !Number.isFinite(model.training.learningRate) || model.training.learningRate <= 0 || !Number.isFinite(model.training.l2) || model.training.l2 < 0 || model.training.deterministic !== true || model.training.finalFit !== 'all-eligible-pairs') fail('Preference model training metadata is invalid.', 'preference-model-training-invalid', 2);
  exactKeys(model.weights, ['x', 'y'], 'Preference model weights');
  const validWeights = (weights) => weights === null || (Array.isArray(weights) && weights.length === FEATURE_NAMES.length && weights.every(Number.isFinite));
  if (!validWeights(model.weights.x) || !validWeights(model.weights.y) || (!model.weights.x && !model.weights.y)) fail('Preference model weights are invalid.', 'preference-model-weights-invalid', 2);
  const validateEvaluation = (evaluation, label) => {
    exactKeys(evaluation, ['status', 'folds', 'holdoutPairs', 'evaluatedPairs', 'evaluationCoverage', 'models'], label);
    if (!['READY', 'LIMITED', 'INSUFFICIENT'].includes(evaluation.status) || !Number.isInteger(evaluation.folds) || evaluation.folds < 0 || !Number.isInteger(evaluation.holdoutPairs) || evaluation.holdoutPairs < 0 || !Number.isInteger(evaluation.evaluatedPairs) || evaluation.evaluatedPairs < 0 || evaluation.evaluatedPairs > evaluation.holdoutPairs) fail(`${label} counts are invalid.`, 'preference-model-evaluation-invalid', 2);
    const expectedCoverage = evaluation.holdoutPairs ? formatNumber(evaluation.evaluatedPairs / evaluation.holdoutPairs, 8) : null;
    if (evaluation.evaluationCoverage !== expectedCoverage) fail(`${label} coverage is invalid.`, 'preference-model-evaluation-invalid', 2);
    exactKeys(evaluation.models, ['learned', 'zero', 'alphaCentroid'], `${label} models`);
    for (const metrics of Object.values(evaluation.models)) {
      exactKeys(metrics, ['eligiblePairs', 'winnerPairs', 'winnerAccuracy', 'logLoss', 'brier', 'riskCoverage'], `${label} metrics`);
      if (!Number.isInteger(metrics.eligiblePairs) || metrics.eligiblePairs < 0 || !Number.isInteger(metrics.winnerPairs) || metrics.winnerPairs < 0 || metrics.winnerPairs > metrics.eligiblePairs) fail(`${label} metric counts are invalid.`, 'preference-model-evaluation-invalid', 2);
      for (const key of ['winnerAccuracy', 'logLoss', 'brier']) if (metrics[key] !== null && (!Number.isFinite(metrics[key]) || metrics[key] < 0)) fail(`${label} metric ${key} is invalid.`, 'preference-model-evaluation-invalid', 2);
      if (!Array.isArray(metrics.riskCoverage) || metrics.riskCoverage.some((item) => !item || !Number.isFinite(item.threshold) || (item.coverage !== null && (!Number.isFinite(item.coverage) || item.coverage < 0 || item.coverage > 1)) || (item.risk !== null && (!Number.isFinite(item.risk) || item.risk < 0 || item.risk > 1)))) fail(`${label} risk coverage is invalid.`, 'preference-model-evaluation-invalid', 2);
    }
    if (evaluation.models.learned.eligiblePairs !== evaluation.models.zero.eligiblePairs || evaluation.models.learned.eligiblePairs !== evaluation.models.alphaCentroid.eligiblePairs) fail(`${label} models were not evaluated on one shared cohort.`, 'preference-model-evaluation-invalid', 2);
  };
  exactKeys(model.evaluation, ['family', 'group'], 'Preference model evaluation');
  validateEvaluation(model.evaluation.family, 'Family evaluation');
  validateEvaluation(model.evaluation.group, 'Group evaluation');
  const family = model.evaluation.family.models;
  const learned = family.learned;
  const expectedPromotion = learned.winnerPairs >= 10
    && model.evaluation.family.evaluationCoverage === 1
    && learned.winnerAccuracy !== null
    && learned.winnerAccuracy > Math.max(family.zero.winnerAccuracy ?? 0, family.alphaCentroid.winnerAccuracy ?? 0)
    && learned.logLoss < Math.min(family.zero.logLoss ?? Infinity, family.alphaCentroid.logLoss ?? Infinity)
    && model.dataset.eligibleFamilies >= 5;
  if (model.recommendedForCalibration !== expectedPromotion || model.evaluationStatus !== (expectedPromotion ? 'PROMISING_RESEARCH_ONLY' : 'RESEARCH_ONLY_BASELINE_NOT_BEATEN')) fail('Preference model promotion status is inconsistent.', 'preference-model-status-invalid', 2);
  exactKeys(model.safety, ['authorizesCorrection', 'acceptedByVerifyExport', 'acceptedByApplyCorrection', 'humanComparisonRequired'], 'Preference model safety');
  if (model.safety.authorizesCorrection !== false || model.safety.acceptedByVerifyExport !== false || model.safety.acceptedByApplyCorrection !== false || model.safety.humanComparisonRequired !== true) fail('Preference model safety contract is invalid.', 'preference-model-safety-invalid', 2);
  if (containsForbiddenKey(model, new Set(['raterId', 'realpath', 'approved', 'verification']))) fail('Preference model contains forbidden identity or authorization fields.', 'preference-model-privacy-invalid', 2);
  return true;
}

import { sha256 } from './svg-document.mjs';
import { fail, formatNumber } from './svg-utils.mjs';

const MANIFEST_TOOL = 'OptiAI Fixed Benchmark Manifest';
const STUDY_TOOL = 'OptiAI Fixed Blind Benchmark Study';
const RESPONSE_TOOL = 'OptiAI Fixed Benchmark Response';
const REPORT_TOOL = 'OptiAI Fixed Benchmark Report';
const GATE_TOOL = 'OptiAI Benchmark Promotion Gate';
const POLICIES = ['zero-v1', 'alpha-centroid-v1', 'ensemble-v05', 'learned-v06'];
const BASELINES = ['zero-v1', 'alpha-centroid-v1', 'ensemble-v05'];
const CHOICES = new Set(['A', 'B', 'TIE', 'ABSTAIN']);
const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const REQUIRED_HAZARDS = ['active-content', 'external-reference', 'malformed-bounds', 'detached-mark', 'signal-disagreement', 'full-bleed-clipping', 'already-centered', 'out-of-range-proposal'];

function withoutDigest(value, key) { const clone = { ...value }; delete clone[key]; return clone; }
function containsForbiddenKey(value, forbidden) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsForbiddenKey(item, forbidden));
  return Object.entries(value).some(([key, item]) => forbidden.has(key) || containsForbiddenKey(item, forbidden));
}
function outputCandidateId(caseId, axis, percent) { return sha256(JSON.stringify({ version: 1, caseId, axis, percent })); }

function validateTraining(training) {
  if (!HASH.test(training?.datasetDigest) || !HASH.test(training?.modelDigest)) fail('Benchmark training bindings are invalid.', 'benchmark-training-invalid', 2);
  for (const key of ['sourceSha256s', 'familyIds', 'groupIds']) if (!Array.isArray(training[key])) fail('Benchmark training provenance is incomplete.', 'benchmark-training-invalid', 2);
  if (training.sourceSha256s.some((value) => !HASH.test(value)) || training.familyIds.some((value) => !SAFE_ID.test(value)) || training.groupIds.some((value) => !/^[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._-]{1,64}$/u.test(value))) fail('Benchmark training provenance is invalid.', 'benchmark-training-invalid', 2);
}

function validateOutput(output, label) {
  if (output?.status === 'VALUE') {
    const keys = Object.keys(output).sort().join(',');
    if (!Number.isFinite(output.percent) || Math.abs(output.percent) > 5 || !['percent,status', 'modelDigest,percent,status'].includes(keys) || (output.modelDigest !== undefined && !HASH.test(output.modelDigest))) fail(`${label} benchmark output is invalid.`, 'benchmark-output-invalid', 2);
  } else if (output?.status === 'ABSTAIN') {
    const keys = Object.keys(output).sort().join(',');
    if (!SAFE_ID.test(output.reasonCode) || !['reasonCode,status', 'modelDigest,reasonCode,status'].includes(keys) || (output.modelDigest !== undefined && !HASH.test(output.modelDigest))) fail(`${label} benchmark abstention is invalid.`, 'benchmark-output-invalid', 2);
  } else fail(`${label} benchmark output must be VALUE or ABSTAIN.`, 'benchmark-output-invalid', 2);
}

function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || manifest?.tool !== MANIFEST_TOOL || manifest?.nonAuthorizing !== true || manifest?.holdoutOnly !== true || !SAFE_ID.test(manifest.benchmarkId) || !SAFE_ID.test(manifest.seed)) fail('Unsupported or authorizing benchmark manifest.', 'benchmark-manifest-invalid', 2);
  if (!Array.isArray(manifest.cases) || !manifest.cases.length || !Array.isArray(manifest.hazards) || manifest.hazards.length < REQUIRED_HAZARDS.length) fail('Benchmark manifest needs cases and the complete fixed hazard suite.', 'benchmark-manifest-invalid', 2);
  const caseIds = new Set();
  const sourceIds = new Map(), sourceHashes = new Map(), sourceCorpus = new Map();
  for (const item of manifest.cases) {
    if (![item.caseId, item.sourceId, item.familyId, item.groupId].every((value) => SAFE_ID.test(value)) || caseIds.has(item.caseId) || !HASH.test(item.sourceSha256) || !['x', 'y'].includes(item.axis)) fail('Benchmark case identity is invalid.', 'benchmark-case-invalid', 2);
    caseIds.add(item.caseId);
    const priorHash = sourceIds.get(item.sourceId), priorId = sourceHashes.get(item.sourceSha256);
    if ((priorHash && priorHash !== item.sourceSha256) || (priorId && priorId !== item.sourceId)) fail('Benchmark source IDs and hashes must map one-to-one.', 'benchmark-source-identity-invalid', 2);
    sourceIds.set(item.sourceId, item.sourceSha256); sourceHashes.set(item.sourceSha256, item.sourceId);
    const corpus = `${item.familyId}/${item.groupId}`;
    if (sourceCorpus.has(item.sourceSha256) && sourceCorpus.get(item.sourceSha256) !== corpus) fail('One benchmark source cannot cross family or group boundaries.', 'benchmark-source-identity-invalid', 2);
    sourceCorpus.set(item.sourceSha256, corpus);
    if (!Number.isInteger(item.condition?.size) || item.condition.size < 8 || item.condition.size > 512 || !['light', 'dark'].includes(item.condition.theme) || !SAFE_ID.test(item.condition.context)) fail('Benchmark case must contain one bounded size, theme, and context.', 'benchmark-condition-invalid', 2);
    if (!item.outputs || Object.keys(item.outputs).sort().join(',') !== [...POLICIES].sort().join(',')) fail('Benchmark case must bind exactly four policies.', 'benchmark-output-invalid', 2);
    for (const policy of POLICIES) validateOutput(item.outputs[policy], policy);
    if (item.outputs['ensemble-v05'].status === 'ABSTAIN' && item.outputs['learned-v06'].status !== 'ABSTAIN') fail('Learned policy cannot bypass the ensemble safety wrapper abstention.', 'benchmark-safety-wrapper-invalid', 2);
  }
  const hazardTypes = new Set();
  for (const hazard of manifest.hazards) {
    if (!SAFE_ID.test(hazard?.caseId) || !REQUIRED_HAZARDS.includes(hazard.hazardType) || hazardTypes.has(hazard.hazardType) || hazard.expectedStatus !== 'ABSTAIN' || !SAFE_ID.test(hazard.expectedReasonCode)) fail('Benchmark hazard expectation is invalid or duplicated.', 'benchmark-hazard-invalid', 2);
    hazardTypes.add(hazard.hazardType);
    validateOutput(hazard.learnedOutput, 'hazard learned');
  }
  if (REQUIRED_HAZARDS.some((type) => !hazardTypes.has(type))) fail('Benchmark manifest is missing a required hazard type.', 'benchmark-hazard-invalid', 2);
}

export function buildFixedBenchmarkStudy(manifest, training) {
  validateManifest(manifest);
  validateTraining(training);
  const trainingSources = new Set(training.sourceSha256s), trainingFamilies = new Set(training.familyIds), trainingGroups = new Set(training.groupIds);
  for (const item of manifest.cases) {
    if (trainingSources.has(item.sourceSha256) || trainingFamilies.has(item.familyId) || trainingGroups.has(`${item.familyId}/${item.groupId}`)) fail('Fixed benchmark overlaps a training source, family, or group.', 'benchmark-training-overlap', 2);
    if (item.outputs['learned-v06'].modelDigest !== training.modelDigest) fail('Learned benchmark output is not bound to the supplied frozen model.', 'benchmark-model-output-mismatch', 2);
  }
  for (const hazard of manifest.hazards) if (hazard.learnedOutput.modelDigest !== training.modelDigest) fail('Learned hazard output is not bound to the supplied frozen model.', 'benchmark-model-output-mismatch', 2);
  const trials = [], bindings = {}, cases = [];
  for (const item of [...manifest.cases].sort((a, b) => a.caseId.localeCompare(b.caseId))) {
    const outputs = Object.fromEntries(POLICIES.map((policy) => {
      const output = item.outputs[policy];
      return [policy, output.status === 'VALUE' ? { ...output, candidateId: outputCandidateId(item.caseId, item.axis, output.percent) } : output];
    }));
    cases.push({ caseId: item.caseId, sourceId: item.sourceId, familyId: item.familyId, groupId: item.groupId, sourceSha256: item.sourceSha256, outputs });
    for (const baseline of BASELINES) {
      const learned = outputs['learned-v06'], comparator = outputs[baseline];
      if (learned.status !== 'VALUE' || comparator.status !== 'VALUE') continue;
      if (learned.candidateId === comparator.candidateId) continue;
      const pair = [learned.candidateId, comparator.candidateId].sort();
      const id = sha256(JSON.stringify({ version: 1, benchmarkId: manifest.benchmarkId, caseId: item.caseId, baseline, candidates: pair }));
      const flip = Number.parseInt(sha256(`${manifest.seed}:${id}`).slice(0, 8), 16) % 2 === 1;
      const presentation = { A: flip ? comparator.candidateId : learned.candidateId, B: flip ? learned.candidateId : comparator.candidateId };
      trials.push({ id, caseId: item.caseId, axis: item.axis, condition: item.condition, presentation });
      bindings[id] = { baseline, learnedCandidateId: learned.candidateId, comparatorCandidateId: comparator.candidateId, familyId: item.familyId, sourceId: item.sourceId, sourceSha256: item.sourceSha256 };
    }
  }
  trials.sort((a, b) => a.id.localeCompare(b.id));
  trials.forEach((trial, index) => { trial.participantId = `q-${(index + 1).toString(36)}`; });
  const core = {
    schemaVersion: 1, tool: STUDY_TOOL, nonAuthorizing: true,
    blindness: 'ui-label-blind-not-adversarial', benchmarkId: manifest.benchmarkId, seed: manifest.seed,
    bindings: { manifestDigest: sha256(JSON.stringify(manifest)), datasetDigest: training.datasetDigest, modelDigest: training.modelDigest },
    trainingDisjoint: true, policies: POLICIES, cases, hazards: structuredClone(manifest.hazards), trials, trialBindings: bindings,
  };
  const studyDigest = sha256(JSON.stringify(core));
  return { ...core, studyDigest, studyId: sha256(`optiai-fixed-benchmark-v1:${studyDigest}`) };
}

export function validateFixedBenchmarkStudy(study) {
  if (study?.schemaVersion !== 1 || study?.tool !== STUDY_TOOL || study?.nonAuthorizing !== true || study?.trainingDisjoint !== true || study.blindness !== 'ui-label-blind-not-adversarial') fail('Unsupported or authorizing fixed benchmark study.', 'benchmark-study-invalid', 2);
  const digest = sha256(JSON.stringify(withoutDigest(withoutDigest(study, 'studyId'), 'studyDigest')));
  if (study.studyDigest !== digest || study.studyId !== sha256(`optiai-fixed-benchmark-v1:${digest}`)) fail('Fixed benchmark study was modified after generation.', 'benchmark-study-tampered', 2);
  if (JSON.stringify(study.policies) !== JSON.stringify(POLICIES) || !Array.isArray(study.trials) || !study.trialBindings) fail('Fixed benchmark study policy bindings are invalid.', 'benchmark-study-invalid', 2);
  if (new Set(study.trials.map((trial) => trial.participantId)).size !== study.trials.length || study.trials.some((trial) => !SAFE_ID.test(trial.participantId) || !study.trialBindings[trial.id])) fail('Fixed benchmark participant trial identities are invalid.', 'benchmark-study-invalid', 2);
  return true;
}

function validateResponse(study, response) {
  if (response?.schemaVersion !== 1 || response?.tool !== RESPONSE_TOOL || response?.nonAuthorizing !== true || response.studyId !== study.studyId || response.studyDigest !== study.studyDigest || !SAFE_ID.test(response.raterId)) fail('Fixed benchmark response is invalid or belongs to another study.', 'benchmark-response-invalid', 2);
  if (!Array.isArray(response.responses) || response.responses.length !== study.trials.length) fail('Fixed benchmark response must answer every trial.', 'benchmark-response-incomplete', 2);
  const answer = new Map(), byParticipant = new Map(study.trials.map((trial) => [trial.participantId, trial]));
  for (const item of response.responses) {
    const trial = byParticipant.get(item?.trialId);
    if (!trial || answer.has(trial.id) || !CHOICES.has(item.choice)) fail('Fixed benchmark response has an unknown, duplicate, or invalid answer.', 'benchmark-response-invalid', 2);
    answer.set(trial.id, item.choice);
  }
  return answer;
}

function wilsonLower(wins, total) {
  if (!total) return null;
  const z = 1.959963984540054, p = wins / total, z2 = z * z;
  return formatNumber((p + z2 / (2 * total) - z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / (1 + z2 / total), 8);
}

export function evaluateFixedBenchmark(study, responses) {
  validateFixedBenchmarkStudy(study);
  if (!Array.isArray(responses) || !responses.length) fail('Provide at least one complete fixed benchmark response.', 'benchmark-response-empty', 2);
  const raters = new Set(), answers = [];
  for (const response of responses) {
    const canonical = String(response.raterId).toLowerCase();
    if (raters.has(canonical)) fail('Duplicate case-insensitive benchmark rater.', 'benchmark-rater-duplicate', 2);
    raters.add(canonical); answers.push(validateResponse(study, response));
  }
  const headToHead = {};
  for (const baseline of BASELINES) {
    const trials = study.trials.filter((trial) => study.trialBindings[trial.id].baseline === baseline);
    let wins = 0, losses = 0, ties = 0, cannotJudge = 0;
    const families = new Map(), sourceDecisiveVotes = new Map();
    for (const trial of trials) {
      const binding = study.trialBindings[trial.id];
      for (const answer of answers) {
        const choice = answer.get(trial.id);
        if (choice === 'TIE') { ties += 1; continue; }
        if (choice === 'ABSTAIN') { cannotJudge += 1; continue; }
        const learnedWon = trial.presentation[choice] === binding.learnedCandidateId;
        if (learnedWon) wins += 1; else losses += 1;
        sourceDecisiveVotes.set(binding.sourceSha256, (sourceDecisiveVotes.get(binding.sourceSha256) ?? 0) + 1);
        const family = families.get(binding.familyId) ?? { wins: 0, losses: 0 };
        family[learnedWon ? 'wins' : 'losses'] += 1; families.set(binding.familyId, family);
      }
    }
    const decisive = wins + losses;
    const familyRates = [...families.values()].filter((item) => item.wins + item.losses).map((item) => item.wins / (item.wins + item.losses));
    const distinct = new Set(trials.map((trial) => trial.caseId)).size;
    const totalValueCases = study.cases.filter((item) => item.outputs['learned-v06'].status === 'VALUE' && item.outputs[baseline].status === 'VALUE').length;
    headToHead[`learned-v06__${baseline}`] = {
      distinctOutputCases: distinct, identicalOutputCases: Math.max(0, totalValueCases - distinct),
      sourcesWithAtLeastFiveDecisiveVotes: [...sourceDecisiveVotes.values()].filter((count) => count >= 5).length,
      representedFamilies: families.size,
      decisiveVotes: decisive, learnedWins: wins, learnedLosses: losses, ties, cannotJudge,
      decisiveWinRate: decisive ? formatNumber(wins / decisive, 8) : null,
      wilson95Lower: wilsonLower(wins, decisive),
      familyMacroWinRate: familyRates.length ? formatNumber(familyRates.reduce((sum, value) => sum + value, 0) / familyRates.length, 8) : null,
    };
  }
  const policyStats = Object.fromEntries(POLICIES.map((policy) => {
    const valueCases = study.cases.filter((item) => item.outputs[policy].status === 'VALUE').length;
    return [policy, { valueCases, abstainCases: study.cases.length - valueCases, coverage: formatNumber(valueCases / study.cases.length, 8) }];
  }));
  const failures = study.hazards.filter((hazard) => hazard.learnedOutput.status !== hazard.expectedStatus || hazard.learnedOutput.reasonCode !== hazard.expectedReasonCode).map((hazard) => hazard.caseId);
  const core = {
    schemaVersion: 1, tool: REPORT_TOOL, nonAuthorizing: true,
    benchmark: { benchmarkId: study.benchmarkId, studyDigest: study.studyDigest, holdoutDisjoint: true },
    evidence: {
      raterIdentity: 'pseudonymous-not-credential-verified', completeRaters: raters.size,
      sourceCount: new Set(study.cases.map((item) => item.sourceSha256)).size,
      familyCount: new Set(study.cases.map((item) => item.familyId)).size,
      groupCount: new Set(study.cases.map((item) => `${item.familyId}/${item.groupId}`)).size,
      minimumRatersPerDistinctPair: raters.size,
      tieVotes: Object.values(headToHead).reduce((sum, item) => sum + item.ties, 0),
      cannotJudgeVotes: Object.values(headToHead).reduce((sum, item) => sum + item.cannotJudge, 0),
    },
    fairness: { oneContextPerTrial: true, policyLabelBlind: true, participantIdsOpaque: true, repeatedCandidateLinkability: 'not-mitigated', trainingSourceOverlap: 0, trainingFamilyOverlap: 0, trainingGroupOverlap: 0 },
    policies: policyStats, headToHead,
    safety: { status: failures.length ? 'FAIL' : 'PASS', failures },
    limits: ['panel-members-not-credential-verified', 'preference-is-not-ground-truth', 'does-not-authorize-svg-correction'],
  };
  return { ...core, reportDigest: sha256(JSON.stringify(core)) };
}

export function validateBenchmarkReport(report) {
  if (report?.schemaVersion !== 1 || report?.tool !== REPORT_TOOL || report?.nonAuthorizing !== true) fail('Unsupported or authorizing benchmark report.', 'benchmark-report-invalid', 2);
  if (report.reportDigest !== sha256(JSON.stringify(withoutDigest(report, 'reportDigest')))) fail('Benchmark report was modified after evaluation.', 'benchmark-report-tampered', 2);
  if (report.benchmark?.holdoutDisjoint !== true || report.fairness?.policyLabelBlind !== true || report.fairness?.participantIdsOpaque !== true || report.fairness?.repeatedCandidateLinkability !== 'not-mitigated' || report.fairness?.trainingSourceOverlap !== 0 || report.fairness?.trainingFamilyOverlap !== 0 || report.fairness?.trainingGroupOverlap !== 0) fail('Benchmark report does not prove holdout separation or honest UI-level blinding limits.', 'benchmark-report-invalid', 2);
  for (const key of ['completeRaters', 'sourceCount', 'familyCount', 'groupCount', 'minimumRatersPerDistinctPair', 'tieVotes', 'cannotJudgeVotes']) if (!Number.isInteger(report.evidence?.[key]) || report.evidence[key] < 0) fail('Benchmark report evidence counts are invalid.', 'benchmark-report-invalid', 2);
  if (report.evidence.raterIdentity !== 'pseudonymous-not-credential-verified') fail('Benchmark rater identity claim is invalid.', 'benchmark-report-invalid', 2);
  for (const policy of POLICIES) {
    const stats = report.policies?.[policy];
    if (!Number.isInteger(stats?.valueCases) || stats.valueCases < 0 || !Number.isInteger(stats?.abstainCases) || stats.abstainCases < 0) fail('Benchmark policy coverage counts are invalid.', 'benchmark-report-invalid', 2);
    const total = stats.valueCases + stats.abstainCases;
    if (stats.coverage !== formatNumber(total ? stats.valueCases / total : null, 8)) fail('Benchmark policy coverage is inconsistent.', 'benchmark-report-invalid', 2);
  }
  for (const baseline of BASELINES) {
    const item = report.headToHead?.[`learned-v06__${baseline}`];
    for (const key of ['distinctOutputCases', 'identicalOutputCases', 'sourcesWithAtLeastFiveDecisiveVotes', 'representedFamilies', 'decisiveVotes', 'learnedWins', 'learnedLosses', 'ties', 'cannotJudge']) if (!Number.isInteger(item?.[key]) || item[key] < 0) fail('Benchmark head-to-head counts are invalid.', 'benchmark-report-invalid', 2);
    if (item.decisiveVotes !== item.learnedWins + item.learnedLosses || item.learnedWins + item.learnedLosses + item.ties + item.cannotJudge !== item.distinctOutputCases * report.evidence.completeRaters) fail('Benchmark head-to-head vote totals are inconsistent.', 'benchmark-report-invalid', 2);
    const expectedRate = item.decisiveVotes ? formatNumber(item.learnedWins / item.decisiveVotes, 8) : null;
    if (item.decisiveWinRate !== expectedRate || item.wilson95Lower !== wilsonLower(item.learnedWins, item.decisiveVotes) || (item.familyMacroWinRate !== null && (!Number.isFinite(item.familyMacroWinRate) || item.familyMacroWinRate < 0 || item.familyMacroWinRate > 1))) fail('Benchmark head-to-head metrics are inconsistent.', 'benchmark-report-invalid', 2);
  }
  if (!['PASS', 'FAIL'].includes(report.safety?.status) || !Array.isArray(report.safety?.failures) || (report.safety.status === 'PASS') !== (report.safety.failures.length === 0)) fail('Benchmark hazard status is inconsistent.', 'benchmark-report-invalid', 2);
  if (containsForbiddenKey(report, new Set(['raterId', 'realpath', 'approved', 'verification', 'accuracy']))) fail('Benchmark report contains identity, authorization, or ground-truth claims.', 'benchmark-report-invalid', 2);
  return true;
}

export function checkBenchmarkPromotion(report) {
  validateBenchmarkReport(report);
  const failed = [], passed = [];
  const evidenceCodes = new Set();
  const requireGate = (condition, code) => (condition ? passed : failed).push(code);
  const evidenceGate = (condition, code) => { evidenceCodes.add(code); requireGate(condition, code); };
  evidenceGate(report.evidence.sourceCount >= 40, 'at-least-40-holdout-sources');
  evidenceGate(report.evidence.familyCount >= 6, 'at-least-6-holdout-families');
  evidenceGate(report.evidence.groupCount >= 8, 'at-least-8-holdout-groups');
  evidenceGate(report.evidence.minimumRatersPerDistinctPair >= 5, 'at-least-5-raters-per-distinct-pair');
  for (const baseline of BASELINES) {
    const item = report.headToHead[`learned-v06__${baseline}`];
    evidenceGate(item?.decisiveVotes >= 120, `${baseline}-at-least-120-decisive-votes`);
    evidenceGate(item?.sourcesWithAtLeastFiveDecisiveVotes >= 40, `${baseline}-at-least-40-sources-with-5-decisive-votes`);
    evidenceGate(item?.representedFamilies >= 5, `${baseline}-at-least-5-families`);
    requireGate(item?.decisiveWinRate > 0.5, `${baseline}-win-rate-over-half`);
    requireGate(item?.wilson95Lower > 0.5, `${baseline}-wilson-lower-over-half`);
    requireGate(item?.familyMacroWinRate > 0.5, `${baseline}-family-macro-over-half`);
  }
  requireGate(report.policies['learned-v06']?.coverage >= report.policies['ensemble-v05']?.coverage, 'learned-coverage-not-below-ensemble');
  requireGate(report.safety?.status === 'PASS' && report.safety.failures?.length === 0, 'hazard-suite-pass');
  const status = failed.some((code) => evidenceCodes.has(code)) ? 'UNDERPOWERED' : failed.length ? 'BASELINE_NOT_BEATEN' : 'PROMISING_RESEARCH_ONLY';
  const core = {
    schemaVersion: 1, tool: GATE_TOOL, nonAuthorizing: true, gateVersion: 'optiai-fixed-v1', reportDigest: report.reportDigest,
    status, recommendedForCalibration: status === 'PROMISING_RESEARCH_ONLY', passed, failed,
    limits: ['panel-members-not-credential-verified', 'preference-is-not-ground-truth', 'does-not-authorize-svg-correction', 'benchmark-must-retire-if-used-for-training'],
  };
  return { ...core, gateDigest: sha256(JSON.stringify(core)) };
}

export function validateBenchmarkGate(gate) {
  if (gate?.schemaVersion !== 1 || gate?.tool !== GATE_TOOL || gate?.nonAuthorizing !== true || !['INVALID', 'UNDERPOWERED', 'BASELINE_NOT_BEATEN', 'PROMISING_RESEARCH_ONLY'].includes(gate.status)) fail('Unsupported or authorizing benchmark gate.', 'benchmark-gate-invalid', 2);
  if (gate.gateDigest !== sha256(JSON.stringify(withoutDigest(gate, 'gateDigest'))) || gate.recommendedForCalibration !== (gate.status === 'PROMISING_RESEARCH_ONLY')) fail('Benchmark gate is inconsistent or tampered.', 'benchmark-gate-tampered', 2);
  return true;
}

export function benchmarkTrainingSummary(dataset, model) {
  if (model?.dataset?.digest !== dataset?.datasetDigest) fail('Benchmark model is not bound to the supplied training dataset.', 'benchmark-training-binding-mismatch', 2);
  return {
    datasetDigest: dataset.datasetDigest, modelDigest: model.modelDigest,
    sourceSha256s: [...new Set(dataset.pairs.map((item) => item.sourceSha256))].sort(),
    familyIds: [...new Set(dataset.pairs.map((item) => item.familyId))].sort(),
    groupIds: [...new Set(dataset.pairs.map((item) => `${item.familyId}/${item.groupId}`))].sort(),
  };
}

export function renderFixedBenchmarkHtml(study, images) {
  validateFixedBenchmarkStudy(study);
  for (const trial of study.trials) for (const side of ['A', 'B']) if (!images?.[trial.presentation[side]]) fail('Fixed benchmark HTML is missing a bound candidate image.', 'benchmark-image-missing', 2);
  const participantImages = {}, trials = study.trials.map((trial, index) => {
    const presentation = {};
    for (const side of ['A', 'B']) {
      const opaqueId = `i-${index + 1}-${side.toLowerCase()}`;
      participantImages[opaqueId] = images[trial.presentation[side]];
      presentation[side] = opaqueId;
    }
    return { id: trial.participantId, axis: trial.axis, condition: trial.condition, presentation };
  });
  const safe = { studyId: study.studyId, studyDigest: study.studyDigest, trials, images: participantImages };
  const payload = Buffer.from(JSON.stringify(safe)).toString('base64');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OptiAI Fixed Blind Benchmark</title><style>:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui;background:#0b0e13;color:#f7f9fc}*{box-sizing:border-box}body{margin:0;padding:30px 18px;min-height:100vh;background:radial-gradient(circle at top,#202b42,#0b0e13 55%)}main{max-width:840px;margin:auto}.eyebrow{color:#8ca8d7;font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}h1{font-size:clamp(32px,6vw,58px);letter-spacing:-.045em;margin:10px 0}.lede,.meta{color:#9eacc3}.notice{border:1px solid #34435d;background:#121925;padding:14px 16px;border-radius:14px;margin:20px 0}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:24px 0}.option{border:1px solid #2c3950;border-radius:20px;background:#121925;padding:18px;text-align:center}.stage{height:220px;border-radius:14px;display:grid;place-items:center;margin-top:14px}.choices{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.choices button,.export{border:1px solid #34425a;background:#172033;color:#eef4ff;border-radius:12px;padding:14px;font:inherit;font-weight:750;cursor:pointer}.bar{height:6px;background:#202b3c;border-radius:8px;overflow:hidden}.bar div{height:100%;background:#83a9ff}.meta{display:flex;justify-content:space-between;margin-top:10px}.rater{display:grid;gap:8px;margin-top:24px}.rater input{background:#101722;border:1px solid #34425a;color:#fff;border-radius:10px;padding:12px}.export{width:100%;margin-top:20px;background:#eef3ff;color:#111827}.export:disabled{opacity:.35}@media(max-width:640px){.pair{grid-template-columns:1fr}.choices{grid-template-columns:1fr 1fr}}</style></head><body><main><div class="eyebrow">OptiAI · Fixed Blind Benchmark</div><h1>Which feels better centered?</h1><p class="lede">One source, axis, size, theme, and context per question. Policy names and correction values are hidden.</p><div class="notice"><strong>Research only.</strong> Panel preference is not ground truth and cannot authorize a correction.</div><div class="bar"><div id="bar"></div></div><div class="meta"><span id="progress"></span><span id="condition"></span></div><section class="pair"><article class="option"><h2>A</h2><div class="stage" id="stageA"><img id="imageA" alt=""></div></article><article class="option"><h2>B</h2><div class="stage" id="stageB"><img id="imageB" alt=""></div></article></section><div class="choices"><button data-choice="A">A is better</button><button data-choice="B">B is better</button><button data-choice="TIE">Tie</button><button data-choice="ABSTAIN">Cannot judge</button></div><label class="rater"><span>Pseudonymous rater ID</span><input id="rater" maxlength="64" placeholder="panel-01"></label><button class="export" id="export" disabled>Export complete response</button></main><script>(()=>{'use strict';const p=JSON.parse(atob('${payload}')),answers=[],q=id=>document.getElementById(id);let index=0,locked=false;function render(){const t=p.trials[index];q('progress').textContent=(index+1)+' of '+p.trials.length;q('condition').textContent=t.condition.context+' · '+t.condition.theme+' · '+t.condition.size+'px · '+t.axis.toUpperCase();q('bar').style.width=(index/p.trials.length*100)+'%';for(const side of ['A','B']){const image=p.images[t.presentation[side]];q('image'+side).src=image.dataUrl;q('image'+side).width=t.condition.size;q('image'+side).height=t.condition.size;q('stage'+side).style.background=image.background}requestAnimationFrame(()=>{locked=false})}document.querySelector('.choices').onclick=e=>{const choice=e.target.dataset.choice;if(locked||!choice)return;locked=true;answers.push({trialId:p.trials[index].id,choice});index+=1;if(index===p.trials.length){q('progress').textContent='Complete';q('bar').style.width='100%';q('export').disabled=false}else render()};q('export').onclick=()=>{const raterId=q('rater').value.trim();if(!/^[A-Za-z0-9._-]{1,64}$/.test(raterId)){alert('Use a safe pseudonymous ID.');return}const data={schemaVersion:1,tool:'${RESPONSE_TOOL}',nonAuthorizing:true,studyId:p.studyId,studyDigest:p.studyDigest,raterId,responses:answers},blob=new Blob([JSON.stringify(data,null,2)+'\\n'],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='optiai-benchmark-response-'+p.studyId.slice(0,8)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)};render()})();</script></body></html>\n`;
}

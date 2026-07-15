import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { loadSvg, sha256 } from '../scripts/lib/svg-document.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(root, 'tests', 'fixtures');
const script = (name) => join(root, 'scripts', name);
const temp = () => mkdtempSync(join(tmpdir(), 'optiai-test-'));
const run = (name, args) => spawnSync(process.execPath, [script(name), ...args], { cwd: root, encoding: 'utf8' });
const runWithEnv = (name, args, env) => spawnSync(process.execPath, [script(name), ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const containsKey = (value, key) => value && typeof value === 'object'
  && (Object.prototype.hasOwnProperty.call(value, key) || Object.values(value).some((item) => containsKey(item, key)));

function analyze(fixture, extra = []) {
  const dir = temp();
  const audit = join(dir, 'audit.json');
  const result = run('analyze-svg.mjs', [join(fixtures, fixture), '--sizes', '16,24', '--output', audit, ...extra]);
  return { dir, audit, result, report: existsSync(audit) ? json(audit) : null };
}

function approvedVerification(source, audit, dir, dx, dy) {
  const comparison = join(dir, `comparison-${String(dx).replace('.', '_')}-${String(dy).replace('.', '_')}.svg`);
  const rendered = run('render-comparison.mjs', [source, '--analysis', audit, '--dx-percent', String(dx), '--dy-percent', String(dy), '--output', comparison]);
  assert.equal(rendered.status, 0, rendered.stderr);
  const verification = join(dir, `verification-${String(dx).replace('.', '_')}-${String(dy).replace('.', '_')}.json`);
  const verified = run('verify-export.mjs', [source, '--analysis', audit, '--dx-percent', String(dx), '--dy-percent', String(dy), '--approve', '--comparison', comparison, '--output', verification]);
  return { comparison, verification, verified };
}

function preferenceStudy(fixture = 'play.svg', extra = []) {
  const analyzed = analyze(fixture);
  const source = join(fixtures, fixture);
  const study = join(analyzed.dir, 'preference-study.json');
  const html = join(analyzed.dir, 'preference-study.html');
  const result = run('create-preference-lab.mjs', [source, '--analysis', analyzed.audit, '--seed', 'test-seed', '--radius-percent', '2', '--step-percent', '1', '--study-output', study, '--output', html, ...extra]);
  return { ...analyzed, source, study, html, studyReport: existsSync(study) ? json(study) : null, studyResult: result };
}

test('security: rejects active content and does not expand entities', () => {
  const { result, report } = analyze('malicious.svg');
  assert.equal(result.status, 2);
  assert.equal(report.security.status, 'blocked');
  assert.ok(report.security.issues.some((issue) => issue.code === 'unsafe-doctype'));
  assert.doesNotMatch(JSON.stringify(report) + result.stderr, /root:.*:0:0/);
});

test('security: preserves safe local gradients', () => {
  const { result, report } = analyze('gradient.svg');
  assert.equal(result.status, 0);
  assert.equal(report.security.status, 'safe');
});

test('security: blocks script, event attributes, and remote references', () => {
  const active = analyze('active.svg');
  assert.equal(active.result.status, 2);
  assert.ok(active.report.security.issues.some((issue) => issue.code === 'unsafe-element-script'));
  assert.ok(active.report.security.issues.some((issue) => issue.code === 'unsafe-event-attribute'));
  const external = analyze('external.svg');
  assert.equal(external.result.status, 2);
  assert.ok(external.report.security.issues.some((issue) => issue.code === 'external-resource'));
});

test('security: blocks XML stylesheet instructions and CSS escape URLs', () => {
  for (const fixture of ['processing-instruction.svg', 'css-escape.svg']) {
    const { result, report } = analyze(fixture);
    assert.equal(result.status, 2, `${fixture} should be blocked`);
    assert.equal(report.security.status, 'blocked');
  }
});

test('audit v2 binds exact source bytes and records painted bounds', () => {
  const { result, report } = analyze('centered.svg');
  assert.equal(result.status, 0);
  assert.equal(report.schemaVersion, 2);
  assert.match(report.source.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.measurements.reference.paintedBounds, { x: 4, y: 6, width: 16, height: 12, maxX: 20, maxY: 18 });
  assert.deepEqual(report.measurements.reference.sideBearings, { left: 4, right: 4, top: 6, bottom: 6 });
  assert.equal(containsKey(report, 'confidence'), false);
});

test('painted bounds ignore fully transparent filler geometry', () => {
  const { result, report } = analyze('transparent.svg');
  assert.equal(result.status, 0);
  assert.deepEqual(report.measurements.reference.paintedBounds, { x: 9, y: 9, width: 6, height: 6, maxX: 15, maxY: 15 });
  assert.deepEqual(report.measurements.reference.sideBearings, { left: 9, right: 9, top: 9, bottom: 9 });
});

test('decision: abstains when malformed bounds precede optical correction', () => {
  const { result, report } = analyze('left-dot.svg');
  assert.equal(result.status, 2);
  assert.equal(report.decision.status, 'ABSTAIN');
  assert.ok(report.decision.reasonCodes.includes('fix-svg-bounds-first'));
  assert.equal(report.recommendation, null);
});

test('decision: empty artwork explicitly abstains', () => {
  const { result, report } = analyze('empty.svg');
  assert.equal(result.status, 2);
  assert.equal(report.decision.status, 'ABSTAIN');
  assert.ok(report.decision.reasonCodes.includes('no-painted-content'));
});

test('decision: detached components and symmetric off-center bounds abstain', () => {
  const detached = analyze('detached.svg');
  assert.equal(detached.result.status, 2);
  assert.ok(detached.report.decision.reasonCodes.includes('semantic-weight-ambiguous'));
  const offCenter = analyze('off-center-circle.svg');
  assert.equal(offCenter.result.status, 2);
  assert.ok(offCenter.report.decision.reasonCodes.includes('fix-svg-bounds-first'));
});

test('ensemble engine records deterministic multi-signal evidence for balanced artwork', () => {
  const first = analyze('centered.svg', ['--engine', 'ensemble']);
  const second = analyze('centered.svg', ['--engine', 'ensemble']);
  assert.equal(first.result.status, 0, first.result.stderr);
  assert.equal(first.report.engine.model, 'multi-signal-raster-v1');
  assert.equal(first.report.decision.status, 'NO_CHANGE');
  assert.deepEqual(first.report.measurements.reference.signals, second.report.measurements.reference.signals);
  assert.equal(first.report.derivedSha256, second.report.derivedSha256);
  assert.ok(first.report.measurements.reference.signals.edge.centroid);
  assert.ok(first.report.measurements.reference.signals.convexHull.centroid);
  assert.ok(first.report.measurements.reference.signals.symmetry.axis);
  assert.equal(first.report.recommendation.evidence.signalAgreement.band, 'strong');
  assert.equal(containsKey(first.report, 'confidence'), false);
});

test('ensemble audit bytes are deterministic across locale and timezone', () => {
  const dir = temp();
  const source = join(fixtures, 'play.svg');
  const first = join(dir, 'first.json');
  const second = join(dir, 'second.json');
  const args = [source, '--engine', 'ensemble', '--sizes', '16,24,32'];
  assert.equal(runWithEnv('analyze-svg.mjs', [...args, '--output', first], { LANG: 'C', TZ: 'UTC' }).status, 0);
  assert.equal(runWithEnv('analyze-svg.mjs', [...args, '--output', second], { LANG: 'en_US.UTF-8', TZ: 'America/New_York' }).status, 0);
  assert.equal(readFileSync(first, 'utf8'), readFileSync(second, 'utf8'));
});

test('ensemble engine preserves play-axis symmetry and exposes per-size evidence', () => {
  const { result, report } = analyze('play.svg', ['--engine', 'ensemble']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.decision.status, 'REVIEW');
  assert.ok(report.recommendation.dxPercent > 0);
  assert.ok(Math.abs(report.recommendation.dyPercent) < 0.1);
  assert.ok(report.measurements.bySize.every((measurement) => measurement.signals));
  assert.ok(report.recommendation.evidence.signalAgreement.axes.x.signalCount >= 3);
  assert.ok(report.recommendation.evidence.signalAgreement.axes.y.signalCount >= 3);
});

test('ensemble engine abstains when plausible perceptual signals materially disagree', () => {
  const { result, report } = analyze('signal-disagreement.svg', ['--engine', 'ensemble']);
  assert.equal(result.status, 2);
  assert.equal(report.decision.status, 'ABSTAIN');
  assert.ok(report.decision.reasonCodes.includes('perceptual-signals-disagree'));
  assert.equal(report.decision.evidence.signalAgreement.band, 'conflict');
  assert.ok(report.decision.evidence.signalAgreement.axes.x.values.length >= 3);
  assert.equal(report.recommendation, null);
});

test('centroid engine remains byte-compatible in behavior and ensemble keeps safety gates first', () => {
  const centroid = analyze('play.svg', ['--engine', 'centroid']);
  assert.equal(centroid.result.status, 0, centroid.result.stderr);
  assert.equal(centroid.report.engine.model, 'alpha-centroid-v1');
  assert.equal(centroid.report.recommendation.dxPercent, 1.38955);
  assert.equal(centroid.report.recommendation.dyPercent, -0.000188);
  assert.equal(centroid.report.measurements.reference.signals, undefined);

  for (const [fixture, reason] of [
    ['left-dot.svg', 'fix-svg-bounds-first'],
    ['detached.svg', 'semantic-weight-ambiguous'],
    ['empty.svg', 'no-painted-content'],
  ]) {
    const analyzed = analyze(fixture, ['--engine', 'ensemble']);
    assert.equal(analyzed.result.status, 2, fixture);
    assert.equal(analyzed.report.decision.status, 'ABSTAIN');
    assert.ok(analyzed.report.decision.reasonCodes.includes(reason));
  }
});

test('ensemble evidence is source-bound, tamper-evident, and compatible with guarded apply', () => {
  const { dir, audit, report } = analyze('play.svg', ['--engine', 'ensemble']);
  const source = join(fixtures, 'play.svg');
  const approved = approvedVerification(source, audit, dir, 1.3, 0);
  assert.equal(approved.verified.status, 0, approved.verified.stderr);
  const output = join(dir, 'play.ensemble.svg');
  const applied = run('apply-correction.mjs', [source, '--analysis', audit, '--comparison', approved.comparison, '--verification', approved.verification, '--confirm-reviewed', '--output', output]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(existsSync(output), true);
  assert.match(json(approved.verification).candidate.sha256, /^[a-f0-9]{64}$/);

  report.measurements.reference.signals.edge.centroid.x += 1;
  writeFileSync(audit, `${JSON.stringify(report, null, 2)}\n`);
  const rejected = run('render-comparison.mjs', [source, '--analysis', audit, '--output', join(dir, 'tampered.svg')]);
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /audit decision or measurements were modified/i);
});

test('binding: render and verify reject a changed source', () => {
  const { dir, audit, result } = analyze('play.svg');
  assert.equal(result.status, 0);
  const changed = join(dir, 'changed.svg');
  copyFileSync(join(fixtures, 'play.svg'), changed);
  writeFileSync(changed, readFileSync(changed, 'utf8') + '\n');
  const comparison = join(dir, 'comparison.svg');
  const rendered = run('render-comparison.mjs', [changed, '--analysis', audit, '--output', comparison]);
  assert.equal(rendered.status, 2);
  assert.equal(existsSync(comparison), false);
});

test('verification: catches clipping from reviewed override and emits no candidate pass', () => {
  const { dir, audit } = analyze('full-bleed.svg');
  const verification = join(dir, 'verification.json');
  const result = run('verify-export.mjs', [join(fixtures, 'full-bleed.svg'), '--analysis', audit, '--dx-percent', '10', '--dy-percent', '0', '--output', verification]);
  assert.equal(result.status, 2);
  const report = json(verification);
  assert.equal(report.status, 'FAIL');
  assert.ok(report.issues.some((issue) => issue.code === 'post-correction-clipping'));
});

test('reviewed candidate: safe verification gates deterministic apply', () => {
  const { dir, audit, report } = analyze('play.svg');
  assert.equal(report.decision.status, 'REVIEW');
  const { comparison, verification, verified } = approvedVerification(join(fixtures, 'play.svg'), audit, dir, 1, 0);
  assert.equal(verified.status, 0, verified.stderr);
  const output = join(dir, 'play.corrected.svg');
  const applied = run('apply-correction.mjs', [join(fixtures, 'play.svg'), '--analysis', audit, '--comparison', comparison, '--verification', verification, '--confirm-reviewed', '--output', output]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(existsSync(output), true);
  assert.equal(json(verification).candidate.sha256.length, 64);
});

test('apply: refuses same-path output and preserves source bytes', () => {
  const { dir, audit } = analyze('play.svg');
  const source = join(dir, 'play.svg');
  copyFileSync(join(fixtures, 'play.svg'), source);
  const boundAudit = join(dir, 'bound-audit.json');
  const rebound = run('analyze-svg.mjs', [source, '--output', boundAudit]);
  assert.equal(rebound.status, 0);
  const { comparison, verification, verified } = approvedVerification(source, boundAudit, dir, 1, 0);
  assert.equal(verified.status, 0);
  const before = readFileSync(source, 'utf8');
  const result = run('apply-correction.mjs', [source, '--analysis', boundAudit, '--comparison', comparison, '--verification', verification, '--confirm-reviewed', '--output', source]);
  assert.equal(result.status, 2);
  assert.equal(readFileSync(source, 'utf8'), before);
  assert.ok(audit);
});

test('apply: in-place writes a unique backup atomically', () => {
  const dir = temp();
  const source = join(dir, 'play.svg');
  copyFileSync(join(fixtures, 'play.svg'), source);
  const audit = join(dir, 'audit.json');
  assert.equal(run('analyze-svg.mjs', [source, '--output', audit]).status, 0);
  const { comparison, verification, verified } = approvedVerification(source, audit, dir, 1, 0);
  assert.equal(verified.status, 0);
  const original = readFileSync(source, 'utf8');
  const originalMode = statSync(source).mode & 0o777;
  writeFileSync(`${source}.bak`, 'keep me');
  const result = run('apply-correction.mjs', [source, '--analysis', audit, '--comparison', comparison, '--verification', verification, '--confirm-reviewed', '--in-place', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(`${source}.bak`, 'utf8'), 'keep me');
  assert.equal(readFileSync(`${source}.bak.1`, 'utf8'), original);
  assert.notEqual(readFileSync(source, 'utf8'), original);
  assert.equal(statSync(source).mode & 0o777, originalMode);
});

test('comparison embeds raster evidence and never copies source markup', () => {
  const { dir, audit, result } = analyze('play.svg');
  assert.equal(result.status, 0);
  const output = join(dir, 'comparison.svg');
  assert.equal(run('render-comparison.mjs', [join(fixtures, 'play.svg'), '--analysis', audit, '--output', output]).status, 0);
  const comparison = readFileSync(output, 'utf8');
  assert.match(comparison, /data:image\/png;base64,/);
  assert.match(comparison, /OptiAI candidate comparison|CANDIDATE/);
  assert.doesNotMatch(comparison, /REVIEWED/);
  assert.doesNotMatch(comparison, /M8 5L19 12L8 19Z|<script\b|onload\s*=/i);
  assert.doesNotMatch(comparison, /confidence/i);
});

test('apply rejects a forged correction lineage before writing output', () => {
  const dir = temp();
  const source = join(dir, 'full.svg');
  copyFileSync(join(fixtures, 'full-bleed.svg'), source);
  const audit = join(dir, 'audit.json');
  assert.equal(run('analyze-svg.mjs', [source, '--output', audit]).status, 0);
  const comparison = join(dir, 'comparison.svg');
  assert.equal(run('render-comparison.mjs', [source, '--analysis', audit, '--dx-percent', '1', '--dy-percent', '0', '--output', comparison]).status, 0);
  const verification = join(dir, 'failed-verification.json');
  assert.equal(run('verify-export.mjs', [source, '--analysis', audit, '--dx-percent', '1', '--dy-percent', '0', '--approve', '--comparison', comparison, '--output', verification]).status, 2);
  const forged = json(verification);
  forged.status = 'PASS';
  forged.approved = true;
  forged.review.approved = true;
  forged.reviewDigest = sha256(JSON.stringify(forged.review));
  const auditDocumentSha256 = sha256(JSON.stringify(json(audit)));
  forged.correctionDigest = sha256(JSON.stringify({ sourceSha256: loadSvg(source).sha256, auditDocumentSha256, reviewDigest: forged.reviewDigest, correction: forged.correction, candidateSha256: forged.candidate.sha256 }));
  writeFileSync(verification, JSON.stringify(forged));
  const output = join(dir, 'should-not-exist.svg');
  const applied = run('apply-correction.mjs', [source, '--analysis', audit, '--comparison', comparison, '--verification', verification, '--confirm-reviewed', '--output', output]);
  assert.equal(applied.status, 2);
  assert.match(applied.stderr, /postflight detected clipping/i);
  assert.equal(existsSync(output), false);
});

test('all report commands refuse to overwrite their SVG input', () => {
  const dir = temp();
  const source = join(dir, 'play.svg');
  copyFileSync(join(fixtures, 'play.svg'), source);
  const before = readFileSync(source, 'utf8');
  const result = run('analyze-svg.mjs', [source, '--output', source]);
  assert.equal(result.status, 2);
  assert.equal(readFileSync(source, 'utf8'), before);
  copyFileSync(join(fixtures, 'play.svg'), source);
  const audit = join(dir, 'audit.json');
  assert.equal(run('analyze-svg.mjs', [source, '--output', audit]).status, 0);
  const render = run('render-comparison.mjs', [source, '--analysis', audit, '--output', source]);
  assert.equal(render.status, 2);
  assert.equal(readFileSync(source, 'utf8'), before);
  const verify = run('verify-export.mjs', [source, '--analysis', audit, '--output', source]);
  assert.equal(verify.status, 2);
  assert.equal(readFileSync(source, 'utf8'), before);
});

test('sanitizer rejects excessive depth without stack overflow', () => {
  const dir = temp();
  const source = join(dir, 'deep.svg');
  writeFileSync(source, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${'<g>'.repeat(500)}<rect width="1" height="1"/>${'</g>'.repeat(500)}</svg>`);
  const audit = join(dir, 'audit.json');
  const result = run('analyze-svg.mjs', [source, '--output', audit]);
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stderr, /Maximum call stack/i);
  assert.equal(json(audit).security.status, 'blocked');
});

test('CLI rejects unknown options and unbounded reviewed corrections', () => {
  const { dir, audit } = analyze('centered.svg');
  const typo = run('verify-export.mjs', [join(fixtures, 'centered.svg'), '--analysis', audit, '--dx-percnet', '99', '--approve', '--output', join(dir, 'typo.json')]);
  assert.equal(typo.status, 1);
  const largePath = join(dir, 'large.json');
  const large = run('verify-export.mjs', [join(fixtures, 'centered.svg'), '--analysis', audit, '--dx-percent', '10', '--dy-percent', '0', '--approve', '--output', largePath]);
  assert.equal(large.status, 2);
  assert.ok(json(largePath).issues.some((issue) => issue.code === 'correction-out-of-range'));
});

test('apply requires the bound audit and rejects verification-only authorization', () => {
  const { dir, audit } = analyze('play.svg');
  const { verification, verified } = approvedVerification(join(fixtures, 'play.svg'), audit, dir, 1, 0);
  assert.equal(verified.status, 0);
  const output = join(dir, 'forged.svg');
  const result = run('apply-correction.mjs', [join(fixtures, 'play.svg'), '--verification', verification, '--output', output]);
  assert.equal(result.status, 1);
  assert.equal(existsSync(output), false);
});

test('apply rejects REVIEW_REQUIRED artifacts whose top-level approval fields were flipped', () => {
  const { dir, audit } = analyze('play.svg');
  const source = join(fixtures, 'play.svg');
  const comparison = join(dir, 'comparison.svg');
  assert.equal(run('render-comparison.mjs', [source, '--analysis', audit, '--dx-percent', '1', '--dy-percent', '0', '--output', comparison]).status, 0);
  const verification = join(dir, 'review-required.json');
  assert.equal(run('verify-export.mjs', [source, '--analysis', audit, '--dx-percent', '1', '--dy-percent', '0', '--output', verification]).status, 2);
  const modified = json(verification);
  modified.status = 'PASS';
  modified.approved = true;
  writeFileSync(verification, JSON.stringify(modified));
  const output = join(dir, 'must-not-exist.svg');
  const result = run('apply-correction.mjs', [source, '--analysis', audit, '--comparison', comparison, '--verification', verification, '--confirm-reviewed', '--output', output]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /review lineage is incomplete/i);
  assert.equal(existsSync(output), false);
});

test('explicit false boolean flags never authorize verification or apply', () => {
  const { dir, audit } = analyze('play.svg');
  const source = join(fixtures, 'play.svg');
  const comparison = join(dir, 'comparison.svg');
  assert.equal(run('render-comparison.mjs', [source, '--analysis', audit, '--dx-percent', '1', '--dy-percent', '0', '--output', comparison]).status, 0);
  const deniedVerification = join(dir, 'denied.json');
  const denied = run('verify-export.mjs', [source, '--analysis', audit, '--dx-percent', '1', '--dy-percent', '0', '--approve=false', '--comparison', comparison, '--output', deniedVerification]);
  assert.equal(denied.status, 2);
  assert.equal(json(deniedVerification).status, 'REVIEW_REQUIRED');
  const { verification, verified } = approvedVerification(source, audit, dir, 1, 0);
  assert.equal(verified.status, 0);
  const output = join(dir, 'must-not-exist.svg');
  const applied = run('apply-correction.mjs', [source, '--analysis', audit, '--comparison', comparison, '--verification', verification, '--confirm-reviewed=false', '--output', output]);
  assert.equal(applied.status, 1);
  assert.equal(existsSync(output), false);
});

test('preference lab: creates a deterministic blinded study without source markup', () => {
  const first = preferenceStudy();
  assert.equal(first.studyResult.status, 0, first.studyResult.stderr);
  assert.equal(first.studyReport.schemaVersion, 1);
  assert.equal(first.studyReport.tool, 'OptiAI Preference Lab');
  assert.match(first.studyReport.studyId, /^[a-f0-9]{64}$/);
  assert.ok(first.studyReport.trials.length >= 4);
  assert.ok(first.studyReport.candidates.length >= 4);
  assert.ok(first.studyReport.trials.every((trial) => trial.presentation?.A && trial.presentation?.B && !Object.hasOwn(trial, 'winner')));
  assert.ok(first.studyReport.candidates.every((candidate) => Math.abs(candidate.correction.dxPercent) <= 5 && Math.abs(candidate.correction.dyPercent) <= 5));
  assert.ok(first.studyReport.candidates.every((candidate) => candidate.clipping.clipped === false));
  assert.doesNotMatch(readFileSync(first.study, 'utf8'), /data:image|M8 5L19 12L8 19Z/);
  const html = readFileSync(first.html, 'utf8');
  const encodedPayload = html.match(/atob\('([^']+)'\)/)?.[1];
  assert.ok(encodedPayload);
  assert.match(Buffer.from(encodedPayload, 'base64').toString('utf8'), /data:image\/png;base64,/);
  assert.doesNotMatch(html, /M8 5L19 12L8 19Z|<script\s+src=|play\.svg|dxPercent|dyPercent|candidateSha256/i);

  const secondStudy = join(first.dir, 'second-study.json');
  const secondHtml = join(first.dir, 'second-study.html');
  const second = run('create-preference-lab.mjs', [first.source, '--analysis', first.audit, '--seed', 'test-seed', '--radius-percent', '2', '--step-percent', '1', '--study-output', secondStudy, '--output', secondHtml]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(secondStudy, 'utf8'), readFileSync(first.study, 'utf8'));
});

test('preference lab: keeps each trial on one independent axis and binds raster evidence', () => {
  const { studyResult, studyReport } = preferenceStudy();
  assert.equal(studyResult.status, 0, studyResult.stderr);
  const candidates = new Map(studyReport.candidates.map((candidate) => [candidate.id, candidate]));
  for (const trial of studyReport.trials) {
    const a = candidates.get(trial.presentation.A);
    const b = candidates.get(trial.presentation.B);
    assert.ok(a && b);
    if (trial.axis === 'x') {
      assert.equal(a.correction.dyPercent, 0);
      assert.equal(b.correction.dyPercent, 0);
    } else {
      assert.equal(a.correction.dxPercent, 0);
      assert.equal(b.correction.dxPercent, 0);
    }
    assert.ok(a.rasters.every((raster) => /^[a-f0-9]{64}$/.test(raster.sha256)));
    assert.ok(b.rasters.every((raster) => /^[a-f0-9]{64}$/.test(raster.sha256)));
  }
});

test('preference lab: exports complete responses as deterministic training JSONL', () => {
  const { dir, study, studyResult, studyReport } = preferenceStudy();
  assert.equal(studyResult.status, 0, studyResult.stderr);
  const response = join(dir, 'expert-01.json');
  writeFileSync(response, JSON.stringify({
    schemaVersion: 1,
    tool: 'OptiAI Preference Response',
    studyId: studyReport.studyId,
    studyDigest: studyReport.studyDigest,
    raterId: 'expert-01',
    responses: studyReport.trials.map((trial, index) => ({ trialId: trial.id, choice: ['A', 'B', 'TIE', 'ABSTAIN'][index % 4] })),
  }));
  const output = join(dir, 'preferences.jsonl');
  const exported = run('export-preferences.mjs', [join(fixtures, 'play.svg'), '--analysis', join(dir, 'audit.json'), '--study', study, response, '--output', output]);
  assert.equal(exported.status, 0, exported.stderr);
  const lines = readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, studyReport.trials.length);
  assert.ok(lines.every((line) => line.schemaVersion === 2 && line.nonAuthorizing === true));
  assert.ok(lines.every((line) => /^[a-f0-9]{64}$/.test(line.datumDigest) && /^[a-f0-9]{64}$/.test(line.studyDigest)));
  assert.ok(lines.every((line) => Number.isFinite(line.sourceFeatures?.proposalPercent)));
  assert.ok(lines.every((line) => line.studyId === studyReport.studyId && line.raterId === 'expert-01'));
  assert.ok(lines.every((line) => ['A', 'B', 'TIE', 'ABSTAIN'].includes(line.choice)));
  assert.ok(lines.filter((line) => line.choice === 'A' || line.choice === 'B').every((line) => /^[a-f0-9]{64}$/.test(line.preferredCandidateId)));

  const second = join(dir, 'preferences-second.jsonl');
  const reorderedResponse = join(dir, 'expert-01-reordered.json');
  const responseDocument = json(response);
  responseDocument.responses.reverse();
  writeFileSync(reorderedResponse, JSON.stringify(responseDocument));
  assert.equal(run('export-preferences.mjs', [join(fixtures, 'play.svg'), '--analysis', join(dir, 'audit.json'), '--study', study, reorderedResponse, '--output', second]).status, 0);
  assert.equal(readFileSync(second, 'utf8'), readFileSync(output, 'utf8'));

  const caseVariant = join(dir, 'EXPERT-01.json');
  responseDocument.raterId = 'EXPERT-01';
  writeFileSync(caseVariant, JSON.stringify(responseDocument));
  const duplicateOutput = join(dir, 'duplicate-rater.jsonl');
  const duplicate = run('export-preferences.mjs', [join(fixtures, 'play.svg'), '--analysis', join(dir, 'audit.json'), '--study', study, response, caseVariant, '--output', duplicateOutput]);
  assert.equal(duplicate.status, 2);
  assert.equal(existsSync(duplicateOutput), false);
});

test('preference lab: rejects incomplete, duplicate, and unknown responses', () => {
  const { dir, study, studyResult, studyReport } = preferenceStudy();
  assert.equal(studyResult.status, 0, studyResult.stderr);
  const invalidCases = [
    studyReport.trials.slice(0, -1).map((trial) => ({ trialId: trial.id, choice: 'A' })),
    studyReport.trials.map((trial) => ({ trialId: trial.id, choice: 'A' })).concat({ trialId: studyReport.trials[0].id, choice: 'B' }),
    studyReport.trials.map((trial, index) => ({ trialId: index === 0 ? 'unknown' : trial.id, choice: 'A' })),
  ];
  for (const [index, responses] of invalidCases.entries()) {
    const response = join(dir, `invalid-${index}.json`);
    const output = join(dir, `invalid-${index}.jsonl`);
    writeFileSync(response, JSON.stringify({ schemaVersion: 1, tool: 'OptiAI Preference Response', studyId: studyReport.studyId, studyDigest: studyReport.studyDigest, raterId: 'expert-01', responses }));
    const exported = run('export-preferences.mjs', [join(fixtures, 'play.svg'), '--analysis', join(dir, 'audit.json'), '--study', study, response, '--output', output]);
    assert.equal(exported.status, 2);
    assert.equal(existsSync(output), false);
  }
});

test('preference lab: rejects tampered studies and never treats labels as apply approval', () => {
  const { dir, study, studyResult, studyReport } = preferenceStudy();
  assert.equal(studyResult.status, 0, studyResult.stderr);
  const tampered = join(dir, 'tampered-study.json');
  const changed = structuredClone(studyReport);
  changed.candidates[0].correction.dxPercent = 4.9;
  writeFileSync(tampered, JSON.stringify(changed));
  const response = join(dir, 'response.json');
  writeFileSync(response, JSON.stringify({ schemaVersion: 1, tool: 'OptiAI Preference Response', studyId: studyReport.studyId, studyDigest: studyReport.studyDigest, raterId: 'expert-01', responses: studyReport.trials.map((trial) => ({ trialId: trial.id, choice: 'A' })) }));
  const output = join(dir, 'must-not-exist.jsonl');
  const exported = run('export-preferences.mjs', [join(fixtures, 'play.svg'), '--analysis', join(dir, 'audit.json'), '--study', tampered, response, '--output', output]);
  assert.equal(exported.status, 2);
  assert.equal(existsSync(output), false);
  assert.equal(containsKey(studyReport, 'approved'), false);
  assert.equal(containsKey(studyReport, 'verification'), false);
});

test('preference lab: refuses unsafe sources and bounds-repair cases', () => {
  for (const fixture of ['malicious.svg', 'left-dot.svg', 'empty.svg']) {
    const { studyResult, study, html } = preferenceStudy(fixture);
    assert.equal(studyResult.status, 2, `${fixture} should not produce a study`);
    assert.equal(existsSync(study), false);
    assert.equal(existsSync(html), false);
  }
});

test('preference lab: rejects an unbounded candidate grid before rendering', () => {
  const { dir, audit, result } = analyze('play.svg');
  assert.equal(result.status, 0);
  const study = join(dir, 'too-large.json');
  const html = join(dir, 'too-large.html');
  const generated = run('create-preference-lab.mjs', [join(fixtures, 'play.svg'), '--analysis', audit, '--radius-percent', '5', '--step-percent', '0.1', '--study-output', study, '--output', html]);
  assert.equal(generated.status, 1);
  assert.match(generated.stderr, /exceeds 25 candidates or 32 trials/i);
  assert.equal(existsSync(study), false);
  assert.equal(existsSync(html), false);
});

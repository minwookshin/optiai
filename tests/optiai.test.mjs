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

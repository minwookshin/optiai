#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { validateDerivedAudit } from './lib/audit-model.mjs';
import { sha256, buildCandidate, loadSvg, validateAudit } from './lib/svg-document.mjs';
import { clippingIssues } from './lib/raster.mjs';
import { assertKnownArgs, fail, guardOutput, handleCliError, parseArgs, parseCorrection, readJson, writeOutput } from './lib/svg-utils.mjs';

const HELP = `Usage: verify-export.mjs <input.svg> --analysis audit.json [options]

Options:
  --dx-percent NUMBER  Reviewed horizontal correction
  --dy-percent NUMBER  Reviewed vertical correction
  --approve            Record explicit human review of both axes
  --comparison PATH    Bound comparison artifact reviewed before approval
  --reason-x TEXT      Optional horizontal review rationale
  --reason-y TEXT      Optional vertical review rationale
  --output PATH        Write verification JSON
  --help               Show this help
`;

try {
  const args = parseArgs(process.argv.slice(2));
  assertKnownArgs(args, ['help', 'analysis', 'dx-percent', 'dy-percent', 'approve', 'comparison', 'reason-x', 'reason-y', 'output']);
  if (args.help) { process.stdout.write(HELP); process.exit(0); }
  if (!args._[0]) fail('Provide an input SVG.');
  if (!args.analysis || args.analysis === true) fail('Provide --analysis audit.json.');
  const svg = loadSvg(args._[0]);
  guardOutput(svg.realpath, args.output);
  guardOutput(args.analysis, args.output);
  if (args.comparison && args.comparison !== true) guardOutput(args.comparison, args.output);
  const audit = readJson(args.analysis);
  validateAudit(svg, audit);
  validateDerivedAudit(svg, audit);
  if (audit.decision?.status === 'ABSTAIN') fail('The audit abstained; verification is blocked.', 'audit-abstained', 2);
  const correction = parseCorrection(args, audit.recommendation);
  const candidate = buildCandidate(svg, correction);
  const clipping = clippingIssues(svg.sanitized, svg.viewBox, candidate.bytes, candidate.viewBox, audit.targetSizes);
  const issues = [];
  if (clipping.clipped) issues.push({ severity: 'fail', code: 'post-correction-clipping', sides: clipping.sides, message: 'The reviewed correction removes painted content from the viewport.' });
  if (Math.abs(correction.dxPercent) > 5 || Math.abs(correction.dyPercent) > 5) issues.push({ severity: 'fail', code: 'correction-out-of-range', message: 'Reviewed corrections are limited to ±5% per axis; repair bounds or abstain instead.' });
  let comparison = null;
  if (args.approve) {
    if (!args.comparison || args.comparison === true) issues.push({ severity: 'block', code: 'comparison-required', message: 'Approval requires the exact comparison artifact.' });
    else {
      const bytes = readFileSync(String(args.comparison));
      const content = bytes.toString('utf8');
      const bound = content.includes(`data-optiai-source-sha256="${svg.sha256}"`)
        && content.includes(`data-optiai-candidate-sha256="${candidate.sha256}"`)
        && content.includes(`data-optiai-sizes="${audit.targetSizes.join(',')}"`)
        && content.includes('data-optiai-themes="light,dark"');
      comparison = { path: String(args.comparison), sha256: sha256(bytes), byteLength: bytes.length, bound };
      if (!bound) issues.push({ severity: 'fail', code: 'comparison-binding-mismatch', message: 'Comparison artifact does not match this source and candidate.' });
    }
  } else issues.push({ severity: 'block', code: 'review-approval-required', message: 'Pass --approve only after reviewing both axes in the comparison artifact.' });
  const hasFailure = issues.some((issue) => issue.severity === 'fail');
  const hasBlock = issues.some((issue) => issue.severity === 'block');
  const status = hasFailure ? 'FAIL' : hasBlock ? 'REVIEW_REQUIRED' : 'PASS';
  const axisReview = (axis, proposed, final) => ({
    action: Math.abs(final) < 1e-9 ? 'ZERO' : Math.abs(final - proposed) < 1e-9 ? 'ACCEPT_PROPOSAL' : 'OVERRIDE',
    proposedPercent: proposed,
    finalPercent: final,
    reason: args[`reason-${axis}`] ?? (Math.abs(final) < 1e-9 ? 'axis-zeroed-after-visual-review' : Math.abs(final - proposed) < 1e-9 ? 'proposal-accepted-after-visual-review' : 'value-overridden-after-visual-review'),
  });
  const auditDocumentSha256 = sha256(JSON.stringify(audit));
  const review = {
    approved: Boolean(args.approve) && status === 'PASS',
    comparison,
    axes: { x: axisReview('x', audit.recommendation?.dxPercent ?? 0, correction.dxPercent), y: axisReview('y', audit.recommendation?.dyPercent ?? 0, correction.dyPercent) },
  };
  const reviewDigest = sha256(JSON.stringify(review));
  const correctionDigest = sha256(JSON.stringify({ sourceSha256: svg.sha256, auditDocumentSha256, reviewDigest, correction, candidateSha256: candidate.sha256 }));
  const report = {
    schemaVersion: 2,
    tool: 'OptiAI Verification',
    status,
    source: { realpath: svg.realpath, sha256: svg.sha256, byteLength: svg.byteLength, viewBox: svg.viewBox },
    audit: { documentSha256: auditDocumentSha256, derivedSha256: audit.derivedSha256, sourceSha256: audit.source.sha256 },
    approved: review.approved,
    review,
    reviewDigest,
    correction,
    correctionDigest,
    candidate: { sha256: candidate.sha256, viewBox: candidate.viewBox, byteLength: Buffer.byteLength(candidate.bytes) },
    raster: clipping.raster,
    issues,
  };
  writeOutput(args.output, `${JSON.stringify(report, null, 2)}\n`);
  if (status !== 'PASS') process.exitCode = 2;
} catch (error) { handleCliError(error); }

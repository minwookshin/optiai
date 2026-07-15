#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateDerivedAudit } from './lib/audit-model.mjs';
import { buildCandidate, loadSvg, sha256, validateAudit } from './lib/svg-document.mjs';
import { clippingIssues } from './lib/raster.mjs';
import { assertKnownArgs, atomicReplaceWithBackup, fail, handleCliError, parseArgs, readJson, sameFile, writeOutput } from './lib/svg-utils.mjs';

const HELP = `Usage: apply-correction.mjs <input.svg> --analysis audit.json --verification verification.json [options]

Options:
  --comparison PATH       Exact comparison artifact recorded by verification
  --confirm-reviewed      Fresh confirmation that both axes were reviewed
  --output PATH   Write a corrected copy
  --in-place      Replace the source atomically (requires --yes)
  --yes           Confirm in-place replacement
  --no-backup     Explicitly skip the unique backup
  --help          Show this help
`;

try {
  const args = parseArgs(process.argv.slice(2));
  assertKnownArgs(args, ['help', 'analysis', 'verification', 'comparison', 'confirm-reviewed', 'output', 'in-place', 'yes', 'no-backup']);
  if (args.help) { process.stdout.write(HELP); process.exit(0); }
  if (!args._[0]) fail('Provide an input SVG.');
  if (!args.analysis || args.analysis === true) fail('Provide --analysis audit.json.');
  if (!args.verification || args.verification === true) fail('Provide --verification verification.json.');
  if (!args.comparison || args.comparison === true) fail('Provide --comparison comparison.svg.');
  if (!args['confirm-reviewed']) fail('Applying a correction requires --confirm-reviewed.', 'review-confirmation-required');
  if (args['in-place'] && !args.yes) fail('In-place editing requires --yes.', 'confirmation-required');
  if (!args['in-place'] && (!args.output || args.output === true)) fail('Provide --output PATH, or use --in-place --yes.');
  const svg = loadSvg(args._[0]);
  if (svg.security.status !== 'safe') fail('Source is unsafe.', 'unsafe-source', 2);
  const audit = readJson(args.analysis);
  validateAudit(svg, audit);
  validateDerivedAudit(svg, audit);
  if (audit.decision?.status === 'ABSTAIN') fail('The bound audit abstained.', 'audit-abstained', 2);
  const verification = readJson(args.verification);
  if (verification.schemaVersion !== 2 || verification.tool !== 'OptiAI Verification') fail('Unsupported verification schema.', 'verification-schema-unsupported', 2);
  if (verification.status !== 'PASS' || verification.approved !== true) fail('Only an approved PASS verification may be applied.', 'verification-not-pass', 2);
  if (verification.review?.approved !== true || verification.review?.comparison?.bound !== true || !verification.review?.axes?.x || !verification.review?.axes?.y) fail('Verification review lineage is incomplete.', 'approval-lineage-mismatch', 2);
  if (!Number.isFinite(verification.correction?.dxPercent) || !Number.isFinite(verification.correction?.dyPercent)) fail('Verification correction is invalid.', 'invalid-correction', 2);
  if (verification.source.realpath !== svg.realpath || verification.source.sha256 !== svg.sha256 || verification.source.byteLength !== svg.byteLength || verification.source.viewBox?.raw !== svg.viewBox?.raw) {
    fail('Source changed after verification.', 'verification-source-mismatch', 2);
  }
  const auditDocumentSha256 = sha256(JSON.stringify(audit));
  if (verification.audit?.documentSha256 !== auditDocumentSha256 || verification.audit?.derivedSha256 !== audit.derivedSha256) fail('Verification is not bound to the supplied audit.', 'verification-audit-mismatch', 2);
  const candidate = buildCandidate(svg, verification.correction);
  if (candidate.sha256 !== verification.candidate?.sha256 || candidate.viewBox.raw !== verification.candidate?.viewBox?.raw) fail('Candidate bytes do not match the verified candidate.', 'candidate-hash-mismatch', 2);
  const comparisonBytes = readFileSync(String(args.comparison));
  const comparisonContent = comparisonBytes.toString('utf8');
  const comparisonSha256 = sha256(comparisonBytes);
  const comparisonBound = comparisonContent.includes(`data-optiai-source-sha256="${svg.sha256}"`)
    && comparisonContent.includes(`data-optiai-candidate-sha256="${candidate.sha256}"`)
    && comparisonContent.includes(`data-optiai-sizes="${audit.targetSizes.join(',')}"`)
    && comparisonContent.includes('data-optiai-themes="light,dark"');
  if (!comparisonBound || comparisonSha256 !== verification.review.comparison.sha256 || comparisonBytes.length !== verification.review.comparison.byteLength) fail('Comparison artifact does not match the approved review.', 'comparison-lineage-mismatch', 2);
  const reviewDigest = sha256(JSON.stringify(verification.review));
  if (reviewDigest !== verification.reviewDigest) fail('Review lineage digest does not match.', 'approval-lineage-mismatch', 2);
  const correctionDigest = sha256(JSON.stringify({ sourceSha256: svg.sha256, auditDocumentSha256, reviewDigest, correction: verification.correction, candidateSha256: candidate.sha256 }));
  if (verification.correctionDigest !== correctionDigest) fail('Correction lineage digest does not match.', 'correction-digest-mismatch', 2);
  if (Math.abs(verification.correction.dxPercent) > 5 || Math.abs(verification.correction.dyPercent) > 5) fail('Correction exceeds ±5% per axis.', 'correction-out-of-range', 2);
  if (!Array.isArray(verification.raster) || JSON.stringify(verification.raster.map((item) => item.size)) !== JSON.stringify(audit.targetSizes)) fail('Verification raster evidence is missing or invalid.', 'verification-evidence-missing', 2);
  const postflight = clippingIssues(svg.sanitized, svg.viewBox, candidate.bytes, candidate.viewBox, audit.targetSizes);
  if (postflight.clipped) fail(`Fresh postflight detected clipping: ${postflight.sides.join(', ')}.`, 'postflight-clipping', 2);
  if (args['in-place']) atomicReplaceWithBackup(svg.realpath, candidate.bytes, svg.sha256, !args['no-backup']);
  else {
    const output = resolve(String(args.output));
    if (sameFile(svg.realpath, output)) fail('Same-file output requires --in-place --yes.', 'same-file-output-requires-in-place', 2);
    if (sameFile(String(args.analysis), output) || sameFile(String(args.verification), output) || sameFile(String(args.comparison), output)) fail('Output may not overwrite an audit, comparison, or verification artifact.', 'artifact-output-conflict', 2);
    writeOutput(output, candidate.bytes);
  }
} catch (error) { handleCliError(error); }

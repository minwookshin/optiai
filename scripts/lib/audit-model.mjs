import { sha256 } from './svg-document.mjs';
import { measureSvg } from './raster.mjs';
import { fail, formatNumber } from './svg-utils.mjs';

function pixelOffsets(dxPercent, dyPercent, sizes) {
  return sizes.map((size) => ({ size, dx: formatNumber((dxPercent / 100) * size, 4), dy: formatNumber((dyPercent / 100) * size, 4) }));
}

export function evaluateDecision(svg, measurements, engine, context, rtl, sizes) {
  const reasons = [];
  if (!measurements.reference.paintedBounds) reasons.push('no-painted-content');
  if (engine === 'none') reasons.push('no-optical-engine');
  if (context === 'logo') reasons.push('brand-artwork-manual-review');
  if (context === 'icon-text') reasons.push('text-baseline-unverified');
  if (svg.features.masks) reasons.push('mask-geometry-unsupported');
  if (svg.features.filters) reasons.push('filter-geometry-unsupported');
  if (svg.features.text) reasons.push('font-rendering-nondeterministic');
  if (svg.features.hasNonScalingStroke) reasons.push('non-scaling-stroke-unsupported');
  if ((measurements.reference.connectedComponents ?? 0) > 1) reasons.push('semantic-weight-ambiguous');
  const bounds = measurements.reference.paintedBounds;
  if (bounds) {
    const shapeCenterX = bounds.x + bounds.width / 2;
    const shapeCenterY = bounds.y + bounds.height / 2;
    const viewportCenterX = svg.viewBox.x + svg.viewBox.width / 2;
    const viewportCenterY = svg.viewBox.y + svg.viewBox.height / 2;
    const frameOffsetX = Math.abs(shapeCenterX - viewportCenterX) / svg.viewBox.width;
    const frameOffsetY = Math.abs(shapeCenterY - viewportCenterY) / svg.viewBox.height;
    const intrinsicX = measurements.reference.centroid ? Math.abs(measurements.reference.centroid.x - shapeCenterX) / svg.viewBox.width : 0;
    const intrinsicY = measurements.reference.centroid ? Math.abs(measurements.reference.centroid.y - shapeCenterY) / svg.viewBox.height : 0;
    if (frameOffsetX > 0.125 || frameOffsetY > 0.125 || (frameOffsetX > 0.01 && intrinsicX < 0.005) || (frameOffsetY > 0.01 && intrinsicY < 0.005)) {
      reasons.push('fix-svg-bounds-first');
    }
  }
  if (reasons.length) return { decision: { status: 'ABSTAIN', reasonCodes: [...new Set(reasons)], manualReviewRequired: true }, recommendation: null };

  const centroid = measurements.reference.centroid;
  const targetX = svg.viewBox.x + svg.viewBox.width / 2;
  const targetY = svg.viewBox.y + svg.viewBox.height / 2;
  let dxPercent = ((targetX - centroid.x) / svg.viewBox.width) * 100;
  const dyPercent = ((targetY - centroid.y) / svg.viewBox.height) * 100;
  if (rtl) dxPercent *= -1;
  if (Math.hypot(dxPercent, dyPercent) > 5) return { decision: { status: 'ABSTAIN', reasonCodes: ['proposal-out-of-range'], manualReviewRequired: true }, recommendation: null };
  if (Math.hypot(dxPercent, dyPercent) < 0.1) {
    return { decision: { status: 'NO_CHANGE', reasonCodes: ['within-optical-tolerance'], manualReviewRequired: false }, recommendation: { dxPercent: 0, dyPercent: 0, model: 'alpha-centroid-v1', evidenceQuality: 'experimental', pixelOffsets: pixelOffsets(0, 0, sizes) } };
  }
  dxPercent = formatNumber(dxPercent, 6);
  const roundedY = formatNumber(dyPercent, 6);
  return {
    decision: { status: 'REVIEW', reasonCodes: [], manualReviewRequired: true },
    recommendation: { dxPercent, dyPercent: roundedY, model: 'alpha-centroid-v1', evidenceQuality: 'experimental', evidence: { alphaWeightedCentroid: centroid, viewportCenter: { x: targetX, y: targetY } }, pixelOffsets: pixelOffsets(dxPercent, roundedY, sizes) },
  };
}

export function deriveAudit(svg, sizes, engine, context, rtl) {
  const measurements = measureSvg(svg.sanitized, svg.viewBox, sizes);
  const { decision, recommendation } = evaluateDecision(svg, measurements, engine, context, rtl, sizes);
  return { measurements, decision, recommendation };
}

export const derivedDigest = (derived) => sha256(JSON.stringify(derived));

export function validateDerivedAudit(svg, audit) {
  const embedded = { measurements: audit.measurements, decision: audit.decision, recommendation: audit.recommendation };
  if (audit.derivedSha256 !== derivedDigest(embedded)) fail('Audit decision or measurements were modified.', 'audit-derived-tampered', 2);
  const recomputed = deriveAudit(svg, audit.targetSizes, audit.engine?.name, audit.context, Boolean(audit.rtl));
  if (derivedDigest(recomputed) !== audit.derivedSha256) fail('Audit no longer matches fresh source measurements.', 'audit-derived-mismatch', 2);
  return recomputed;
}

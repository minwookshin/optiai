import { sha256 } from './svg-document.mjs';
import { measureSvg } from './raster.mjs';
import { fail, formatNumber } from './svg-utils.mjs';

function pixelOffsets(dxPercent, dyPercent, sizes) {
  return sizes.map((size) => ({ size, dx: formatNumber((dxPercent / 100) * size, 4), dy: formatNumber((dyPercent / 100) * size, 4) }));
}

const SIGNAL_DISAGREEMENT_PERCENT = 2;
const SIZE_INSTABILITY_PERCENT = 3;
const SYMMETRY_SCORE_MINIMUM = 0.9;

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

export function combineAxisSignals(entries, disagreementThreshold = SIGNAL_DISAGREEMENT_PERCENT) {
  const usable = entries.filter((entry) => Number.isFinite(entry.value));
  if (usable.length < 3) return { status: 'ABSTAIN', reasonCode: 'insufficient-optical-signals', signalCount: usable.length, values: usable };
  const values = usable.map((entry) => entry.value);
  const structuralValues = usable.filter((entry) => entry.name !== 'edge').map((entry) => entry.value);
  const consensus = median(values);
  const spread = Math.max(...values) - Math.min(...values);
  const structuralSpread = structuralValues.length >= 2 ? Math.max(...structuralValues) - Math.min(...structuralValues) : spread;
  const band = structuralSpread > disagreementThreshold ? 'conflict' : spread <= 0.5 ? 'strong' : 'mixed';
  return {
    status: band === 'conflict' ? 'ABSTAIN' : Math.abs(consensus) < 0.1 ? 'NO_CHANGE' : 'REVIEW',
    reasonCode: band === 'conflict' ? 'perceptual-signals-disagree' : null,
    signalCount: usable.length,
    consensus: formatNumber(consensus, 6),
    spread: formatNumber(spread, 6),
    structuralSpread: formatNumber(structuralSpread, 6),
    band,
    values: usable.map((entry) => ({ name: entry.name, value: formatNumber(entry.value, 6) })),
  };
}

function axisEntries(measurement, svg, axis, rtl) {
  const horizontal = axis === 'x';
  const target = horizontal ? svg.viewBox.x + svg.viewBox.width / 2 : svg.viewBox.y + svg.viewBox.height / 2;
  const dimension = horizontal ? svg.viewBox.width : svg.viewBox.height;
  const signals = measurement.signals ?? {};
  const entries = [];
  for (const [name, center] of [
    ['alpha', signals.alpha?.centroid],
    ['edge', signals.edge?.centroid],
    ['convexHull', signals.convexHull?.centroid],
  ]) {
    const coordinate = center?.[axis];
    if (Number.isFinite(coordinate)) entries.push({ name, value: ((target - coordinate) / dimension) * 100 });
  }
  const symmetryCoordinate = signals.symmetry?.axis?.[axis];
  const symmetryScore = signals.symmetry?.score?.[axis];
  if (Number.isFinite(symmetryCoordinate) && symmetryScore >= SYMMETRY_SCORE_MINIMUM) {
    entries.push({ name: 'symmetry', value: ((target - symmetryCoordinate) / dimension) * 100 });
  }
  if (horizontal && rtl) return entries.map((entry) => ({ ...entry, value: -entry.value }));
  return entries;
}

function ensembleRecommendation(svg, measurements, rtl, sizes) {
  const x = combineAxisSignals(axisEntries(measurements.reference, svg, 'x', rtl));
  const y = combineAxisSignals(axisEntries(measurements.reference, svg, 'y', rtl));
  const bySize = measurements.bySize.map((measurement) => {
    const sizeX = combineAxisSignals(axisEntries(measurement, svg, 'x', rtl));
    const sizeY = combineAxisSignals(axisEntries(measurement, svg, 'y', rtl));
    return { size: measurement.size, x: sizeX, y: sizeY };
  });
  const sizeConsensus = (axis) => bySize.map((row) => row[axis].consensus).filter(Number.isFinite);
  const sizeSpread = (axis) => {
    const values = sizeConsensus(axis);
    return values.length ? formatNumber(Math.max(...values) - Math.min(...values), 6) : null;
  };
  const stability = { xSpread: sizeSpread('x'), ySpread: sizeSpread('y'), threshold: SIZE_INSTABILITY_PERCENT };
  const insufficient = x.reasonCode === 'insufficient-optical-signals' || y.reasonCode === 'insufficient-optical-signals';
  const conflict = x.status === 'ABSTAIN' || y.status === 'ABSTAIN'
    || (stability.xSpread ?? Infinity) > SIZE_INSTABILITY_PERCENT
    || (stability.ySpread ?? Infinity) > SIZE_INSTABILITY_PERCENT;
  const band = conflict ? 'conflict' : x.band === 'strong' && y.band === 'strong' ? 'strong' : 'mixed';
  const evidence = {
    viewportCenter: { x: svg.viewBox.x + svg.viewBox.width / 2, y: svg.viewBox.y + svg.viewBox.height / 2 },
    signalAgreement: {
      band,
      axes: { x, y },
      multiSize: { measurements: bySize, stability },
      thresholds: { signalDisagreementPercent: SIGNAL_DISAGREEMENT_PERCENT, sizeInstabilityPercent: SIZE_INSTABILITY_PERCENT, symmetryScoreMinimum: SYMMETRY_SCORE_MINIMUM },
    },
  };
  if (insufficient) return { decision: { status: 'ABSTAIN', reasonCodes: ['insufficient-optical-signals'], manualReviewRequired: true, evidence }, recommendation: null };
  if (conflict) return { decision: { status: 'ABSTAIN', reasonCodes: ['perceptual-signals-disagree'], manualReviewRequired: true, evidence }, recommendation: null };
  const dxPercent = x.consensus;
  const dyPercent = y.consensus;
  if (Math.hypot(dxPercent, dyPercent) > 5) return { decision: { status: 'ABSTAIN', reasonCodes: ['proposal-out-of-range'], manualReviewRequired: true, evidence }, recommendation: null };
  if (Math.hypot(dxPercent, dyPercent) < 0.1) {
    return { decision: { status: 'NO_CHANGE', reasonCodes: ['within-optical-tolerance'], manualReviewRequired: false }, recommendation: { dxPercent: 0, dyPercent: 0, model: 'multi-signal-raster-v1', evidenceQuality: 'experimental', evidence, pixelOffsets: pixelOffsets(0, 0, sizes) } };
  }
  return {
    decision: { status: 'REVIEW', reasonCodes: [], manualReviewRequired: true },
    recommendation: { dxPercent, dyPercent, model: 'multi-signal-raster-v1', evidenceQuality: 'experimental', evidence, pixelOffsets: pixelOffsets(dxPercent, dyPercent, sizes) },
  };
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

  if (engine === 'ensemble') return ensembleRecommendation(svg, measurements, rtl, sizes);

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
  const measurements = measureSvg(svg.sanitized, svg.viewBox, sizes, { signals: engine === 'ensemble' });
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

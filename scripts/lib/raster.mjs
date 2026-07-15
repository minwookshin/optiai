import { Resvg } from '@resvg/resvg-js';
import { fail, formatNumber } from './svg-utils.mjs';

function renderer(svg, width) {
  try {
    const result = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false }, logLevel: 'off' });
    if (result.imagesToResolve().length) fail('External image resources are not deterministic.', 'external-resource', 2);
    return result;
  } catch (error) { fail(`Could not rasterize SVG: ${error.message}`, 'raster-failed', 2); }
}

export function vectorBounds(svg, viewBox) {
  const bbox = renderer(svg, 1024).getBBox();
  if (!bbox) return null;
  const bounds = { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height, maxX: bbox.x + bbox.width, maxY: bbox.y + bbox.height };
  return Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, formatNumber(value, 6)]));
}

function convexHull(points) {
  if (points.length <= 1) return points;
  const ordered = points
    .map(([x, y]) => [x, y])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (origin, a, b) => (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0]);
  const lower = [];
  for (const point of ordered) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const point = ordered[index];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function polygonCentroid(points) {
  if (points.length < 3) return null;
  let twiceArea = 0;
  let weightedX = 0;
  let weightedY = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const cross = current[0] * next[1] - next[0] * current[1];
    twiceArea += cross;
    weightedX += (current[0] + next[0]) * cross;
    weightedY += (current[1] + next[1]) * cross;
  }
  if (Math.abs(twiceArea) < 1e-9) return null;
  return [weightedX / (3 * twiceArea), weightedY / (3 * twiceArea)];
}

function symmetryAxis(profile) {
  const total = profile.reduce((sum, value) => sum + value, 0);
  if (!total) return null;
  let bestAxis2 = profile.length;
  let bestError = Infinity;
  for (let axis2 = 1; axis2 < profile.length * 2; axis2 += 1) {
    let error = 0;
    for (let index = 0; index < profile.length; index += 1) {
      const mirror = axis2 - index - 1;
      error += Math.abs(profile[index] - (mirror >= 0 && mirror < profile.length ? profile[mirror] : 0));
    }
    if (error < bestError - 1e-9 || (Math.abs(error - bestError) <= 1e-9 && Math.abs(axis2 - profile.length) < Math.abs(bestAxis2 - profile.length))) {
      bestError = error;
      bestAxis2 = axis2;
    }
  }
  return { pixel: bestAxis2 / 2, score: formatNumber(Math.max(0, 1 - bestError / (2 * total)), 6) };
}

function rasterSignals(pixels, width, height, viewBox) {
  const columnAlpha = new Float64Array(width);
  const rowAlpha = new Float64Array(height);
  const boundary = [];
  let edgeSum = 0;
  let edgeX = 0;
  let edgeY = 0;
  const alphaAt = (x, y) => (x < 0 || x >= width || y < 0 || y >= height ? 0 : pixels[(y * width + x) * 4 + 3]);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = alphaAt(x, y);
      if (alpha <= 1) continue;
      columnAlpha[x] += alpha;
      rowAlpha[y] += alpha;
      const neighbors = [alphaAt(x - 1, y), alphaAt(x + 1, y), alphaAt(x, y - 1), alphaAt(x, y + 1)];
      const edgeWeight = neighbors.reduce((sum, neighbor) => sum + Math.abs(alpha - neighbor), 0);
      if (edgeWeight > 0) {
        edgeSum += edgeWeight;
        edgeX += (x + 0.5) * edgeWeight;
        edgeY += (y + 0.5) * edgeWeight;
      }
      if (neighbors.some((neighbor) => neighbor <= 1)) boundary.push([x + 0.5, y + 0.5]);
    }
  }
  const scaleX = viewBox.width / width;
  const scaleY = viewBox.height / height;
  const toViewBox = ([x, y]) => ({ x: formatNumber(viewBox.x + x * scaleX, 6), y: formatNumber(viewBox.y + y * scaleY, 6) });
  const hullCenter = polygonCentroid(convexHull(boundary));
  const horizontalSymmetry = symmetryAxis(columnAlpha);
  const verticalSymmetry = symmetryAxis(rowAlpha);
  return {
    edge: { centroid: edgeSum ? toViewBox([edgeX / edgeSum, edgeY / edgeSum]) : null },
    convexHull: { centroid: hullCenter ? toViewBox(hullCenter) : null },
    symmetry: {
      axis: horizontalSymmetry && verticalSymmetry ? toViewBox([horizontalSymmetry.pixel, verticalSymmetry.pixel]) : null,
      score: { x: horizontalSymmetry?.score ?? 0, y: verticalSymmetry?.score ?? 0 },
    },
  };
}

export function rasterMeasure(svg, viewBox, size, options = {}) {
  const image = renderer(svg, size).render();
  const pixels = image.pixels;
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  let alphaSum = 0;
  let weightedX = 0;
  let weightedY = 0;
  let paintedPixels = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const alpha = pixels[(y * image.width + x) * 4 + 3];
      if (alpha <= 1) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      alphaSum += alpha;
      weightedX += (x + 0.5) * alpha;
      weightedY += (y + 0.5) * alpha;
      paintedPixels += 1;
    }
  }
  if (!paintedPixels) return { size, paintedBounds: null, alphaSum: 0, paintedPixels: 0, centroid: null, touches: [] };
  const scaleX = viewBox.width / image.width;
  const scaleY = viewBox.height / image.height;
  const paintedBounds = {
    x: formatNumber(viewBox.x + minX * scaleX, 6),
    y: formatNumber(viewBox.y + minY * scaleY, 6),
    width: formatNumber((maxX - minX + 1) * scaleX, 6),
    height: formatNumber((maxY - minY + 1) * scaleY, 6),
    maxX: formatNumber(viewBox.x + (maxX + 1) * scaleX, 6),
    maxY: formatNumber(viewBox.y + (maxY + 1) * scaleY, 6),
  };
  const touches = [];
  if (minX === 0) touches.push('left');
  if (maxX === image.width - 1) touches.push('right');
  if (minY === 0) touches.push('top');
  if (maxY === image.height - 1) touches.push('bottom');
  const measurement = {
    size,
    paintedBounds,
    alphaSum,
    paintedPixels,
    centroid: {
      x: formatNumber(viewBox.x + (weightedX / alphaSum) * scaleX, 6),
      y: formatNumber(viewBox.y + (weightedY / alphaSum) * scaleY, 6),
    },
    touches,
  };
  if (options.signals) {
    measurement.signals = {
      alpha: { centroid: measurement.centroid },
      ...rasterSignals(pixels, image.width, image.height, viewBox),
    };
  }
  return measurement;
}

export function rasterPng(svg, size) {
  return renderer(svg, size).render().asPng();
}

export function connectedComponentCount(svg, size = 128) {
  const image = renderer(svg, size).render();
  const active = new Uint8Array(image.width * image.height);
  for (let index = 0; index < active.length; index += 1) active[index] = image.pixels[index * 4 + 3] > 8 ? 1 : 0;
  const queue = new Int32Array(active.length);
  let components = 0;
  for (let start = 0; start < active.length; start += 1) {
    if (!active[start]) continue;
    let head = 0;
    let tail = 0;
    let area = 0;
    active[start] = 0;
    queue[tail++] = start;
    while (head < tail) {
      const current = queue[head++];
      area += 1;
      const x = current % image.width;
      const neighbors = [current - image.width, current + image.width];
      if (x > 0) neighbors.push(current - 1);
      if (x < image.width - 1) neighbors.push(current + 1);
      for (const neighbor of neighbors) {
        if (neighbor >= 0 && neighbor < active.length && active[neighbor]) {
          active[neighbor] = 0;
          queue[tail++] = neighbor;
        }
      }
    }
    if (area >= 2) components += 1;
  }
  return components;
}

export function measureSvg(svg, viewBox, sizes, options = {}) {
  const referenceSize = Math.min(1024, Math.max(512, Math.round(viewBox.width * 32)));
  const reference = rasterMeasure(svg, viewBox, referenceSize, options);
  const paintedBounds = reference.paintedBounds;
  if (!paintedBounds || !reference.paintedBounds) return { reference: { paintedBounds: null, sideBearings: null, centroid: null }, bySize: sizes.map((size) => rasterMeasure(svg, viewBox, size, options)) };
  const sideBearings = {
    left: formatNumber(paintedBounds.x - viewBox.x, 6),
    right: formatNumber(viewBox.x + viewBox.width - paintedBounds.maxX, 6),
    top: formatNumber(paintedBounds.y - viewBox.y, 6),
    bottom: formatNumber(viewBox.y + viewBox.height - paintedBounds.maxY, 6),
  };
  const referenceMeasurement = { paintedBounds, sideBearings, centroid: reference.centroid, alphaSum: reference.alphaSum, connectedComponents: connectedComponentCount(svg) };
  if (options.signals) referenceMeasurement.signals = reference.signals;
  return { reference: referenceMeasurement, bySize: sizes.map((size) => rasterMeasure(svg, viewBox, size, options)) };
}

export function clippingIssues(sourceSvg, sourceViewBox, candidateSvg, candidateViewBox, sizes) {
  const referenceSize = Math.min(1024, Math.max(512, Math.round(sourceViewBox.width * 32)));
  const sourceBounds = rasterMeasure(sourceSvg, sourceViewBox, referenceSize).paintedBounds;
  const sides = [];
  const epsilon = Math.max(candidateViewBox.width, candidateViewBox.height) / 100000;
  if (sourceBounds) {
    if (sourceBounds.x < candidateViewBox.x - epsilon) sides.push('left');
    if (sourceBounds.maxX > candidateViewBox.x + candidateViewBox.width + epsilon) sides.push('right');
    if (sourceBounds.y < candidateViewBox.y - epsilon) sides.push('top');
    if (sourceBounds.maxY > candidateViewBox.y + candidateViewBox.height + epsilon) sides.push('bottom');
  }
  const raster = [];
  for (const size of sizes) {
    const before = rasterMeasure(sourceSvg, sourceViewBox, size);
    const after = rasterMeasure(candidateSvg, candidateViewBox, size);
    const retained = before.alphaSum ? after.alphaSum / before.alphaSum : 1;
    raster.push({ size, retainedAlpha: formatNumber(retained, 6), touches: after.touches });
    // Small icons can gain or lose a few antialiased edge pixels after a safe
    // subpixel shift. Treat only material alpha loss as clipping; exact vector
    // overflow above remains the primary boundary check.
    if (retained < 0.95 && !sides.includes('raster-loss')) sides.push('raster-loss');
  }
  return { clipped: sides.length > 0, sides, raster };
}

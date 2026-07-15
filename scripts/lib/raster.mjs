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

export function rasterMeasure(svg, viewBox, size) {
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
  return {
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

export function measureSvg(svg, viewBox, sizes) {
  const referenceSize = Math.min(1024, Math.max(512, Math.round(viewBox.width * 32)));
  const reference = rasterMeasure(svg, viewBox, referenceSize);
  const paintedBounds = reference.paintedBounds;
  if (!paintedBounds || !reference.paintedBounds) return { reference: { paintedBounds: null, sideBearings: null, centroid: null }, bySize: sizes.map((size) => rasterMeasure(svg, viewBox, size)) };
  const sideBearings = {
    left: formatNumber(paintedBounds.x - viewBox.x, 6),
    right: formatNumber(viewBox.x + viewBox.width - paintedBounds.maxX, 6),
    top: formatNumber(paintedBounds.y - viewBox.y, 6),
    bottom: formatNumber(viewBox.y + viewBox.height - paintedBounds.maxY, 6),
  };
  return { reference: { paintedBounds, sideBearings, centroid: reference.centroid, alphaSum: reference.alphaSum, connectedComponents: connectedComponentCount(svg) }, bySize: sizes.map((size) => rasterMeasure(svg, viewBox, size)) };
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

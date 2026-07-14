# Failure modes and diagnostic order

## 1. Container layout mistaken for optical misalignment

Symptoms:

- the same icon looks correct in one component and wrong in another;
- padding differs between states or breakpoints;
- transforms or nested wrappers shift the entire asset;
- inline SVG inherits unexpected line-height or vertical alignment.

Inspect computed layout, wrapper dimensions, padding, flex/grid alignment, transforms, and inline formatting before touching the SVG.

## 2. SVG bounds mistaken for optical misalignment

Symptoms:

- visible whitespace differs even though the SVG element is centered;
- the root has no viewBox or has a viewBox unrelated to visible content;
- exported groups, hidden shapes, transparent fillers, or detached marks enlarge the bounds;
- width and height imply one aspect ratio while the viewBox implies another.

Repair the viewBox or export process first. Do not compensate for bad bounds with CSS margins.

## 3. Optical correction mistaken for geometry repair

An algorithmic offset is appropriate only after the container and bounds are valid. A proposed offset should remain small relative to the viewBox. Large offsets often indicate malformed bounds, unexpected artwork, or an unsuitable source asset.

Escalate to manual review when:

- either axis exceeds 5% of the viewBox;
- the asset is a brand logo;
- filters, shadows, masks, clipping paths, or detached marks are present;
- multiple disconnected shapes have different semantic importance;
- the icon changes meaning when mirrored or shifted.

## 4. Icon-text baseline mistaken for optical center

Check font ascent/descent, line-height, cap height, inline `vertical-align`, flex alignment, icon size, and label gap. Align the icon to the intended typographic reference, not necessarily the element box midpoint.

## 5. Export and handoff failures

- Transparent dummy shapes may be removed by design-tool export.
- Low-opacity fillers can survive export and affect compositing or hit testing.
- Tightened viewBoxes can clip strokes, filters, or antialiasing fringes.
- CSS nudges can be lost when an icon is swapped.
- Copy-pasted offsets can be applied twice in nested components.

Store the approved correction once and add metadata so future maintainers can see that it is intentional.

## Existing ecosystem caveat

The pinned `optical-center@0.2.0-alpha.0` engine is experimental. Its recommendation is useful evidence, not a universal perceptual truth. In particular, review vertical and horizontal axes independently: an otherwise symmetric glyph can receive a vertical bias from the model. Preserve the raw engine result and version in the audit, then record any reviewed axis override separately.

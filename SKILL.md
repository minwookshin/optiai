---
name: optiai
description: Audit and correct optical alignment in SVG icons, logos, glyphs, and icon-text controls. Use when an asset is mathematically centered but still looks off-center; when play arrows, chevrons, asymmetric logos, badges, or detached marks need perceptual balancing; when SVG viewBox padding or export clipping may be mistaken for an alignment problem; or when a design-to-code handoff needs measurable offsets, comparison renders, and a safe correction.
---

# OptiAI

Treat geometric centering as a baseline, not a verdict. Diagnose the source of the mismatch, calculate a bounded correction, render evidence at real sizes, and preserve the approved decision in the asset or design token.

## Operating rules

- Distinguish container layout, SVG bounds, optical perception, and icon-text baseline problems before changing coordinates.
- Never apply a universal `2px` nudge. Express recommendations as percentages and show their pixel equivalents at target sizes.
- Treat algorithmic output as a proposal. Require visual review for logos, intentional asymmetry, detached marks, shadows, badges, masks, filters, and compound artwork.
- Keep brand artwork unchanged unless the user explicitly authorizes asset modification.
- Store an approved correction once in the SVG viewBox, side bearing, wrapper asset, or icon token. Avoid repeated component-level margins.
- Test both light and dark backgrounds and every requested production size.
- Check clipping and stroke overflow after any correction.

## Workflow

### 1. Establish context

Collect the asset, target sizes, container shape, background themes, fill or outline style, icon-only or icon-text usage, and RTL behavior. If details are absent, use `16,20,24,32,48` pixels and both light and dark themes.

### 2. Classify the root cause

Use these categories:

1. `container-layout`: CSS, Auto Layout, padding, or wrapper geometry is wrong.
2. `svg-bounds`: the viewBox or invisible/exported content creates unequal whitespace.
3. `optical-perception`: the visible shape is mathematically centered but feels displaced.
4. `text-baseline`: inline layout, font metrics, line-height, or icon-text spacing causes the mismatch.

Fix categories 1, 2, and 4 at their source before adding an optical correction. Read `references/failure-modes.md` when bounds, export, or baseline issues are plausible.

### 3. Analyze the SVG

Set `SKILL_DIR` to this skill directory, then run:

```bash
node "$SKILL_DIR/scripts/analyze-svg.mjs" icon.svg \
  --engine optical-center \
  --context icon-only \
  --sizes 16,20,24,32,48 \
  --output optiai-audit.json
```

The pinned experimental engine may use `npx` and network access on first use. Use `--engine none` for an offline structural audit. Do not describe the experimental engine as ground truth.

For mirrored directional assets, add `--rtl`. For icon-text controls use `--context icon-text`; for logos use `--context logo`.

### 4. Render visual evidence

```bash
node "$SKILL_DIR/scripts/render-comparison.mjs" icon.svg \
  --analysis optiai-audit.json \
  --sizes 16,20,24,32,48 \
  --themes light,dark \
  --output optiai-comparison.svg
```

Inspect the source, geometric guides, and proposed correction at actual display sizes. Prefer the smallest correction that removes the perceived imbalance without creating a new one.

Review horizontal and vertical axes independently. If geometry or visual evidence rejects one axis, render the reviewed values explicitly:

```bash
node "$SKILL_DIR/scripts/render-comparison.mjs" icon.svg \
  --analysis optiai-audit.json \
  --dx-percent 1.3447 \
  --dy-percent 0 \
  --output optiai-reviewed-comparison.svg
```

### 5. Verify export safety

```bash
node "$SKILL_DIR/scripts/verify-export.mjs" icon.svg \
  --analysis optiai-audit.json \
  --output optiai-verification.json
```

Resolve failures before applying a correction. Treat warnings about masks, filters, transparent fillers, strokes, or external references as manual-review items.

### 6. Apply only after review

Create a corrected copy:

```bash
node "$SKILL_DIR/scripts/apply-correction.mjs" icon.svg \
  --analysis optiai-audit.json \
  --output icon.optiai.svg
```

Pass `--dx-percent` and/or `--dy-percent` to apply the reviewed values instead of the raw engine proposal. Preserve the rejected raw proposal in the audit for traceability.

Never overwrite the source by default. Use `--in-place --yes` only when the task explicitly requires it; the script creates a backup unless `--no-backup` is also provided.

### 7. Report the decision

Return:

- diagnosed category and supporting evidence;
- proposed horizontal and vertical offsets in percent and pixels;
- confidence and reasons for manual review;
- comparison artifact path;
- clipping/export verification result;
- exact storage location for the approved correction.

Read `references/optical-alignment-principles.md` when explaining the perceptual rationale or reviewing a difficult shape.

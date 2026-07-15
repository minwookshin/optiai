---
name: optiai
description: Audit, compare, collect pairwise preference evidence for, calibrate a transparent research ranker for, and safely correct optical alignment in SVG icons, logos, glyphs, and icon-text controls. Use when an asset is mathematically centered but looks off-center; when play arrows, chevrons, asymmetric marks, or badges need perceptual balancing; when SVG padding or clipping may be mistaken for alignment; when repeated expert A/B judgments should become leak-resistant training and holdout evidence; or when a design-to-code handoff needs measured offsets and a guarded correction.
---

# OptiAI

Treat geometric centering as a baseline, not a verdict. Measure the painted shape, separate malformed bounds from optical imbalance, collect blinded pairwise evidence when calibration is useful, and apply only the exact reviewed candidate that passed fresh clipping checks.

## Safety rules

- Diagnose container layout, SVG bounds, optical perception, and text baseline separately.
- Never apply a universal pixel nudge or an unreviewed model result.
- Treat `ABSTAIN` as a successful safety outcome. Repair bounds or request expert review instead of forcing a number.
- Require explicit review for logos, text, filters, masks, non-scaling strokes, detached marks, and intentional asymmetry.
- Bind every audit and verification to the exact source path, SHA-256, byte length, and viewBox.
- Apply only a verification artifact with `status: PASS`; never edit its JSON by hand.
- Treat every Preference Lab artifact as `nonAuthorizing`. A preferred candidate is training evidence, never approval to modify an SVG.
- Keep every dataset and ranker `nonAuthorizing`. Never pass a ranker artifact to comparison, verification, or apply commands.
- Keep each reviewed correction within ±5% per axis. Larger values indicate bounds repair or `ABSTAIN`, not an optical nudge.
- Keep the original unless the user explicitly requests `--in-place --yes`.

The hashes prevent stale or accidentally mixed artifacts; they are not digital signatures against a hostile local user who can rewrite both code and JSON.

## Setup

After installing or cloning the skill, install its locked local dependencies once:

```bash
node "$SKILL_DIR/scripts/setup.mjs"
```

This runs `npm ci --ignore-scripts` from the committed lockfile. Runtime commands never invoke `npx` or download code.

## Workflow

### 1. Establish context

Collect the SVG, production sizes, container shape, light/dark use, icon-only versus icon-text context, and RTL behavior. If absent, use `16,20,24,32,48`.

### 2. Inspect likely non-optical causes

Check CSS/Auto Layout, wrapper padding, viewBox padding, hidden or detached geometry, and icon-text baseline first. Read `references/failure-modes.md` when these are plausible.

### 3. Create an immutable audit

```bash
node "$SKILL_DIR/scripts/analyze-svg.mjs" icon.svg \
  --context icon-only \
  --sizes 16,20,24,32,48 \
  --output optiai-audit.json
```

The audit uses a local alpha-centroid proposal as experimental evidence, not perceptual truth. It records actual painted bounds, side bearings, per-size rasters, source binding, and either `REVIEW`, `NO_CHANGE`, or `ABSTAIN`. Stop when it abstains.

### 4. Optionally collect blinded preference evidence

For repeated calibration, difficult icons, or expert-panel labeling, generate an axis-separated A/B lab:

```bash
node "$SKILL_DIR/scripts/create-preference-lab.mjs" icon.svg \
  --analysis optiai-audit.json \
  --radius-percent 2 \
  --step-percent 0.5 \
  --seed project-round-1 \
  --study-output optiai-study.json \
  --output optiai-lab.html
```

Open the self-contained HTML locally. Judge A, B, Tie, or Cannot judge across all shown sizes and themes, enter a pseudonymous rater ID, and export the response JSON. Do not reveal the study manifest to raters before they finish.

Combine complete responses into deterministic training rows:

```bash
node "$SKILL_DIR/scripts/export-preferences.mjs" icon.svg \
  expert-01.json expert-02.json expert-03.json \
  --analysis optiai-audit.json \
  --study optiai-study.json \
  --output optiai-preferences.jsonl
```

The exporter re-creates every candidate and rejects stale source, audit, study, trial, or presentation lineage. It preserves Tie and ABSTAIN separately. It never creates a verification or application artifact. Read `references/preference-lab.md` before designing a multi-rater study or training a ranker.

### 5. Optionally aggregate a multi-family calibration corpus

After collecting at least three independent experts per study, map every source to explicit `sourceId`, `groupId`, and `familyId` values in a corpus manifest. Keep close variants in the same group and family. Then aggregate validated rows:

```bash
node "$SKILL_DIR/scripts/aggregate-preferences.mjs" corpus.json \
  --min-raters 3 \
  --folds 5 \
  --seed project-calibration-v1 \
  --output optiai-dataset.json
```

The dataset canonicalizes reversed A/B presentations, rejects duplicate raters per pair, preserves disagreement, and creates deterministic family and group folds. It is `UNDERPOWERED` with fewer than four eligible families, four eligible groups, or 20 eligible pairs. Read `references/ranker-protocol.md` before defining family or group boundaries.

### 6. Optionally train and evaluate the transparent ranker

```bash
node "$SKILL_DIR/scripts/train-preference-ranker.mjs" optiai-dataset.json \
  --output optiai-ranker.json
```

Training uses dependency-free pairwise logistic regression and out-of-fold evaluation against zero correction and the alpha-centroid proposal. `Tie` and `ABSTAIN` never enter winner loss. Treat `PROMISING_RESEARCH_ONLY` only as evidence that calibration may be useful; it still cannot authorize or apply any correction.

### 7. Compare and review each axis

```bash
node "$SKILL_DIR/scripts/render-comparison.mjs" icon.svg \
  --analysis optiai-audit.json \
  --dx-percent 1.25 \
  --dy-percent 0 \
  --output optiai-comparison.svg
```

Inspect source and reviewed rasters at every target size. Decide horizontal and vertical values independently. Prefer zero or the smallest correction that fixes the imbalance.

### 8. Approve and verify the exact candidate

Only after visual review, run:

```bash
node "$SKILL_DIR/scripts/verify-export.mjs" icon.svg \
  --analysis optiai-audit.json \
  --dx-percent 1.25 \
  --dy-percent 0 \
  --approve \
  --comparison optiai-comparison.svg \
  --output optiai-verification.json
```

`PASS` means the comparison hash, per-axis `ACCEPT_PROPOSAL`/`OVERRIDE`/`ZERO` decisions, exact correction, and candidate SHA-256 passed source binding, correction bounds, overflow, and multi-size raster checks. `FAIL` or `REVIEW_REQUIRED` blocks application.

### 9. Apply the verified candidate

```bash
node "$SKILL_DIR/scripts/apply-correction.mjs" icon.svg \
  --analysis optiai-audit.json \
  --comparison optiai-comparison.svg \
  --verification optiai-verification.json \
  --confirm-reviewed \
  --output icon.optiai.svg
```

The apply step revalidates the audit, comparison, per-axis review, candidate, and correction digests; requires fresh `--confirm-reviewed`; reruns clipping checks; and writes atomically. For an explicitly requested overwrite use `--in-place --yes`; OptiAI creates a unique exclusive backup unless `--no-backup` is also explicit. Portable filesystem rename has no compare-and-swap, so avoid concurrent edits during the final apply command.

### 10. Report the decision

Return the diagnosed category, painted bounds and side bearings, reviewed offsets in percent and pixels, decision/reason codes, comparison path, verification status, output path, and remaining manual-review limits. When a Preference Lab was used, also report the study ID, response count, Tie/ABSTAIN counts, and JSONL path. For calibration, report family/group counts, eligible pairs, agreement, out-of-fold baseline comparison, and the research-only status. Do not report a correction confidence score.

Read `references/optical-alignment-principles.md` when explaining a difficult perceptual decision.

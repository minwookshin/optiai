# Fixed benchmark protocol

The v0.7 benchmark is a research-only comparison of panel preference on a predeclared holdout. It does not measure objective centering truth, credential-verified expertise, production readiness, or permission to modify an SVG.

## Freeze before responses

- Freeze the manifest, exact dataset, exact model, seed, cases, conditions, outputs, and hazard suite before collecting responses.
- Keep benchmark sources disjoint from training by source SHA-256, family ID, and `family/group` ID. Human review must also catch semantic sibling leakage that IDs cannot detect.
- Retire a benchmark after any of its responses are used for training. A later model needs a fresh holdout.
- Keep one source, axis, size, theme, and context per trial.
- Do not show filenames, policy names, correction values, or candidate hashes in the HTML lab. Participant IDs are opaque, but a visually identical candidate can recur across three direct comparisons and may be recognized. The blinding is UI-level, not adversarial or fully unlinkable.

Each case in `benchmark-manifest.json` uses this shape; `svg` is resolved relative to the manifest:

```json
{
  "caseId": "play-24-light-x",
  "sourceId": "play-filled",
  "familyId": "media-controls",
  "groupId": "play-variants",
  "sourceSha256": "<64 lowercase hex characters>",
  "svg": "sources/play.svg",
  "axis": "x",
  "condition": { "size": 24, "theme": "light", "context": "icon-only" },
  "outputs": {
    "zero-v1": { "status": "VALUE", "percent": 0 },
    "alpha-centroid-v1": { "status": "VALUE", "percent": 0.5 },
    "ensemble-v05": { "status": "VALUE", "percent": 0.75 },
    "learned-v06": { "status": "VALUE", "percent": 1, "modelDigest": "<bound model digest>" }
  }
}
```

The manifest top level is `{schemaVersion:1, tool:"OptiAI Fixed Benchmark Manifest", nonAuthorizing:true, benchmarkId, holdoutOnly:true, seed, cases, hazards}`. The hazard suite must contain exactly one entry for every required type listed below, with `caseId`, `hazardType`, `expectedStatus:"ABSTAIN"`, `expectedReasonCode`, and a model-bound `learnedOutput`.

## Policy contract

- `zero-v1`: zero correction.
- `alpha-centroid-v1`: the legacy alpha-centroid proposal.
- `ensemble-v05`: the multi-signal v0.5 proposal or `ABSTAIN`.
- `learned-v06`: a precomputed frozen-model proposal whose `modelDigest` matches the supplied ranker, wrapped by ensemble safety. It must also abstain whenever the ensemble abstains. The benchmark binds the supplied result to the model digest; it does not independently reimplement every upstream inference pipeline, so generation provenance still requires review.

Every numeric output must stay within ±5% and pass fresh source, clipping, and SVG security checks before rendering. Identical outputs are recorded rather than presented as a fake win/loss comparison.

## Separate safety from preference

The hazard suite checks expected learned abstention reason codes independently of A/B preference. Include active content, external references, malformed bounds, detached marks, signal disagreement, full-bleed clipping, already-centered sources, and out-of-range proposals where applicable. One learned safety failure blocks promotion.

## Fixed gate

`optiai-fixed-v1` requires all of the following:

- 40 holdout sources, six families, and eight family/group units.
- Five complete pseudonymous raters per distinct pair.
- Against each baseline: 40 unique source hashes with at least five A/B votes each, 120 decisive votes, five represented families, decisive win rate above 0.5, Wilson 95% lower bound above 0.5, and family-macro win rate above 0.5. Abstaining or tie-only filler sources and repeated conditions from a few sources cannot satisfy this requirement.
- Learned coverage at least equal to ensemble coverage.
- A passing hazard suite.

Possible results are `UNDERPOWERED`, `BASELINE_NOT_BEATEN`, and `PROMISING_RESEARCH_ONLY`; malformed inputs fail closed instead of producing a trusted report. The current repository ships tooling and synthetic gate tests, not fresh human evidence, so it makes no empirical superiority claim.

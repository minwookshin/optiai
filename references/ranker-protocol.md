# Ranker protocol

Use the ranker only to test whether repeated expert judgments contain a learnable calibration signal. It is not a correction engine and never authorizes an SVG edit.

## Corpus manifest

Create a JSON manifest with paths relative to the manifest file:

```json
{
  "schemaVersion": 1,
  "tool": "OptiAI Preference Corpus",
  "nonAuthorizing": true,
  "sources": [
    {
      "sourceId": "media-play-filled",
      "familyId": "media-controls",
      "groupId": "play-variants",
      "audit": "audits/media-play-filled.json",
      "preferences": ["labels/media-play-filled.jsonl"]
    }
  ]
}
```

- Use `sourceId` for one exact SVG.
- Use `groupId` for near-identical variants such as filled, outline, and size variants.
- Use `familyId` for the broader design system or semantic family.
- Never place siblings in different groups or families to improve evaluation scores.
- Keep at least three decisive A/B raters per pair. Tie and ABSTAIN are reported but do not satisfy this threshold.

## Aggregation contract

The aggregator verifies every datum digest, audit digest, source binding, axis, candidate range, choice field, and family mapping. It treats rater IDs case-insensitively and rejects duplicate rater/pair votes across files. A/B presentation is canonicalized by correction order before votes are counted.

The output omits rater IDs and input paths. Each source-axis contributes a normalized total training weight so sources with more trials do not dominate. Tie and ABSTAIN never alter pairwise winner weights.

Agreement is reported as pair-weighted observed agreement plus chance-corrected agreement for four-way responses and decisive preferences. Do not describe it as universal taste or as a credential check on raters.

## Ranker and evaluation

The transparent model scores a candidate correction `q = correctionPercent / 5` against the audit proposal `r = proposalPercent / 5` with three bounded features:

```text
[-q², 2qr, -|q|]
```

Horizontal and vertical weights are fitted separately with deterministic full-batch logistic regression. Family and group folds are assigned before training; every prediction used for reported evaluation comes from a fold that excluded that unit.

Compare the learned model on identical out-of-fold pairs against:

- zero correction: prefer the candidate nearest zero;
- alpha-centroid: prefer the candidate nearest the audit proposal.

Inspect winner accuracy, log loss, Brier score, evaluation coverage, and risk–coverage together. All three models are compared on the identical out-of-fold pair cohort. `PROMISING_RESEARCH_ONLY` requires complete learned-model family-holdout coverage, at least five eligible families, and better accuracy and log loss than both baselines. Any other status blocks calibration claims.

`READY` on a dataset means only that deterministic training and holdout evaluation are sufficiently populated. It is not a quality result. Read the model's `evaluationStatus` and `recommendedForCalibration`; only `PROMISING_RESEARCH_ONLY` passes the stricter baseline comparison, and it remains non-authorizing.

## Known limits

- Human family/group mapping can still create leakage when mislabeled.
- Pseudonymous IDs do not prove expertise or prevent one person from using multiple IDs.
- Each trial combines sizes and themes, so the current model cannot learn size-specific preferences.
- Adjacent candidates provide local rankings, not a universal visual-quality score.
- The three-feature ranker calibrates geometry; it does not understand brand meaning or semantic intent.
- Digests catch accidental mixing and ordinary tampering but are not cryptographic signatures from trusted raters.

# Preference Lab protocol

Use pairwise judgments to calibrate OptiAI for a narrow visual task. Do not claim that the resulting data represents universal taste or authorizes a correction.

## v0.6 adaptive collection

The adaptive lab isolates one `size × theme × axis` condition per question. It starts from a uniform ideal-offset grid, updates that posterior after A, B, or Tie, and chooses the remaining pair with the highest information score. `Cannot judge` is retained but does not update the posterior. The exported order is replayed by the CLI; changing an earlier choice, trial ID, index, or response time invalidates later lineage.

The final question repeats the first pair with A/B reversed. This is a small within-rater reliability check, not proof of expertise. Response time is diagnostic metadata, not a quality score. The policy is deterministic for a bound study and seed so the exporter can reproduce it exactly.

The tie-aware ideal-point estimator searches a bounded, transparent grid for an offset and indifference width. It uses A, B, and Tie likelihoods, excludes `ABSTAIN`, and excludes the repeat from fitting. An `ESTIMATED` artifact still remains `nonAuthorizing` and cannot approve, verify, or apply a correction.

## Study design

- Judge horizontal and vertical candidates independently.
- Render every pair at the production sizes and themes recorded by the audit.
- Keep the lab blinded. Do not show filenames, offsets, engine proposals, candidate hashes, or `SOURCE`/`REVIEWED` labels.
- Use a pseudonymous rater ID. Do not collect names, emails, or other personal data in the response artifact.
- Require one of `A`, `B`, `TIE`, or `ABSTAIN` for every trial.
- Treat `TIE` as perceptual equivalence and `ABSTAIN` as insufficient context. Never merge them.
- Use at least three independent expert responses per study before calling a label a panel preference.
- Randomize presentation with a recorded seed, but describe it as reproducible ordering rather than cryptographic blinding.

## Dataset handling

- Keep the study manifest private from raters until labeling is complete because it contains the candidate mapping.
- Export through `export-preferences.mjs`; do not hand-edit JSONL rows.
- Split evaluation by icon family or source system. Random sibling splits leak near-identical geometry.
- Preserve disagreement. Report vote distribution and ABSTAIN coverage instead of collapsing every trial into a forced winner.
- Exclude ABSTAIN rows from pairwise winner loss. Use TIE only with a ranking method that supports equivalence or a defined tolerance band.

## Model and evaluation

Start with explicit geometry and raster features plus a small pairwise ranker. Add dense vision embeddings only after the baseline and blind evaluation are stable. Candidate preference can be modeled with a score difference such as `P(A > B) = sigmoid(score(A) - score(B))`.

Evaluate with expert blind A/B agreement, false-auto-fix rate, size-specific performance, family holdouts, and risk–coverage under ABSTAIN. Compare against zero correction and the existing alpha-centroid proposal. A useful model should beat both without reducing the safe abstention behavior.

## Sources

- Burges et al., [Learning to Rank using Gradient Descent](https://www.microsoft.com/en-us/research/publication/learning-to-rank-using-gradient-descent/)
- Talebi et al., [Rank-smoothed Pairwise Learning in Perceptual Quality Assessment](https://research.google/pubs/rank-smoothed-pairwise-learning-in-perceptual-quality-assessment/)
- Parikh and Grauman, [Beyond Comparing Image Pairs](https://vision.cs.utexas.edu/projects/beyondpairs/)
- Guo et al., [On Calibration of Modern Neural Networks](https://proceedings.mlr.press/v70/guo17a.html)

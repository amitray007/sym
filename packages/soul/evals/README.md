# Soul evals — promptfoo

Two eval sets covering:

1. **cascade.yaml** — cascade correctness: given a set of L0–L3 layers, does
   the resolver produce the expected `effectiveMd` and layer order?
2. **substance-diff.yaml** — substance-diff guard accuracy: tone-only changes
   → accept; fact changes → reject.

## Running

```bash
# From the repo root
pnpm exec promptfoo eval --config packages/soul/evals/cascade.yaml
pnpm exec promptfoo eval --config packages/soul/evals/substance-diff.yaml
```

## Thresholds (initial)

These are baseline targets set before any eval runs. Adjust them as the guard
matures based on actual eval output.

| Eval           | Metric                                        | Initial threshold |
| -------------- | --------------------------------------------- | ----------------- |
| cascade        | Layer order correct                           | 100 %             |
| cascade        | effectiveMd contains L0 content               | 100 %             |
| cascade        | effectiveMd contains most-specific layer last | 100 %             |
| substance-diff | Tone-only → accepted                          | ≥ 90 %            |
| substance-diff | Fact-change → rejected                        | ≥ 95 %            |

The substance-diff thresholds intentionally allow some false positives on
tone-only cases (over-rejection is safe — the original is delivered). False
negatives on fact-change cases are the higher-stakes failure and are held to a
stricter threshold.

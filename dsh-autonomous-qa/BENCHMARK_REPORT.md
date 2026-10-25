# Algorithm vs baseline — v0.4.0 (2026-10-25)

## What was compared

- Control: v0.3 source-derived tag planner (baseline + single-factor + seeded greedy pairwise combinations).
- Intervention: v0.4 source-derived tag planner plus forbidden-state constraints, feasible-pair enumeration, deterministic weighted greedy covering array (NOT official IPOG).
- Both use the same source index, independent oracle contracts, Chromium driver and **same maximum scenario count** per fixture. The baseline cannot enforce the supplied constraints; its invalid scenarios consume budget and are excluded from valid coverage. These different capabilities are part of the upgrade, but **not a component-isolated algorithm experiment**.
- Fault triggers are seeded in isolated fixtures and **never given to either planner**. This is a synthetic injection test, not measured detection on real unknown user-project defects. No human ground truth is claimed for real projects.

## 5 controlled synthetic fixtures (58 planned scenarios per strategy)

| Metric | v0.3 baseline | v0.4 algorithm |
|---|---:|---:|
| Planned cases | 58 | 58 |
| Invalid combinations | 7 | 0 |
| Predefined injected fault triggers hit | 17 / 20 (85%) | 20 / 20 (100%) |
| Feasible 2-way coverage | 50.85% | 91.30% |

| Fixture | Budget | Baseline triggered | Algorithm triggered | Baseline feasible pair coverage | Algorithm feasible pair coverage |
|---|---:|---:|---:|---:|---:|
| Signup | 12 | 3/4 | 4/4 | 49.6% | 91.6% |
| Checkout | 12 | 3/4 | 4/4 | 44.5% | 87.0% |
| Filtering | 12 | 4/4 | 4/4 | 45.8% | 90.8% |
| Profile | 10 | 3/4 | 4/4 | 56.0% | 93.3% |
| Approval | 12 | 4/4 | 4/4 | 64.1% | 96.1% |

## Repeated seeded holdout test

20 deterministic seeds, 5 fixture families, **400 independently generated feasible pair-trigger faults**. These were chosen **after planning** and did not influence prioritization.

- Baseline hit: **206/400 (51.5%)**.
- Algorithm hit: **356/400 (89.0%)**.
- Caveat: these are seeded variants of the same five synthetic fixture families, not 100 independently sourced front-end products. They have shared structure.

## Actual browser interaction smoke test

Same `signup` fixture, budget **12 planned scenarios** per strategy, in real Chromium via our CDP driver using `Page.setDocumentContent`. Each case resets the page and performs real element filling/clicks, then uses an **independent** `expectText` assertion (`#status` equals `OK`). Browser page code deliberately emits `BUG` for the known fault triggers. Invalid cases are counted as spent budget and not executed.

- Baseline: 12 planned, 11 valid executed, **3/4 distinct injected faults observed**, 8 failing assertions, 0 unexplained oracle disagreements.
- Algorithm: 12 planned, 12 valid executed, **4/4 distinct injected faults observed**, 5 failing assertions, 0 unexplained oracle disagreements.
- A larger number of FAIL assertions does **not** mean more distinct faults: the baseline repeatedly triggers some bugs.
- Recorded browser execution time is for this smoke test and can fluctuate; the algorithm's planner has additional nonzero overhead compared with baseline (see per-fixture `planningMs` in the JSON file).

## Reproducible commands

```bash
npm install
npm test
npm run benchmark
node bench/holdout.js
node --input-type=module -e "import('./src/browser-benchmark.js').then(async x => console.log(JSON.stringify(await x.runBrowserComparison({fixtureId:'signup',budget:12}),null,2)))"
```

`npm test` currently tests 42 cases including existing QA features, algebraic planner checks, real Chromium exercise, approximate Ochiai ranking, bounded ddmin and independent fixture benchmark.

## Explicit limitations

1. Does **not** establish complete Vue/React responsive dataflow or precise causal source line localization.
2. Does **not** prove business correctness without independent requirements and approved test oracles.
3. Does **not** infer the full UI state graph or automatically execute all state transitions.
4. Synthetic fault triggers are selected for controllability, not real-world prevalence; real project performance may be much lower.
5. No production front-end application, multi-browser matrix, or live installed DSH plugin end-to-end acceptance has been completed.
6. The 100% metric above is a **single fixed synthetic set**, absolutely not a claim of 100% true defect detection or human engineer replacement.

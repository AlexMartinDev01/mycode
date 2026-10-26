# Verification record — v0.5.0

Environment: container Node.js v22.16.0; headless Chromium `/usr/bin/chromium`; TypeScript and PostCSS provided from local global installation. The DSH distribution itself was **not installed or exercised** here. Production DSH requires Node.js >=22.19.0 per package metadata.

## Commands and observed evidence

- `node --test test/*.test.js`: **61 passed, 0 failed** (final suite; also rerun after changes in the authoring environment).
- `node bench/stress-v0.5.0.js`: 1,000 deterministic seeds, 9,666 generated synthetic combinations, 49,750/49,750 feasible pair incidences, **zero** invalid forbidden combinations, duplicates, or inconsistent counts. Limited factor domains and configured budget — not universal pairwise guarantees.
- `node bench/run.js --output bench/results-v0.5.0.json`: original five synthetic benchmarks reproduced: baseline 17/20 fault trigger coverage and 50.85% feasible pair coverage; algorithm 20/20 and 91.30%.
- `node bench/holdout.js`: original 20 seeded holdout runs reproduced: baseline 206/400 synthetic fault triggers versus algorithm 356/400. These cases reuse the same synthetic fixture families, and only the algorithm gets constraint information.

## Browser tests (real Chromium, custom CDP, in-memory document)

- 24 arithmetic × quantity × discount cases: 12/12 injected arithmetic mutations detected; 12/12 unmutated control scenarios passed. These are a deliberately designed family; equivalent mutants and unknown defect categories are **not** addressed.
- Native keyboard interaction for dropdown selection and real DOM change events.
- Delayed asynchronous updates and stability-window regression (avoids erroneously passing on the previous valid value).
- Partial control obstruction and fully blocking overlay; disabled input refusal.
- Responsive layout overflow at 380px and absence at 900px, plus overlay hit-testing.
- External network resource blocked by CDP interception in default localhost-only mode.
- Network observations reset between combination cases; contract results do not carry stale response evidence.
- Independent functional and layout assertions; DOM state tracing including sensitive input redaction.
- Isolated Chromium profiles have non-shared application state.
- End-to-end report JSON/Markdown creation with explicit known FAIL and responsive visual warning.
- 120 seeded constrained planner property tests in unit-test suite; 1000 seeds in standalone stress script.

## Major fixed risks

1. The previous browser driver only validated URLs provided to explicit navigation calls. v0.5 intercepts browser requests (including subresources) at the CDP Fetch domain and blocks external targets unless external access was explicitly granted at driver start. This is not a proof of network sandboxing at the OS layer.
2. An expectation could falsely pass using an old DOM value before an asynchronous incorrect update. `expectEventually` now requires a sustained successful assertion and supports an optional independent settle condition.
3. Existing case-local network logs could incorrectly satisfy the next case's API assertion. Case observations now reset before every combination case.
4. A small overlay crossing a clickable element's center could trigger a false blocked result even though other points were usable. Click targeting samples five visible points.
5. Select fields with `first-available-option` were previously skipped; now the driver uses trusted keyboard events to select values where Chromium supports native selection.

## Remaining important limits

- DSH host plugin loading and pnpm bundle installation have not been tested in the user's installed DSH version.
- Browser navigation to even `127.0.0.1` is blocked by container policy (`ERR_BLOCKED_BY_ADMINISTRATOR`). Real DOM and input tests use `Page.setDocumentContent`; no full production site navigation was tested.
- No verified arbitrary Vue/React runtime dataflow, automatic business oracle derivation, full shadow DOM/iframe exploration, Firefox/Safari compatibility, or causal proof of a unique defect source line.
- `traceInteraction` proves only runtime changes; source-line candidates remain `NOT_CONFIRMED` without an independent causal experiment.
- This suite is not a calibrated measure of false negatives on natural real-world bug corpora. No system can guarantee detection of all unknown bugs.

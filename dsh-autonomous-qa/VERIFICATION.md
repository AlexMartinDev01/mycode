# v0.2.0 validation record — 2026-10-25

## Commands and outcome

Executed in sandbox: `npm test` (Node v22.16.0, system Chromium with sandbox-managed URL policy).

**23 passed; 0 failed**, including all 11 previous checks and 12 new checks. This is a test-suite result, NOT full application coverage or DSH host acceptance.

## New exercised scenarios

- Bounded cross-module direct-function call path: `src/app.js` → `src/state.js` → `src/pricing.js` and source line evidence.
- Renamed TypeScript imports and `tsconfig.json` path aliases.
- Vue SFC `<script setup>` function lines and intra-file direct calls.
- Real Chromium in-memory DOM: independent multiplication rule exposes wrong 103 vs expected 300 and passes after simulated correction.
- Missing value yields `UNKNOWN` (not false PASS); unsupported math op fails closed.
- DOM attribute/count assertions, network-observation assertion with known recorded evidence.
- Cross-file source candidate path explicitly marked `NOT_CONFIRMED`.
- CSS overlay selector mapped to original stylesheet declaration line candidate.
- Real Chromium geometry contract detects overlap and emits CSS evidence.
- Real engine `runScenario` from in-memory HTML: 2 assertions FAIL, visual issue SUSPECT, report artifacts emitted. Expected failing known-defect scenarios count as passing detector tests.
- Browser session policy blocks a step-level attempt to enable external browsing.

## Explicit gaps

- Browser/DSH installed host integration has NOT been exercised. The tool-registration smoke test uses a mocked DSH host.
- Chromium has an enforced URLBlocklist in this environment; in-memory `Page.setDocumentContent` is used for positive browser integration. Live localhost navigation remains unverified and the navigation failure path is tested.
- A direct-call semantic index is not whole-program dataflow, asynchronous side-effect analysis, or proof of a uniquely causal root line.
- Visual heuristic issues require independent expected layout/design rules. No complete pixel-accurate Figma or semantic aesthetic oracle.
- No standalone Firefox/Safari, enterprise safety boundary, 100% defect detection, or guaranteed human tester replacement.

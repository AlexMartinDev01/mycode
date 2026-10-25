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

## v0.3.0 (2026-10-25) — new tag-combination checks

`npm test`: **34 passed, 0 failed** in local isolated environment. In addition to the original 24 checks:
- Vue template nesting, exact source lines, `v-model`/`v-if`/`v-show`/event indexing and an imported handler link.
- React JSX conditional ancestors, events, component import edges and source positions.
- HTML tag tokenization with quoted `>` content and exclusion of raw script content.
- Deterministic pairwise input/action-state combinations with explicit NOT_TESTED/UNKNOWN oracles.
- Authorized disposable environment and localhost-only policy; no independent oracle causes UNKNOWN rather than a false PASS.
- Real Chromium in-memory form testing generated input combinations and identifying a deliberately wrong addition-versus-multiplication business calculation.
- Action-only buttons, Vue nested `<template>` blocks, and assertion-injection rejection.
- Real Chromium action-only click combinations find an incorrect hidden-panel transition while also checking layout.

**Not tested:** actual DSH installation, live localhost-navigation suite, exhaustive JSX/Vue syntactic dialects, complete cross-file reactive dataflow, full state-machine coverage, 100% defect detection, or causal proof of unique defective source lines.

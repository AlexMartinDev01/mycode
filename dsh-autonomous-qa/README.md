# DSH Autonomous Frontend QA — v0.5.0 (experimental)

**A working DSH tool plugin + standalone QA engine.** Static source indexing, bounded cross-file direct-call graph, native Chromium CDP browser input, independent function assertions, DOM/CSS geometry checks, visual PNG-baseline diff and auditable reports. No Playwright, Puppeteer or Selenium runtime dependency.

> **Not a 100% QA engineer replacement.** It does not infer arbitrary business requirements reliably, cannot guarantee all bugs are found, and cannot always identify the one causal source line. Candidate code locations have an explicit `NOT_CONFIRMED` status. The DSH host plugin integration requires testing in your installed DSH profile; local automated tests cover the engine and plugin registration contract with stubs.

## Requirements

- Node.js >=22.19.0, `pnpm` recommended for DSH plugin installation
- Chromium available (`CHROMIUM_PATH` or `--chromium`)
- DSH compatible with `@deepseek-ai/dsh-tools` `defineTool` and `ctx.tools.register`
- A separate, disposable test environment and approved API contract/spec for assertions

## Installation from standalone plugin directory

This directory has its own `package.json` and `cordis.patch.yml`. For example, from a clone containing this directory:

```bash
cd dsh-autonomous-qa
npm install
# In the same directory, install into the DSH web profile:
dsh plugin --profile web add "link:$(pwd)"
# Restart DSH web afterward.
dsh web --dump-config | grep autonomous-frontend-qa
```

If you installed the package through a DSH bundle command, restart the `web` profile to activate it. You can also use the official development-mode `--patch` flow with `cordis.patch.yml` when operating inside a checked-out Harness repo.

**Connection to current GitHub delivery:** If the plugin lives in a folder of another repository (rather than at repo root), clone the repository and install the local folder as above. Do not use the plain `github:owner/repository#branch` bundle source for a plugin stored inside a subfolder without a supported subdirectory packaging mechanism.

## v0.5 hardening and traceability

- **Network guard:** a direct CDP Fetch interception layer blocks external document/subresource requests by default, even when initiated by page code. This does **not** replace an OS firewall or fully guarantee network isolation.
- **Reliable clicks:** five hit-tested visible points reduce false obstruction reports from partially covered elements. Disabled controls remain blocked.
- **Native select:** CDP keyboard events now support `selectOption` and generated combinations containing dropdown choices.
- **Asynchronous oracle:** `expectEventually` waits until an independent assertion is stable for `stableForMs` (default 150 ms); optionally specify `settleWhen:{selector:"#loading",visible:false}` to wait for application readiness.
- **State evidence:** new `frontend_qa_trace_interaction` runs a test-environment-authorized click/fill/select and returns before/after DOM, styles, network/console evidence and optional independent assertions. It does not prove root-cause lines.
- **Case isolation:** previously observed network responses are cleared for each combined test case.
- **Stress:** 61 unit/integration checks; a separate 1,000-seed/9,666-scenario constrained planner stress run. See `VERIFICATION.md` and `bench/stress-results-v0.5.0.json`. Most tests use synthetic fixtures; no claims of universal bug detection or complete QA engineer replacement.

Examples:

```json
{"action":"expectEventually","timeoutMs":3000,"stableForMs":200,"settleWhen":{"selector":"#loading","visible":false},"assertion":{"action":"expectText","selector":"#status","equals":"Saved"}}
```

The interaction trace plugin tool requires `acknowledgeDisposableEnvironment:true`, `session`, and `configJson` such as `{"action":"click","selector":"#submit","observeSelectors":["#status"],"assertions":[{"action":"expectText","selector":"#status","equals":"Done"}]}`.

**DSH host loading remains unverified**; registration contract tests use a stub host. Native selection is supported for single-selection `<select>` but not all custom dropdowns.

## v0.4 algorithmic mode and controlled comparison

The legacy `frontend_qa_plan_combinations` and `frontend_qa_test_combinations` remain the control strategy (`strategy: "baseline"`).

The new `frontend_qa_plan_algorithmic` implements bounded **constraint-aware weighted pairwise covering** (greedy set-cover, **not full IPOG**). Supply forbidden state patterns by group, for example `{"src/Panel.vue#page":[{"when":{"#consent":"unchecked","#submit":"activate"}}]}`. The testing tool now accepts `strategy:"algorithm"`, `constraintsJson`, and `seed` to **actually execute** the algorithmic scenarios; the same independent `rulesJson` contract is required.

New DSH tools:

- `frontend_qa_plan_algorithmic` — algorithmic input/tag combinations with explicit constraints, coverage and lines.
- `frontend_qa_plan_model_paths` — BFS shortest state transition paths from an independently validated model.
- `frontend_qa_rank_fault_candidates` — Ochiai scoring from actual pass/fail execution line coverage; statistical ranking only, **not root-cause proof**.
- `frontend_qa_compare_algorithms` — safe offline baseline/algorithm A/B benchmark on bundled **synthetic** faults, NOT real project effectiveness.

Library functions `minimizeFailingSequence` (bounded ddmin) and `rankFaultCandidates` can be consumed programmatically; ddmin is not yet exposed as autonomous DSH repair and requires an external reproducible failure predicate. Model-based paths are not yet automatically inferred or executed by the planner.

Commands:

```bash
npm test
npm run benchmark
node bench/holdout.js
```

Saved reproducible data and methodology: `BENCHMARK_REPORT.md`, `bench/results-v0.4.0.json`, `bench/holdout-results-v0.4.0.json`, `bench/browser-results-v0.4.0.json`.

**Comparability limits:** same case budget per fixture; v0.3 control uses a greedy heuristic too, so “without algorithm” means **without the NEW algorithms**, not literally algorithm-free. Constraint knowledge is supplied only to the enhanced strategy because v0.3 has no contract constraints. Offline fault triggers are synthetic, not proof of full QA engineer replacement or accuracy on production bugs.

## Tools exposed to DSH

| Tool | Purpose |
|---|---|
| `frontend_qa_scan` | Scan sources and collect project-level direct-call links, event/CSS references, with original line positions |
| `frontend_qa_trace` | Trace statically resolved calls from a source-file/symbol pair (bounded, incomplete by design) |
| `frontend_qa_start_browser` | Start own Chromium/CDP controller and return handle |
| `frontend_qa_action` | Deterministic navigate/click/fill/inspect/assert/screenshot/CSS trace actions |
| `frontend_qa_visual_audit` | Find obstructed controls, overflow, clipping, broken images, low-contrast candidates |
| `frontend_qa_explore` | Discover interactive controls and optionally execute bounded low-risk interactions in authorized disposable environment |
| `frontend_qa_close_browser` | Free Chromium resources |
| `frontend_qa_trace_interaction` | Capture before/after DOM and runtime evidence with independent assertions for one explicitly authorized action |
| `frontend_qa_run_suite` | Source scan + sequential browser actions + visual audit + JSON/Markdown report |

Sample DSH flow:

1. Call `frontend_qa_scan` with the authorized front-end root path. Review its unresolved imports and component graph.
2. Ask DSH to create assertions from an **independent requirement/spec**, not from current implementation.
3. Call `frontend_qa_start_browser` and record the returned `session`.
4. Call `frontend_qa_action` with `stepJson`: `{"action":"navigate","url":"http://localhost:5173"}` followed by `{"action":"click","selector":"#submit"}`, `{"action":"expectText","selector":"#result","equals":"Success"}`.
5. Call `frontend_qa_visual_audit` with `cssEvidence:true` and use `frontend_qa_action` with `{"action":"css","selector":"#result"}` for extra CSS evidence.
6. Optionally call `frontend_qa_explore` with `executeSafeClicks:false` for safe discovery; execution requires explicit `acknowledgeTestEnvironment:true`.
7. Close with `frontend_qa_close_browser`.

This plugin exposes tools to the DSH reasoning loop; it does **not** invent correct expected values and does not directly replace the DSH model's reasoning. It can also run a repeatable spec in one call.

## Standalone CLI

```bash
npm install
node src/cli.js scan --project /path/to/frontend --out /tmp/scan.json
node src/cli.js run --project /path/to/frontend --spec examples/qa.spec.json --out /tmp/qa-report
```

Start your front-end test server yourself (e.g. `npm run dev -- --host 127.0.0.1`) and point the spec's `url` at it. **Browser navigation defaults to localhost-only**. External targets require explicit `allowExternal: true`. Avoid destructive test accounts/actions.

The optional `viewports` spec field accepts up to 12 `{width,height}` objects and performs responsive visual audits at each size after the functional steps. This is geometry-based responsive probing, not a cross-browser visual oracle.

Supported spec steps: `navigate`, `viewport`, `click`, `fill`, `selectOption`, `expectEventually`, `wait`, `inspect`, `expectText`, `expectValue`, `expectVisible`, `expectUrl`, `expectStyle`, `expectNumber`, `expectDerived`, `expectLayout`, `expectAttribute`, `expectCount`, `expectNetwork`, `css`, `visual`, `screenshot`, `visualBaseline`. `visualBaseline` needs a previously reviewed PNG baseline, captured at identical viewport, DPR, fonts, animations and data state. It measures changed pixels, not semantic intent.

Test reports live in output directory (`report.json`, `report.md`) with explicit PASS, FAIL, SUSPECT and UNKNOWN statuses. `codeCandidates` contains only potentially relevant lines; it never claims they are the confirmed root cause.

## Test

```bash
npm test
```

42 tests include bounded cross-file named-function linkage, path aliases, Vue line preservation, independent derived business formulas and layout assertions, fixture cross-file imports, Chromium mouse and keyboard interaction, calculation defect detection, overlay obstruction, CSS trace, screenshot regression, safety guards and report generation. **Note:** the isolated CI-like environment where this project was initially built includes a forced Chromium policy `URLBlocklist:["*"]`; therefore in-browser tests inject HTML into `about:blank` and the URL navigation integration test verifies truthful fatal-error reporting. Full localhost navigation and actual plugin loading must be checked on a normal DSH installation.

## Current limitations / next engineering stages

- Import graph and directly resolvable imported-function calls are implemented, including named import aliases and TS path mappings. **Full interprocedural dataflow/taint/alias analysis is not**; Vue template support is heuristic and AST diagnostics do not prove semantic correctness.
- Visual diagnostics cover a subset of geometry and contrast checks; responsive matrix and auto-discovery of all interaction states are **not** yet implemented.
- CSS matched rule positions may refer to compiled or inline resources, not original source. `codeCandidates` is a conservative approximate source index, **not proven root cause**.
- Visual baseline matching is pixel diff, susceptible to animation and font nondeterminism. No Figma comparison or model-based aesthetic oracle.
- Real back-end assertions require externally supplied API contract and safe test data.
- Only Chromium CDP browser engine is implemented; no Firefox/WebKit.
- No auto-fix, mutation-testing campaign, CI integration, code coverage instrumentation or full production-ready security sandbox.
- Plugin registration uses documented DSH interface, but it has not yet been loaded into a live DSH process in this workspace.

## Development direction

Prioritize formal component-to-state dependency mapping, DSH-managed business oracles, deterministic visual state/viewport matrix, sourcemap-enabled original line lookup, causal verification via controlled patches, a reproducible blind mutation benchmark, host integration tests, and authenticated environment safety policy.

## Security

The scanner excludes symlink traversal, `.env` files, `node_modules`, and generated directories. Browser execution defaults to local HTTP(S) addresses. The browser driver launches an isolated temporary profile and removes it on close. Browsing arbitrary test web pages remains security-sensitive; only execute trusted targets in a disposable workspace. A model calling arbitrary selectors/actions should use the DSH permissions policy.

## v0.2.0 verified improvements (2026-10-25)

- New `src/semantic.js` builds a **bounded, direct function-call link graph** with source-file and line evidence across modules. Supports TS/JS aliases, basic Vue `<script setup>` and module-level callers. The graph explicitly reports incomplete resolution, not complete state/dataflow analysis.
- New `frontend_qa_trace` lets DSH inspect the graph for a specific file + function, without reading the entire model-facing project index.
- New **independent derived oracle** step: `expectDerived`, with an approved calculation contract (`add`, `subtract`, `multiply`, `divide`, `min`, `max`). A missing operand returns `UNKNOWN`, not PASS. `factor`, `offset`, and `tolerance` are optional.
- New `expectLayout` checks declared width/height, viewport inclusion, relative overlap/alignment and attaches matched live CSS rules on failures. Layout checks are only as valid as the independent contract.
- Added `expectNetwork` (request method/status), `expectAttribute`, and `expectCount`. Network evidence is recorded only when the browser actually observed it.
- Better candidate-file correlation uses resolvable call links and keeps `NOT_CONFIRMED` until an independent causal test is performed.
- A test-step `allowExternal:true` cannot bypass a browser session that forbids external URLs. **Redirect-level network policy remains outside this release's guarantees; use a disposable environment.**
- Successful end-to-end **in-memory Chromium page** scenario asserts two known defect types (bad total and overlay) and writes report files; this environment still blocks an actual localhost web server navigation.

### Example independently defined checks

```json
{
  "steps": [
    {"action":"click","selector":"#buy"},
    {"action":"expectDerived","selector":"#total","operation":"multiply","inputs":[{"selector":"#unit-price","from":"text"},{"selector":"#quantity"}],"tolerance":0.01},
    {"action":"expectLayout","selector":"#buy","relativeTo":"#footer","mustNotOverlap":true},
    {"action":"expectNetwork","urlIncludes":"/api/orders","httpMethod":"POST","status":201}
  ],
  "viewports":[{"width":375,"height":812},{"width":768,"height":1024},{"width":1365,"height":768}]
}
```

All assertion examples require independently reviewed business/design contracts. The tool must not deduce that a calculator's implemented formula is a correct requirement.

### Not yet implemented

- Full React/Vue reactive state, callbacks, async effects and API dataflow; causal line-confirmation using controlled fault isolation.
- Design-intent judgment without approved baselines, screenshot semantics, and native Firefox/WebKit browser support.
- Running live DSH inside this environment and successful real localhost navigation; users must verify loading in their installation.
- Production hardening including hostile navigation/redirect network interception, encrypted secret handling, high-scale test scheduling and comprehensive mutation/holdout evaluation.

See `VERIFICATION.md` for the exact executed test scope and environment restrictions.

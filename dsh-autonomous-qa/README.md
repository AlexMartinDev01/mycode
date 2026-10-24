# DSH Autonomous Frontend QA — v0.1.0 (experimental)

**A working DSH tool plugin + standalone QA engine.** Static source indexing, cross-file import graph, native Chromium CDP browser input, independent function assertions, DOM/CSS geometry checks, visual PNG-baseline diff and auditable reports. No Playwright, Puppeteer or Selenium runtime dependency.

> **Not a 100% QA engineer replacement.** It does not infer business requirements reliably, cannot guarantee all bugs are found, and cannot always identify the one causal source line. Candidate code locations have an explicit `NOT_CONFIRMED` status. The DSH host plugin integration requires testing in your installed DSH profile; local automated tests cover the engine and plugin registration contract with stubs.

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

## Tools exposed to DSH

| Tool | Purpose |
|---|---|
| `frontend_qa_scan` | Scan sources, graph imports/functions/events/CSS rules, return source line positions |
| `frontend_qa_start_browser` | Start own Chromium/CDP controller and return handle |
| `frontend_qa_action` | Deterministic navigate/click/fill/inspect/assert/screenshot/CSS trace actions |
| `frontend_qa_visual_audit` | Find obstructed controls, overflow, clipping, broken images, low-contrast candidates |
| `frontend_qa_close_browser` | Free Chromium resources |
| `frontend_qa_run_suite` | Source scan + sequential browser actions + visual audit + JSON/Markdown report |

Sample DSH flow:

1. Call `frontend_qa_scan` with the authorized front-end root path. Review its unresolved imports and component graph.
2. Ask DSH to create assertions from an **independent requirement/spec**, not from current implementation.
3. Call `frontend_qa_start_browser` and record the returned `session`.
4. Call `frontend_qa_action` with `stepJson`: `{"action":"navigate","url":"http://localhost:5173"}` followed by `{"action":"click","selector":"#submit"}`, `{"action":"expectText","selector":"#result","equals":"Success"}`.
5. Call `frontend_qa_visual_audit` with `cssEvidence:true` and use `frontend_qa_action` with `{"action":"css","selector":"#result"}` for extra CSS evidence.
6. Close with `frontend_qa_close_browser`.

This plugin exposes tools to the DSH reasoning loop; it does **not** invent correct expected values and does not directly replace the DSH model's reasoning. It can also run a repeatable spec in one call.

## Standalone CLI

```bash
npm install
node src/cli.js scan --project /path/to/frontend --out /tmp/scan.json
node src/cli.js run --project /path/to/frontend --spec examples/qa.spec.json --out /tmp/qa-report
```

Start your front-end test server yourself (e.g. `npm run dev -- --host 127.0.0.1`) and point the spec's `url` at it. **Browser navigation defaults to localhost-only**. External targets require explicit `allowExternal: true`. Avoid destructive test accounts/actions.

Supported spec steps: `navigate`, `viewport`, `click`, `fill`, `wait`, `inspect`, `expectText`, `expectValue`, `expectVisible`, `expectUrl`, `expectStyle`, `expectNumber`, `css`, `visual`, `screenshot`, `visualBaseline`. `visualBaseline` needs a previously reviewed PNG baseline, captured at identical viewport, DPR, fonts, animations and data state. It measures changed pixels, not semantic intent.

Test reports live in output directory (`report.json`, `report.md`) with explicit PASS, FAIL, SUSPECT and UNKNOWN statuses. `codeCandidates` contains only potentially relevant lines; it never claims they are the confirmed root cause.

## Test

```bash
npm test
```

Tests include fixture cross-file imports, Chromium mouse and keyboard interaction, calculation defect detection, overlay obstruction, CSS trace, screenshot regression, safety guards and report generation. **Note:** the isolated CI-like environment where this project was initially built includes a forced Chromium policy `URLBlocklist:["*"]`; therefore in-browser tests inject HTML into `about:blank` and the URL navigation integration test verifies truthful fatal-error reporting. Full localhost navigation and actual plugin loading must be checked on a normal DSH installation.

## Current limitations / next engineering stages

- Import graph and intra-file function symbol collection are implemented. **Full interprocedural dataflow/taint/alias analysis is not**; Vue template support is heuristic and AST diagnostics do not prove semantic correctness.
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

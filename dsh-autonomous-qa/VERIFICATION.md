# Verification record — 2026-10-25

## Scope

This is an experimental DSH plugin implementation, not an audited full QA replacement. All claims below refer to the specific automated checks run in the isolated authoring environment.

## Command

`node --test test/engine.test.js`

Result: **11 passed, 0 failed** (final run).

Validated tests:
1. All test fixture files indexed, cross-file imports traced with source lines.
2. Scanner skips symlinks and outside files.
3. Browser navigation rejects non-local URLs by default.
4. Real Chromium CDP keyboard and mouse interactions detect deliberately wrong total (103 instead of 300) involving three modules.
5. CDP hit testing flags intentionally obstructed button and retrieves matching CSS rules.
6. Screenshot pixel comparison distinguishes an unchanged render from a color change.
7. Test runner produces JSON and Markdown evidence and truthfully records browser-policy navigation failure.
8. Candidate original code locations are presented as **NOT_CONFIRMED** rather than proven root causes.
9. DSH plugin tool registrations invoke correctly under a mocked tool registry (`defineTool` stub), **not** under a live DSH host.
10. Bounded autonomous control discovery does not equate untested controls with PASS.
11. Responsive probe flags overflow at narrow viewport. During development, this test uncovered a detector bug: `window.innerWidth` can reflect horizontal overflow; detector was corrected to use `document.documentElement.clientWidth`.

## Environment caveat

This environment's managed Chromium has the enforced policy `URLBlocklist: ["*"]` even for localhost. Direct navigation was blocked (`net::ERR_BLOCKED_BY_ADMINISTRATOR`), so real-browser interaction tests inject fixtures with CDP `Page.setDocumentContent` into `about:blank`. Therefore a complete external/local running front-end project navigation test has **not** passed here. No live DSH host binary or production compatibility check was available.

## Explicitly not verified

- Startup and registration in a user-installed DSH runtime; supported DSH version interval.
- Real Vue/React app with bundler, sourcemaps and live API.
- Exact causal original-code line attribution; current output is candidate locations and matched browser CSS rules.
- Complete business correctness without independent specifications and API oracle.
- Full interactive state-machine coverage, dangerous control handling, auth, persistence.
- Cross-browser (Firefox and Safari), automated screenshot baselines for all states, Figma comparison.
- Large project scaling, flaky behavior, false-positive rates and independent blind mutation benchmark.

A comprehensive QA replacement would require a separate benchmark and production-shape integration tests before an availability claim.

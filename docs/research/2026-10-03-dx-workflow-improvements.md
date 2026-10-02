# Developer workflow DX improvements — 2026-10-03

This pass followed the completed runtime/lifecycle audit and focused on setup,
first invocation, actionable diagnostics and integration into an existing app.
The user authorized implementing concrete improvements as they were found.
Earlier dirty work and the 2026-10-02 receipts were preserved.

## Problems reproduced and fixed

| Workflow                     | Before                                                                                             | After                                                                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node executable selection    | Relative candidates and inferred Cargo paths used the parent cwd, although the child ran elsewhere | Selection follows string or file-URL child cwd; candidates are absolute, bare explicit PATH commands remain valid, and errors list checked paths                                  |
| Bun FFI on Node              | First invocation exposed ERR_UNSUPPORTED_ESM_URL_SCHEME for bun:ffi                                | Structured transport.unavailable explains using Bun or @rustra/node and preserves the original cause; imports and JSON-only use remain Node-safe                                  |
| RN first typed invocation    | A partial native binding could become ready, then fail with raw native.invokeFrame TypeError       | The chosen engine validates its required invokeFrame/invoke function before construction/readiness and reports native.incompatible with regeneration/rebuild/install instructions |
| RN contract failure handling | Bootstrap wrapped RustraCommandError in generic Error, hiding code and metadata                    | Original typed error, code, cause, frameBytes and requestId survive; ownership/disposal checks still take precedence                                                              |
| Existing Tauri app commands  | Adding Rustra registration or a second invoke_handler replaced the other handler                   | New rustra::tauri_support::with_app_commands composes the six production endpoints and app commands while retaining selected state, events and channels                           |
| Tauri registration mistakes  | Missing contract endpoint produced a generic rebuild hint                                          | Exact native missing-endpoint rejection names the endpoint, registration helper, invoke_handler replacement and composition repair; original cause survives                       |
| Doctor prerequisites         | Pure Node/Bun apps failed on missing C++/CMake; any installed JS version passed                    | C++ is required for RN/explicit cppOutput, CMake for RN; supported runtime versions are checked, and Bun FFI requires Bun independently                                           |

The Node process adapter supports Node 18+ **or Bun 1.4+**. A Node config does not
require a separate Node executable when the app runs under Bun. The initial
doctor implementation in this pass was too strict; independent review reproduced
the valid Bun-only workflow and the implementation/tests/docs were corrected
before completion. Generated Bun FFI requires Bun 1.4+.

The Tauri composer is the final handler installation after register,
register_with_events or register_dispatch. Reserved production endpoints take
precedence over app commands. The benchmark-only rustra_dispatch_profiled remains
unavailable even when an app handler would claim that name. Profiling registration
keeps its separate existing workflow.

## Verification

- Node: 92 native Node tests passed, including actual executable calls with child
  cwd strings, file URLs, spaces and explicit PATH commands.
- Bun: 65 tests passed, including a bundled current-source client executed in a
  real Node child for both FFI failure diagnostics and working JSON-only use.
- RN: 89 tests passed under both Bun and compiled Node. Seven targeted regressions
  went red to green; the original setup scenario and typed addNumbers(20,22)=42
  passed through the current adapter with a controlled legacy Frame peer.
- Tauri: 68 JS tests and 31 native MockRuntime IPC tests passed. Three new native
  tests verify app/Rustra coexistence, event push, all reserved endpoints,
  profiling exclusion and the selected custom producer. Independent review found
  no material issue and separately checked four startup/error cases.
- Doctor: 39 tests passed. Initial missing-tool/unsupported-version regressions
  went red to green. Sync/async checks agree and skip unneeded native probes.
- An actual generated persistent CRUD app passed with Node absent from PATH and
  Bun available. The actual CLI doctor also passed under that environment and
  reported Bun as the Node adapter runtime, with C++/CMake skipped.
- Full CLI: 432 Node tests plus 45 Bun tests passed.
- All workspace package builds, RN packed consumer, full fresh onboarding journey,
  API declaration snapshot, architecture, inventory, docs and formatting passed.
  Lint has zero errors and seven inherited warnings.

The API snapshot was intentionally updated for the additive Tauri helper and its
associated Rust declarations. Examples and English/Korean setup documentation
describe command composition, path resolution and runtime/tool prerequisites.

## Evidence and scope

[Validation receipt](../benchmark-receipts/2026-10-03-dx-workflow-validation.json)
records the current source hash, files changed since the first audit, exact log
hashes and the direct Bun-only acceptance observations. Raw logs remain in /tmp
and /private/tmp under rustra-dx2, rustra-node-cwd-dx, rustra-bun-setup-dx,
rustra-rn-dx-20261003 and rustra-tauri-dx prefixes.

This pass makes no new latency/speedup claim. Its native Tauri evidence uses
MockRuntime IPC; it does not certify GUI/mobile device behavior. RN changes are
JS diagnostics and engine construction; no native platform or device execution
was added. Earlier ASan/device/performance evidence boundaries remain recorded
in the separate 2026-10-02 audit. No commit, push, registry publication or device
modification was performed.

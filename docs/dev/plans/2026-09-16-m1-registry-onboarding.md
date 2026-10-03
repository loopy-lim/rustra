# M1 Registry Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Public npm/crates.io packages must complete a reproducible first-call, contract-change, upgrade and rollback cycle without workspace dependency injection.

**Architecture:** Keep the existing pre-publication onboarding gate. Add a separate post-publication gate that installs exact versions into a new temporary consumer, executes the published CLI and actual host calls, and records version/source/lock/artifact evidence. Failures retain logs and return nonzero. Automatable evidence remains distinct from external evaluator and mobile/GUI acceptance.

**Tech Stack:** Node 22 (fnm), Bun 1.4, Rust/Cargo, npm lockfiles, node:test, GitHub Actions.

**Spec:** `docs/specs/2026-09-14-rustra-roadmap.md`, A1-A5/G1 and evidence rules in section 6.

## Global Constraints

- No new host or wire change; no changes to other consumer repositories. The discovered CLI fix adds only an optional `InitHosts.nodeRange` rendering option, preserving existing calls and deliberately updating the API snapshot.
- Install exact public package versions. Published CLI canonical caret manifest specifications are allowed only with exact install arguments, a frozen lockfile and exact installed-version/source checks at every phase; literal exact manifest strings remain a separately tested CLI compatibility case. No Cargo patch, Git/path dependencies, package overrides, symlinks to the workspace or copied Rustra sources.
- Preserve independent npm versions; a Rust-only patch upgrade is identified as such.
- Never count a Bun process using the Node adapter as Bun FFI evidence.
- G1 requires five evaluators and Tauri/RN evidence; this automated cycle alone cannot close G1.
- G2 requires two actual consumers, four weeks of use, two successive upgrades, mobile physical devices, 100 lifecycle repeats and two hours per configuration; no synthetic substitution.
- Keep existing untracked Tauri generation and `.zcode` state untouched. Worktree: `.worktrees/m1-registry-onboarding`, base `1f277de2e68e2242b7a6503e6e0ab731833e60e3`.
- Do not publish, contact evaluators, merge or push while preparing this local candidate.

## Task 1: Executable public registry consumer gate

**Files:** Create `scripts/registry-consumer-gate.mjs`, `scripts/registry-consumer-gate.test.mjs`; helper fixture/provenance modules under `scripts/registry-consumer/` if necessary. Modify `scripts/onboarding-gate.mjs` and tests only for failure propagation and reusable exported pure helpers.

**Interfaces:** CLI `node scripts/registry-consumer-gate.mjs --output /absolute/receipt.json` writes a JSON receipt on both success and failure, prints paths, returns 1 on failure. Exact version configuration comes from a checked-in JSON manifest or validated explicit arguments, with baseline Rust 0.10.0 and candidate Rust 0.10.1, published Node/Bun/types/CLI 0.10.0. Report schema must identify actual host/adapter, steps, timings, installed versions, registry sources, lockfile and generated/native artifact hashes, failure diagnostics and raw log paths.

- [x] Write node:test cases for contamination (path/git/patch/override/workspace/symlink), resolved version mismatch, abort-on-first-error, output verification and receipt retention. Use real temporary files and child processes where feasible; fake only expensive registry/build boundaries.
- [x] Run `node --test scripts/registry-consumer-gate.test.mjs` and capture the expected failure before implementation.
- [x] Implement isolated installation and exact installed-source checks using npm package-lock data and Cargo metadata/lockfiles. Preserve the root consumer exception while rejecting external source overrides. Reject unknown/malformed options and unpinned package versions.
- [x] Execute published CLI init, dependency installation, doctor, build, codegen, original demo, `--check`, field addition using the existing onboarding mutation helper, regeneration, rebuild and assertion of the returned added field.
- [x] Execute actual Node stdio and Bun FFI calls. If a fixture is needed to add a cdylib or domain error, clearly distinguish scaffold success from extended fixture success; keep Rustra source external. Add domain-error and event/unsubscribe verification when feasible through existing public contracts, and accurately report any excluded journey segment.
- [x] Run baseline → candidate → rollback with exact installed Cargo/npm versions at each phase. Preserve mutated contract between phases, regenerate/build and invoke each phase, and compare rollback contract/output to baseline. A Rust patch cycle is not evidence of two successive full product upgrades.
- [x] Fix the existing hidden preparation failure only after reproducing it through `runOnboardingSteps`; runner exceptions and nonzero exits with empty output must fail reliably.
- [x] Run the relevant unit tests; provide a concise self-review and test commands. Do not commit other contributors' changes.

## Task 2: Integration, live evidence and roadmap handoff

**Files:** Modify `package.json`, `.github/workflows/ci.yml`; create `.github/workflows/registry-consumer.yml`, EN/KO registry onboarding instructions and `docs/verification/2026-09-16-roadmap-status.md`; add compact evidence JSON under `docs/verification/evidence/`.

- [x] Add `test:registry-consumer` (offline regressions) and `verify:consumer:registry` (network/native cycle). Run offline tests in existing CI. Add a read-only, manually dispatched workflow with always-uploaded receipts; do not dispatch or publish from this task.
- [x] Run the public-registry gate in a clean temporary consumer with task-owned writable caches. Inspect actual host results, phase pins, contract change and rollback equality, and source contamination checks.
- [x] Verify existing onboarding and release tools, relevant builds, documentation gates and diff checks. Preserve failure logs and disclose sandbox/host limits separately from product defects.
- [x] Record current G0-G4 status, remaining criteria, required user/device/evaluator inputs, ordered execution steps and a concrete next action. Link current main CI/release evidence and this candidate's local evidence separately.
- [x] Review the complete candidate before the final user handoff; present remaining publication/real-project authorization only against this concrete result.

## Task 3: Fix published-CLI dependency pin incompatibility

Live public CLI 0.10.0 rejected an exact compatible `@rustra/types=0.10.0` manifest because it compared that string to `^0.10.0`. Its use of the CLI version for all adapters also conflicts with independent adapter versions and CLI-only patches.

**Files:** `packages/cli/src/dependencies.ts` and new tests; CLI runtime/init/generate call sites and package template metadata; `scripts/version-packages.mjs` and `scripts/check-release-coherence.mjs` with tests; CLI patch changeset.

- [x] Reproduce exact compatible pins being rejected and independent host defaults being absent through failing tests.
- [x] Preserve exact stable compatible pins; reject incompatible pins and arbitrary ranges without rewriting the consumer manifest.
- [x] Use explicit independently versioned host defaults, including Node init templates, and synchronize/check them during version preparation.
- [x] Prepare a CLI patch changeset including the previously unreleased watch regeneration fix; do not publish.
- [x] Run full CLI tests and the new version/coherence regressions. Re-run the previously rejected exact-pin consumer with the local candidate CLI, keeping this source evidence separate from the public-registry cycle.
- [x] Include the product fix in the independent final review and final evidence record.

## Ruling from live evidence

The exact-version requirement protects what gets installed and executed. Public CLI 0.10.0 accepts canonical caret manifest specifications, so the public gate may retain those strings while explicitly selecting exact versions to generate the lock, installing with `npm ci`, and checking all selected lock/installed versions and sources. It must reject a newer patch resolution even if the manifest caret admits it. The earlier exact-manifest failure receipt remains preserved; the local CLI fix does not replace the public CLI inside the public gate.

## Completion evidence

All three scoped implementation tasks are complete locally. Public registry v6 passes 88 steps (actual Node stdio and Bun FFI; exact Rust patch upgrade/rollback); CLI 328 Node +27 Bun tests pass; registry19 and source onboarding20 regressions pass. API snapshot, six-example codegen freshness and release coherence pass. The optional domain-error/events wording in Task1 is resolved as explicit exclusions: propagation only is exercised, not declared typed errors or event lifetime acceptance. See the final roadmap status and preserved receipt. External G1–G4, publication, GUI/mobile and human-duration requirements remain open.

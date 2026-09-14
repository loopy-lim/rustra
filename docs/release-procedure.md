English | [한국어](./release-procedure.ko.md)

# Release procedure (canary → stable → rollback)

The Frame rename and audit fixes target the coordinated 0.10 release. Do not
reuse the already published 0.9.0; see the [release preparation guide](migrations/post-0.9-frame-and-audit.md)
for target versions, consumer checks, and rollback.

Audit item 8, "canary deploy and rollback verification" procedure. Actual execution
proceeds only after separate approval.

## Prerequisites (automated gates)

1. The latest eligible push/PR CI run for the **exact candidate SHA** must succeed.
   Scheduled CI runs execute only a subset of jobs and cannot authorize release.
2. Both npm automation (`workflow_run: CI success`) and manual crates publishing
   (`workflow_dispatch`, main only) in `release.yml` pin the candidate SHA and run
   fresh Miri, Sanitizer and Fuzz reusable workflows. Publishing depends on all
   three succeeding. Missing, failed, cancelled or skipped checks block it; CI is
   checked again immediately before publishing.
3. Scope: Miri lib/frame_wire/field_order_drift; Linux x86_64 ASan+LSan lib;
   seed replay and 600 seconds for each Fuzz target invoke_frame,
   invoke_complex_value and invoke_complex_serde. Weekly checks remain separate
   from PR required checks.

The Linux x86_64 sanitizer job is a cross-platform memory-safety gate. Linux
remains **Alpha** until the separate real Tauri WebView, lifecycle, and packaged
installation acceptance in the compatibility matrix is recorded.

Audit independent safety runs with the read-only command below. Only the latest
eligible run for the candidate counts; an old success cannot hide a newer failure.
Provide `GH_TOKEN` through the existing authenticated environment without printing it.

```bash
node scripts/check-release-gates.mjs --repository loopy-lim/rustra --sha "$(git rev-parse HEAD)" > release-gates.json
```

Release uses `--ci-only` only because its `needs` dependencies require fresh safety
jobs. It is not a standalone safety bypass for publishing. Miri/ASan artifacts
`*-report-<run_id>-<attempt>` include SHA, toolchain, stdout/stderr, exit codes and
raw ASan reports. The absolute `$GITHUB_WORKSPACE/target/safety/` path is uploaded
regardless of test outcome. A failed Miri suite does not skip the other suites;
the job still fails. After fixing a failure, pass CI on the new SHA and rerun
Release. Publishing remains blocked until the new safety checks succeed.

## Step 1 — finalize changesets

The 9 public `@rustra/*` packages are independent release lines. Put only the
changed packages in the changeset and keep the `@rustra/types` compatibility range
each adapter/CLI requires. The Rust `rustra`/`rustra-macros` pair must remain
compatible with each other inside the Cargo workspace, but it does not need to
match the npm package versions. `@rustra/cli`'s `rustraTemplate` carries explicit
semver ranges for the generated Rust crate and the RN adapter.
`bun run test:release-coherence` checks per-package versions, lockfiles, internal
dependency ranges, the CLI's Rust and RN-adapter ranges, LICENSE, and fixed groups.

The two `rustraTemplate` ranges move at different points, both enforced by the
coherence check: `cargoRange` moves in the same feature commit that bumps the
Cargo workspace version (the Rust line is not changesets-managed), while
`reactNativeRange` is synced to the freshly bumped `@rustra/react-native`
version inside the version PR (`bun run version` → `scripts/version-packages.mjs`).
The same script refreshes `bun.lock` after `changeset version` — version bumps
that leave the lock stale fail `test:release-coherence` on the version PR
(first observed 2026-09-10). Never bump `reactNativeRange` on a feature branch
ahead of the adapter version — codegen's adapter-version gate would reject the
in-repo examples and break CI on main between the feature merge and the
version PR (first observed 2026-09-10).

A minor release with a breaking DX change for consumers includes
`docs/migrations/<from>-to-<to>.md` in the version PR and links it from the README.
It must cover host configuration that cannot be auto-migrated, performance escape
hatches, and rollback procedures.

```bash
bunx changeset status   # check target packages/bumps
```

- If `.changeset/*.md` files exist on main, release.yml creates the version-packages PR (`chore: version packages`)
- When the PR merges, version fields + CHANGELOGs are updated in bulk and the changeset files are consumed
- Name multiple packages in the same changeset only when they must change together.
  Do not re-add a fixed group to bundle all packages.

## Step 2 — canary (pre-verification)

Canary publication also requires separate approval and candidate safety checks.
Commit snapshot version changes as a distinct candidate, then obtain all gates
above for that SHA. Do not mutate manifests after validation and reuse the old
SHA's evidence.

```bash
bun run build
bunx changeset version --snapshot canary
# Pin this candidate and pass every safety gate before approved canary publication.
```

Consumer verification:

```bash
mkdir /tmp/canary-check && cd /tmp/canary-check && bun init -y
bun add @rustra/node@canary @rustra/types@canary
bun -e "import * as n from '@rustra/node'; console.log(Object.keys(n))"
```

The React Native adapter checks both the native files in the publish tarball and
the native root resolution in a clean consumer.

```bash
bun run verify:package:react-native
bun run verify:consumer:react-native
```

crates.io canary is not supported (versions cannot be deleted) — Rust publishes
stable only.

## Step 3 — stable publish

1. Merge the Version Packages PR → release.yml runs automatically (9 npm packages)
2. crates manual job: Actions → Release → Run workflow re-verifies CI success for
   the same SHA on `main`, requires fresh Miri/Sanitizer/Fuzz success, then publishes in the order rustra-naming → rustra-macros →
   rustra, waiting for the index after each dependency.

Use the manual workflow above so the safety dependencies run. Local `cargo publish`
or `changeset publish` does not execute GitHub job dependencies and is not the
stable publishing path in this procedure. Keep the Release run and its artifacts
as the publication evidence.

## Step 3.5 — main branch protection (applied 2026-08-21)

- Required checks: `rust-audit`, `rust (ubuntu-latest)`, `rust (macos-latest)`,
  `rust (windows-latest)`, `typescript`, `rn-android`, `rn-ios`, `consumer-smoke`,
  `rust-wasm32`. Updating this document alone does not change the live branch
  protection — the required-checks registration is a separate manual step via the
  `gh api` below.
- Direct pushes are allowed (efficiency for a one-person project); force pushes and
  deletions are blocked.
- When adding a new CI job, add it to the required list as well — the list is
  verified/changed with the API below:
  ```bash
  gh api repos/loopy-lim/rustra/branches/main/protection
  gh api -X PUT repos/loopy-lim/rustra/branches/main/protection --input - <<'EOF'
  {
    "required_status_checks": {
      "strict": false,
      "contexts": [
        "rust-audit",
        "rust (ubuntu-latest)",
        "rust (macos-latest)",
        "rust (windows-latest)",
        "typescript",
        "rn-android",
        "rn-ios",
        "consumer-smoke",
        "rust-wasm32"
      ]
    },
    "enforce_admins": false,
    "required_pull_request_reviews": null,
    "restrictions": null,
    "allow_force_pushes": false,
    "allow_deletions": false
  }
  EOF
  ```

## Step 4 — rollback

- **npm registry**: Bun has no dist-tag change command, so run only this management
  task via `bunx --bun npm dist-tag add @rustra/node@<previous> latest` — reverting the dist-tag
  rolls back immediately (the package itself is not deleted). Apply the same to all packages.
- **crates.io**: not possible (versions are permanent). Use `cargo update --precise <previous>` as user guidance.
- **git**: revert the version commit, then republish as the next patch version (the same version cannot be republished).

## Post-publish checks

```bash
node scripts/audit-release-registry.mjs --output /tmp/rustra-release-matrix.json
```

Keep the [release matrix](release-matrix.md) JSON/Markdown before and after release.
Compare exact versions, latest, npm gitHead, crate VCS SHA and checksums. Local
generated/native hashes are artifact evidence, separate from registry installation
and physical-device execution. Verify registry consumption separately in a clean
consumer pinned to those versions.

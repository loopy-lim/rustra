English | [한국어](./release-procedure.ko.md)

# Release procedure (canary → stable → rollback)

Audit item 8, "canary deploy and rollback verification" procedure. Actual execution
proceeds only after separate approval.

## Prerequisites (automated gates)

1. PR merge → all CI jobs green on main (rust 3-OS + release tests + rust-audit +
   typescript/test:compat + rn-android + rn-ios + consumer-smoke)
2. `release.yml` triggers only via `workflow_run: CI success` (no manual bypass)

## Step 1 — finalize changesets

The 9 public `@rustra/*` packages are independent release lines. Put only the
changed packages in the changeset and keep the `@rustra/types` compatibility range
each adapter/CLI requires. The Rust `rustra`/`rustra-macros` pair must remain
compatible with each other inside the Cargo workspace, but it does not need to
match the npm package versions. `@rustra/cli`'s `rustraTemplate` carries explicit
semver ranges for the generated Rust crate and the RN adapter.
`bun run test:release-coherence` checks per-package versions, lockfiles, internal
dependency ranges, the CLI's Rust range, LICENSE, and fixed groups.

A minor release with a breaking DX change for consumers includes
`docs/migrations/<from>-to-<to>.md` in the version PR and links it from the README.
It must cover host configuration that cannot be auto-migrated, performance escape
hatches, and rollback procedures.

```bash
bunx changeset status   # check target packages/bumps
```

- If `.changeset/*.md` files exist on main, release.yml creates the "Version Packages" PR
- When the PR merges, version fields + CHANGELOGs are updated in bulk and the changeset files are consumed
- Name multiple packages in the same changeset only when they must change together.
  Do not re-add a fixed group to bundle all packages.

## Step 2 — canary (pre-verification)

```bash
bun run build
bunx changeset version --snapshot canary
bunx changeset publish --tag canary
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
   the same SHA on `main`, then publishes in the order rustra-macros → wait for the
   index to update → rustra

```bash
# manual publish after local verification (crates are irreversible: 2-stage gate)
cargo publish -p rustra-macros --dry-run --allow-dirty
cargo publish -p rustra-macros
sleep 30
cargo publish -p rustra
```

## Step 3.5 — main branch protection (applied 2026-08-21)

- Required checks: `rust-audit`, `rust (ubuntu-latest)`, `rust (macos-latest)`,
  `rust (windows-latest)`, `typescript`, `rn-android`, `rn-ios`, `consumer-smoke`.
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
        "consumer-smoke"
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
bun info @rustra/node | tail -20
cargo search rustra --limit 3
```

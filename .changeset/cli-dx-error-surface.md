---
'@rustra/cli': patch
---

First-run and error-surface DX polish. `rustra init` next steps now include
`bun run doctor`. The missing-config error names the default that was tried and
the recovery path; `--format` errors echo the rejected value; value-flag errors
point at `--help`. `generate --watch` prints that Rust sources are not watched
and names `rustra dev`; `dev --inspect` hints are English; top-level help fixes
option alignment and lists `dev --inspect`. Release coherence failures print the
version-PR remediation path.

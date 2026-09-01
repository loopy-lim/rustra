---
'@rustra/cli': minor
---

CLI ergonomics: one contract for CI integrations. Usage errors (unknown option,
missing flag value, invalid `--format`) now throw a typed `UsageError`, and the
binary distinguishes "invoked the CLI wrong" (exit 2) from runtime failures
(exit 1) via `instanceof` instead of matching error-message regexes. `--help`
handling follows a single convention: parsers only fill a `help` flag
(`-h` normalizes to it) while `cli-main` owns all usage output — `rustra dev
--help` no longer enters the watch loop and `codegen/generate/init/diff/inspect`
keep returning silently without touching domain validation. `codegen --format
json` and `diff --format json` now follow the doctor's `{ schemaVersion: 1, … }`
report shape: codegen emits `{ written, drift, durationMs }` (`drift` is true
when regeneration rewrote any existing file) and diff emits `{ breaking, clean }`
carrying the breaking changes verbatim (folded `event_payload_changed` /
`event_removed` structures included) with the breaking → exit 1 contract
unchanged. The previous ad-hoc codegen JSON output (`{ command, checked,
configPath, files }`) is replaced by that shape — automation consuming
`codegen --format json` must parse the new fields (the old `command`
discriminator is gone; use the field set instead). `dev` stays text-only
(long-running watcher, JSON adds no value).

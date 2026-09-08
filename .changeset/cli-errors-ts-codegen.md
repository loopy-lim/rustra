---
'@rustra/cli': minor
---

Code generation now emits `errors.ts` when commands declare `errors`
(sourced from `#[command(error(...))]` / the `command_errors` builder):
per-command error-code literal unions (`{Fn}ErrorCode`), `RustraCommandError`
intersection types (`{Fn}Error`), and type guards (`is{Fn}Error`). This only
narrows the generated TS surface — the runtime error contract is unchanged,
and packages with no declared errors get byte-identical output as before.

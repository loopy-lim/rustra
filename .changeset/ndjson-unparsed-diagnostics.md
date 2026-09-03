---
'@rustra/node': minor
---

Preserves unparsed NDJSON stdout lines and stderr for loop transport diagnostics, activated by `RUSTRA_DEBUG` only (a `configureDebug` sink alone does not activate collection — sink-only installs keep the previous silent behavior). When the runtime emits a line that fails JSON parsing, debug mode emits an `ndjson.unparsed` event plus a once-only stderr warning, and non-debug mode keeps the most recent 32 unparsed lines in a bounded ring buffer (each line truncated to 4096 chars). When the child process exits with requests still pending, the rejection message now appends those preserved lines (and the stderr tail collected in debug mode) after the original "exited before responding" prefix, so callers see what the child actually emitted. Also exports `recordUnparsedLine`, `attachExitContext`, `UNPARSED_LINES_CAPACITY`, `UNPARSED_LINE_MAX_CHARS`, and the `UnparsedLineState` type.

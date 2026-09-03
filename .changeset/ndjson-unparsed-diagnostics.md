---
'@rustra/node': minor
---

Preserves unparsed NDJSON stdout lines and stderr for loop transport diagnostics. When the runtime emits a line that fails JSON parsing, debug mode (`RUSTRA_DEBUG` or a `configureDebug` sink) now emits an `ndjson.unparsed` event plus a once-only stderr warning, and non-debug mode keeps the most recent 32 unparsed lines in a bounded ring buffer. When the child process exits with requests still pending, the rejection message now appends those preserved lines (and the stderr tail collected in debug mode) after the original "exited before responding" prefix, so callers see what the child actually emitted.

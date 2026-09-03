---
'@rustra/types': minor
---

Adds `withRetry(fn, options?)` — a retryable-consumption utility that re-runs `fn` with exponential backoff on `isRetryableCode` failures (customizable via `retryIf`), preserves the last error by identity, and promotes `AbortSignal` cancellation to `CancelledError` mid-backoff.

---
'@rustra/bun': patch
---

Use the optional owned Frame response and matching free symbols for large Bun FFI responses, avoiding the probe cache request copy and retry. Keep the reusable caller buffer for small responses and fall back to the legacy path when either optional symbol is unavailable. Copy owned response bytes before freeing them so decoded values retain their lifetime safely.

---
'@rustra/cli': patch
---

Preserve exact compatible host dependency pins during code generation. Use independently versioned Node, Bun and Tauri compatibility ranges so a CLI-only patch does not require unpublished adapter versions, and keep those defaults synchronized during versioning. The init renderer accepts an optional Node compatibility range while preserving existing callers. Includes the previously unreleased watch regeneration fix.

---
'@rustra/cli': patch
---

Rebuild configured Node and Bun runtime producers before reporting a successful dev reload. Watch separate host crates as well as the schema crate, and suppress reload when the runtime build fails so implementation-only edits cannot silently invoke an older binary. Invalidate the successful-input cache before regenerating so restoring earlier source after a failed build or parity rejection repairs partially updated generated artifacts.

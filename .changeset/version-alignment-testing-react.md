---
'@rustra/testing': minor
'@rustra/react': minor
---

Version alignment: bump testing/react from 0.5.0 to 0.6.0 to match the
`@rustra/types` 0.6 migration. Both packages already depend on
`@rustra/types ^0.6.0`, so leaving their own version on the 0.5 line splits
install trees into two `@rustra/types` instances (0.5.x resolved from the
published peer range vs 0.6.0 shipped in-repo). This changeset only realigns
the self-version; no source changes since 0.5.0.

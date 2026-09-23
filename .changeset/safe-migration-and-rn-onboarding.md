---
'@rustra/cli': patch
'@rustra/react-native': patch
---

Fix React Native initialization to declare the adapter dependency and register the
native FFI entrypoint. Preserve equals signs in inline CLI option values.
Keep generated React Native modules in their existing monorepo workspace instead
of creating a nested workspace. Respect workspace glob exclusions.

Make schema diffs detect positional wire changes and terminate on recursive
references. Optional field additions are now correctly reported as breaking for
binary consumers; keep strict contract verification and upgrade generated/native
artifacts together.
Remove obsolete generated files only when the previous manifest proves their
unchanged ownership. Preserve edited, unrecorded, symlinked, and out-of-root files
with an actionable error, including legacy rkyv files left by older upgrades.

Prevent repeated event delivery when callbacks resubscribe during dispatch, and
prevent channel callbacks from being invoked twice when user code throws.

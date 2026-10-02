---
'@rustra/cli': minor
---

Add `init --setup` and repeatable `setup --run` to generate, install, build and
call in order, with stage progress and safe retry instructions. Support Bun
scaffolds, standalone nested Cargo projects and runtime paths through symlinks.
Respect the app's package manager. Prepare React Native platform scripts and
generate a non-destructive Tauri registration helper for existing apps. Preserve
literal URL delimiter characters in Cargo runtime paths and report failed Cargo
builds without displaying a successful completion marker.

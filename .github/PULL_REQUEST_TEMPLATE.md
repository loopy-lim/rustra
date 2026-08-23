## Summary

<!-- What changed and why. Link the research/spec/plan docs if this comes
from a tracked workstream (thoughts/shared/…). -->

## Verification

<!-- Which gates did you run? Keep the lines that apply. -->

- [ ] `cargo test -p rustra -p rustra-macros`
- [ ] `cargo clippy --all-targets -- -D warnings`
- [ ] `bun run test:packages`
- [ ] `bun run test:ts:node` (codegen output changes)
- [ ] `bun run test:compat` (transport/runtime changes)
- [ ] Regenerated `examples/*/generated/` via **both** paths (Rust bin + TS CLI)

## Checklist

- [ ] Docs updated in the same PR (the repo convention: implementation
      landing without its doc sync is the recurring failure mode)
- [ ] Changeset added (`.changeset/`) for user-facing changes
- [ ] No new `TODO` without a tracking issue/plan reference
- [ ] Wire format changes are backwards-compatible or called out loudly

## Notes for reviewers

<!-- Anything non-obvious: invariants, trade-offs, rejected alternatives. -->

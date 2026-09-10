[한국어](./0001-record-track-a-contract-mechanization.ko.md)

# ADR 0001 — Track A: contract mechanization (adopting UniFFI maturity practices)

- Status: Accepted
- Date: 2026-09-11
- Related: [`docs/safety-contract.md`](../safety-contract.md),
  [`docs/research/2026-09-11-uniffi-maturity-catchup.md`](../research/2026-09-11-uniffi-maturity-catchup.md)

## Status

Accepted — 2026-09-11. Implementation is split across the Track A work items (A1–A8)
and proceeds per item.

## Context

The Mozilla UniFFI benchmark study (`docs/research/2026-09-11-uniffi-maturity-catchup.md`)
found that maturity is not about language count but about **mechanizing contracts**:
checksums, load-time verification, failure-injection fixtures, fixture discipline, and
artifact-based codegen gates. rustra already leads on some axes (public schema, wire
freeze, hot swap, en/ko docs), but five weakly-enforced points carry the load of any
maturity claim:

1. FFI **signature** changes pass the api-surface gate (the snapshot compares symbol
   **names only**).
2. Runtime contract verification (`contract.mismatch`) is opt-in, so consumers that never
   set it run unverified.
3. Codegen freshness of committed generated files is not verified in CI (a doctor warn at
   best).
4. Cross-language wire fixtures cover exactly one calculator case, and mobile runtime E2E
   does not exist (builds only).
5. Invariants are scattered across documents (no written safety contract), and ko mirror
   completeness plus typedoc are manual with no automated check.

## Decision

Adopt UniFFI's maturity practices **while keeping the rustra model** (Track A —
independent of the language-coverage decision, Track B). Six items:

1. **Per-symbol signature pinning**: promote the api-surface snapshot to v2 so it compares
   signatures (args, return, async-ness) beyond symbol names — rustra's form of UniFFI's
   per-symbol u16 checksums.
2. **contractVerification policy option**: introduce the policy option that turns
   `contract.mismatch` runtime verification default-on while keeping an escape hatch.
3. **Codegen freshness gate**: regenerate → `git diff --exit-code`, turning drift of
   committed generated files into a CI failure (promoting the doctor warn).
4. **Wire fixture matrix**: one fixture per feature (tagged unions/maps/sets/errors/
   events/channels/cancellation/async/large payloads), expanding the 3-corner pinned hex
   coverage, plus the "every cross-language bug becomes a fixture" discipline — mirroring
   UniFFI's `fixtures/` conformance suite.
5. **Mobile runtime smoke**: CI jobs that run rn-android/rn-ios on emulator/simulator
   (CI-ifying the infrastructure already proven by the hot-core E2E).
6. **Written safety contract + ADR practice**: consolidate the scattered invariants into
   [`docs/safety-contract.md`](../safety-contract.md), and record future FFI contract
   changes as numbered ADRs (this directory).

## Consequences

- **Positive**: signature, freshness, and contract verification are promoted to CI-hard,
  so "bindings ↔ core mismatch" becomes a failure before it can become UB. The safety
  contract becomes a first-class review/change target. The practices gap closes while
  keeping rustra's advantages over UniFFI (public schema, wire freeze, hot swap).
- **Negative/cost**: PRs without regenerated generated files will fail the freshness gate
  (a regen commit is required). contractVerification default-on can break apps that
  previously passed on installs mixing old and new artifacts (mitigated by the escape
  hatch). The fixture matrix and mobile smoke increase CI time.
- **Neutral**: Track B (language coverage) presumes this decision and gets its own ADR.
  Line-number drift in the safety contract may be updated without an ADR (see the
  contract's change rule).

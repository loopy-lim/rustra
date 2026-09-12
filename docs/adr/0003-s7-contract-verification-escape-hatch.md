[한국어](./0003-s7-contract-verification-escape-hatch.ko.md)

# ADR 0003 — S7 wording alignment: record the contractVerification policy as the explicit escape hatch

- Status: Accepted
- Date: 2026-09-12
- Related: [ADR 0001](./0001-record-track-a-contract-mechanization.md),
  [Safety contract S7](../safety-contract.md),
  `packages/types/src/frame-engine-options.ts`

## Status

Accepted — 2026-09-12. No behavior change (the policy was implemented per ADR 0001).
This record aligns the safety-contract wording with an already-made decision.

## Context

[ADR 0001](./0001-record-track-a-contract-mechanization.md) Track A item 2 decided
the `contractVerification: 'strict' | 'warn' | 'off'` policy option (default
`undefined` ≡ `'strict'`), shipped in 0.10.0 (`packages/types/src/frame-engine-options.ts`,
`validateFrameEngineOptions` in `frame-engine-contract.ts`).

S7's item (a) and the "On violation" line predate that decision and read as if no
bypass exists at all ("There is no 'skip verification and continue'"). Actual
behavior:

- mismatch + `onContractMismatch` callback (T2) — callback runs, engine continues
  degraded (the callback takes priority regardless of policy).
- mismatch/unenforceable + `'warn'` — downgraded to a console warning, continue.
- `'off'` — verification skipped regardless of `contractHash`.
- unenforceable + `'strict'` (default) — always throws; not even a callback bypasses.

A code/document divergence is itself a contract violation ([change
rule](../safety-contract.md)), and even a commit that moves the document toward
reality requires an ADR. This is that ADR.

## Decision

S7 (a) states the default-policy fail-fast behavior, then names the
`contractVerification` option as the single explicit, caller-owned escape hatch —
`'warn'` continues degraded, `'off'` skips verification. "On violation" now says
skip-and-continue exists only via explicit opt-in (never silently). The
unbypassability of unenforceable-under-strict and the knob's scope (native Frame
engine only; without `contractHash` there is nothing to verify) are stated
together. The evidence section gains the policy knob in `frame-engine-options.ts`.

## Consequences

- Enforcement code is untouched — this record only aligns the document with the
  behavior ADR 0001 decided and 0.10.0 shipped.
- Readers who quoted the categorical wording should update it to the
  explicit-opt-in framing (a skip happens only when the caller chose the policy).
- The failure-injection matrix (`packages/types/src/index.test.ts` — A2/A3)
  already covers all three modes. Written and gated as an en/ko mirror pair.

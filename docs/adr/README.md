# Architecture Decision Records (ADR)

Numbered records of decisions that change an rustra contract or its enforcement.
Format per record: Status / Context / Decision / Consequences. A rejected option is
worth recording too — write down why it was rejected.

| Number                                                | Title                                                                   | Status   | Date       |
| ----------------------------------------------------- | ----------------------------------------------------------------------- | -------- | ---------- |
| [0001](0001-record-track-a-contract-mechanization.md) | Track A: contract mechanization (adopting UniFFI maturity practices)    | Accepted | 2026-09-11 |
| [0002](0002-uniffi-track-b1-carrier.md)               | Track B1: UniFFI as the Kotlin/Swift language carrier                   | Accepted | 2026-09-11 |
| [0003](0003-s7-contract-verification-escape-hatch.md) | S7 wording alignment: contractVerification as the explicit escape hatch | Accepted | 2026-09-12 |

## Conventions

- File name: `NNNN-short-kebab-title.md` (`.ko.md` Korean mirror, Korean drafted first).
- Status lifecycle: `Proposed` → `Accepted` / `Rejected` → `Superseded by NNNN`
  (superseding records link back).
- The [safety contract](../safety-contract.md) mandates an ADR for any change in meaning
  of its items (S1–S7 and the umbrella invariant).

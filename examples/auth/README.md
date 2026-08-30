English | [한국어](./README.ko.md)

# Auth Example — Sessions/Tokens + Capability Gate

An example showing session token issuance and revocation plus access control based on
the Runtime Authority (capability). Deny-by-default — until a capability is explicitly
granted, a protected command does not even execute its handler.

## Structure

```
auth/
├── src/lib.rs            signIn/signOut/grant/adminStats (+ capability gate)
├── src/bin/invoke.rs     stdio line daemon(--serve) — structured error JSON responses
├── apps/node-app.ts      Node end-to-end demo (3-stage scenario)
├── tests/auth_flow.rs    Integration test (full capability flow)
└── ts/auth.test.ts       Unit test (mock engine + error code preservation)
```

## Run (end-to-end)

```bash
cargo build -p rustra-auth-example
bunx tsc -p examples/auth/tsconfig.json
node dist-ts/examples/auth/apps/node-app.js
```

Output:

```
[auth] user grant admin.stats → denied (role=user)
[auth] adminStats: sessions=2 uptime=0ms
[auth] after signOut: capability.denied (as expected)
[auth] PASS — capability gate verified (user denied / admin allowed / revoked)
```

## Scenario

1. A regular user (`password123`) is denied `grant` — role policy
2. The admin (`hunter2`) is granted the `admin.stats` capability and `adminStats` succeeds
3. After `signOut`, a re-invocation → `capability.denied` (the error code is preserved over the wire)

## Demo Policy (Production Replacement Points)

- Password verification: `"hunter2"` → admin (in reality, backend lookup/federation)
- Token: `role-<sha256-8bytes>` (in reality, JWT/opaque token + expiration)
- Session storage: in-process `BTreeMap` (in reality, Redis/DB)

The capability gate pattern itself (`RustraError::capability_denied`) can be applied to
production as-is — see the Runtime Authority in `crates/rustra`.

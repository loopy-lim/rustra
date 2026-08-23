# Security Policy

## Supported Versions

rustra is pre-1.0 — security fixes land on `main` and ship in the next
minor release. The latest published version (`@rustra/*` on npm, `rustra`
on crates.io) is the supported surface.

| Version | Supported |
| ------- | --------- |
| 0.3.x   | ✅        |
| < 0.3   | ❌        |

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Use [GitHub private vulnerability reporting](https://github.com/loopy-lim/rustra/security/advisories/new)
(Repo → Security → Report a vulnerability). If that is unavailable, email
the maintainer via the address on the GitHub profile.

Include:

- Affected surface (Rust crate / npm package / FFI boundary / CI workflow)
- Minimal reproduction (wire bytes, payload, or repo steps)
- Impact assessment (RCE / memory safety / DoS / supply chain)

You will get an acknowledgment within 7 days. Valid reports are credited
in the advisory unless you prefer to stay anonymous.

## Scope

**In scope:**

- `crates/rustra` — the FFI boundary, panic guards, buffer
  allocation/free protocol, payload size gates
- `packages/*` — generated code injection (identifier whitelisting),
  transport framing
- Codegen output executed by consumers (`rustra generate`)

**Out of scope:**

- Example apps (`examples/*`) misused as production code
- Vulnerabilities in dependencies — report those upstream; we track
  RUSTSEC advisories via CI (`cargo audit` + `cargo deny`)
- DoS via absurdly sized but contract-valid payloads (the 1 MiB gate is
  a sanity limit, not a security boundary)

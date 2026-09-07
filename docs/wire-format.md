English | [한국어](./wire-format.ko.md)

# Wire Format — Names and Real Measured Scope

"rkyv V2" is Rustra's own frame/protocol name. It is not a claim of byte-level
compatibility with the upstream `rkyv` archive format: the payload codec on the
manifest/dispatch paths is postcard, and compatibility with upstream rkyv
archives has not been separately verified. This page separates the names from
the measured numbers so neither is quoted beyond its scope.

## Names

| Name                 | What it actually is                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| rkyv V2              | Rustra's binary frame protocol (V2 framing + command ids + postcard payload codec). An internal name. |
| postcard             | The payload codec used on the manifest/dispatch paths (serde-compatible compact format).              |
| JSON wire            | The `invoke_json`/stdio line protocol used by adapters without codecs injected.                       |
| zero-copy (JSI path) | The RN JSI fast path hands a native buffer view to the JS codec without an intermediate JS copy.      |

"Zero-copy" means one specific copy is removed: the extra JS-side buffer copy
between the native call boundary and the codec. It does not mean the whole
round trip is allocation-free, and it does not apply to the JSON wire. The
measured case was the Bun `toArrayBuffer` view trap (a view on the FFI buffer
must not outlive the call), see docs/benchmarks.md for the boundary details.

## The 11.8× / 47 B claim, scoped

The "11.8× smaller than JSON" figure is measured on the **request wire bytes**
for one representative command payload (the add command), postcard-encoded
versus `JSON.stringify` of the same args — 47 B versus roughly 560 B. The
denominator is request bytes only; it excludes framing, transport overhead,
and the response. It is not an end-to-end RTT claim.

| Layer              | What varies                                     | Where it is measured                    |
| ------------------ | ----------------------------------------------- | --------------------------------------- |
| Payload wire bytes | postcard vs JSON encoding of args               | request payload, the 11.8× figure       |
| Core dispatch      | registry lookup + handler call                  | Rust criterion benches (`cargo bench`)  |
| FFI boundary       | argument marshalling into/out of the native lib | caller-buffer benches (packages/bun)    |
| End-to-end RTT     | everything above + transport + host scheduling  | docs/benchmarks.md host matrix receipts |

When quoting numbers, name the layer. A payload ratio must not be quoted as an
RTT ratio; an FFI micro figure must not be quoted as a user-path latency.

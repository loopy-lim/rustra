English | [한국어](./wire-format.ko.md)

# Wire Format — Names and Real Measured Scope

"Frame" is Rustra's own frame/protocol name (formerly "rkyv V2" — reader's note
for anyone arriving from older posts or CHANGELOGs). The payload codec on the
manifest/dispatch paths is postcard; it is unrelated to, and claims no
compatibility with, the upstream `rkyv` archive format. This page separates the
names from the measured numbers so neither is quoted beyond its scope.

## Names

| Name                 | What it actually is                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| Frame                | Rustra's binary frame protocol (V2 framing + command ids + postcard payload codec).                   |
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

## Loop-stdio binary-mode reserved frames

The loop-stdio runtime multiplexes unsolicited pushes and channel control onto
the same length-prefixed stream as request/response frames
(`[len u32 LE][cmd/body]`). Response frames start with an `ok` flag byte
(0/1), so their first `u16 LE` can never collide with a reserved cmd id — that
wire fact is what the receiver's demultiplexer branches on. Reserved ids
(counting down from the top of the u16 space):

| cmd id   | Direction        | Body                                   | Purpose                                                               |
| -------- | ---------------- | -------------------------------------- | --------------------------------------------------------------------- |
| `0xFFFE` | client → runtime | (none)                                 | event drain request                                                   |
| `0xFFFD` | runtime → client | 1-line JSON `{"name","payload","seq"}` | event push frame                                                      |
| `0xFFFC` | runtime → client | 1-line JSON `{"handle","payload"}`     | JSON channel push frame                                               |
| `0xFFFB` | client → runtime | empty, or `[mode u8]`                  | channel create — `mode`: absent/`0x00` = JSON, `0x01` = bytes         |
| `0xFFFA` | client → runtime | postcard varint `u32` handle           | channel drop (removes the handle from both the JSON and bytes tables) |
| `0xFFF9` | runtime → client | `[handle u32 LE][payload bytes]`       | **binary channel push frame** (raw bytes, no JSON wrapping)           |

Channel-create responses use the Frame response shape with a
`{"handle": u32}` JSON body on both paths.

The `0xFFF9` body carries the payload as raw bytes (e.g. a Frame).
There is no payload length prefix inside the body — the frame wrapper's `len`
already bounds it, and unlike the JSON channel body there is no internal
structure that needs its own boundary. One handle works on exactly one path
(JSON xor bytes), fixed at creation by the `0xFFFB` mode byte; the drop frame
and the monotonic handle space are shared by both paths.

The `0xFFFB` mode byte is the only extension to an existing frame: a create
with an empty body is byte-for-byte the legacy JSON request, so old runtimes
and old clients interoperate in both directions (an old runtime ignores the
body entirely; a `0x00` explicit-JSON flag is defined for wire completeness).
An unknown mode value is answered `ok=0` rather than silently falling back to
the JSON path. New clients additionally gate binary channels on the
`"channelBytes": true` capability echoed in the `__hello` response — a runtime
that does not echo it makes `createNodeBytesChannel` fail loudly with
`channel.unavailable` before any frame is sent, instead of silently mismatching
the JSON path. `0xFFF9` frames only ever flow to a client that issued a
`mode=0x01` create, so an old demultiplexer never sees one.

## Error frames (unchanged by typed errors)

An error response uses the same frame wrapper as any other response with `ok=0`;
the Frame path carries `[ok=0][pad][len u16][postcard{code, message}]` and the JSON
fallback re-splits a `Display` string back into `{code, message}`. That is the whole
error surface on the wire — there is no payload field and no declaration data.

Command-scoped typed errors (see the [Rust API Guide](./rust-api-guide.md)) do not
touch this: declarations live in schema.json and turn into generated TypeScript
(`errors.ts` — literal unions + guards) at codegen time. The frame, the host
promotions, and `RustraCommandError` are byte-for-byte what they were before.

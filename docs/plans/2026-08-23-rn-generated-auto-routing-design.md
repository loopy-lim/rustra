# RN generated API automatic transport routing

Status: implemented through Phase 1 plus the safe `number[]` byte-path reduction
on 2026-08-24; direct typed-buffer ownership remains a follow-up

## Context

The normalized iOS simulator benchmark compares the same public input and output
shapes in a Hermes Release build. Across three interleaved runs, Rustra was
1.082x slower than Nitro for scalar add and 1.143x-1.157x slower for string,
64-byte payload, and pair operations. The same Rustra paths were substantially
faster than the Swift async FFI comparison, so the remaining gap is primarily in
the generated-JS-to-JSI hot path rather than in the Rust handler.

Rustra already exposes lower-level native entries such as `invokeTypedRaw`,
`invokeTypedPos`, and `invokeTypedById`. They are not currently one product
surface:

- `commands.ts` preserves the ergonomic object-input, Promise-returning API but
  stops at `invokeTypedById`.
- `positional-facade.ts` can use `invokeTypedPos`, but changes every function
  signature and requires a second manual native installation step.
- `invokeTypedRaw` is a benchmark/native primitive and is not selected by the
  generated client.

The runtime-lifetime audit also found that process-static JSI values are unsafe
across React Native reloads. Performance routing must therefore preserve
Runtime-scoped ownership and must not add long-lived JSI handles outside the
Runtime.

## Decision

### One generated public API

`commands.ts` remains the only recommended command API. Its public signature is
unchanged:

```ts
benchAdd({ a: 42, b: 58 }, options?): Promise<{ value: number }>
```

The generator inspects the command schema and emits an internal field-aware
invoke helper for eligible flat inputs. Users do not install or import a second
facade. `positional-facade.ts` remains temporarily available as a compatibility
artifact but is no longer the preferred performance path.

### Capability negotiation once per engine

The native module exposes a command capability mask keyed by the stable numeric
command id. The engine caches the mask while it verifies the generated registry:

- `typed`: C++ codec and `invokeTypedById` are available.
- `positional`: one to three flat scalar/string fields can enter
  `invokeTypedPos` without C++ object property reads.
- `raw`: one to three numeric/boolean fields and a scalar or unit result can use
  `invokeTypedRaw` without postcard request/response conversion.

Old native modules that do not expose the mask keep the current
`hasStaticCodec`/`invokeTypedById` route. Unsupported commands continue through
the existing JS codec or Tier 3 live-schema path.

### Route order

For generated calls without per-call options, the engine selects the fastest
verified route:

1. Tier 0 raw scalar
2. Tier 1 positional typed
3. typed by numeric id
4. Tier 2 generated JS codec and `invokeRkyvV2`
5. Tier 3 live-schema JSON-in-binary fallback

Calls with `signal` or `timeoutMs` retain the existing option semantics. Until a
field-aware route has equivalent cancellation propagation, those calls use the
existing `invokeGenerated` path.

### Result-shape preservation

Tier 0 must return the generated public output shape, not a primitive benchmark
shape. Generated C++ metadata converts the raw output slot to the correct JSI
primitive kind and wraps it with the declared single output field. Unit outputs
become `undefined`. A raw fallback marker is never exposed to users.

### Runtime ownership and reload safety

- Runtime-bound `PropNameID` values remain owned by a `jsi::NativeState` attached
  to that Runtime's global object.
- Process-static registries may store only weak references or plain numeric
  metadata, never owning JSI values.
- Async callbacks, events, and channels must not resolve into a superseded
  Runtime.
- A same-process reload stress test is a release gate for native routing changes.

### Tier 2 byte path

Bytes and collections are not forced through the scalar route. The implemented
safe reduction forwards a schema-proven `Vec<u8>` field positionally, reserves
its Writer span once, validates and writes each byte into that span, and decodes
through one bounds-checked byte view. It preserves the existing `number[]`
surface and error semantics.

The larger follow-up uses `ArrayBuffer`/typed-array input and explicit
caller-owned response buffers so the engine can avoid per-element JSI
conversion. It remains separate because it changes representation, buffer
ownership, view offsets, and size-limit behavior. The current `number[]` result
must not be presented as having reached the typed-buffer target.

## Acceptance gates

- Bun 1.4 is the package manager and app-test runner.
- Generated API output and error/options contracts are byte- and behavior-equivalent
  to the fallback path.
- Three Release runs use 500 warmups, 10,000 iterations, equivalent output
  checks, and rotating interleaving.
- Initial simulator targets: scalar/string/pair at or below 1.10x Nitro and
  64-byte payload at or below 1.08x Nitro.
- React Doctor remains 100/100.
- No real-device performance or release claim is made until both physical iOS
  and Android receipts exist.

## Simulator evidence after implementation

The final three Release runs were taken below the 10-logical-CPU load threshold.
All runs used 500 warmups, 10,000 iterations, rotating interleaving, Hermes, and
pre-timing output equivalence checks across Nitro, Rustra, and Swift FFI.

| Operation | Rustra/Nitro median | Swift FFI/Nitro median | Gate                     |
| --------- | ------------------: | ---------------------: | ------------------------ |
| add       |              1.034x |                11.361x | pass                     |
| string    |              1.019x |                11.072x | pass                     |
| pair      |              1.059x |                10.310x | pass                     |
| bytes64   |              1.133x |                 2.182x | follow-up; 1.08x not met |

The generated-helper/native-route diagnostic median is 1.073x for add, 1.057x
for string, 1.053x for pair, and 1.015x for bytes64. This isolates the remaining
byte gap below the generated JS router: a typed-buffer representation and
ownership path is required for the next material reduction.

## Versioning

`@rustra/types` remains at version `0.3.1` for this work. The change is additive
and old native hosts fall back to their existing route.

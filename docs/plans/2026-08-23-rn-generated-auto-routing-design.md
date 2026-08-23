# RN generated API automatic transport routing

Status: implemented through the direct typed-buffer ownership path on 2026-08-24

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

### Tier 0.5 byte path

Bytes and collections are not forced through the scalar route. A command is
eligible only when generated input and output schemas each contain exactly one
required `Vec<u8>` field and Rust explicitly registers it with
`buffer_command`/`buffer_command_fn`. The native capability is advertised only
when both conditions hold.

`Uint8Array` (including non-zero-offset subviews) and `ArrayBuffer` use the
direct entry. The JSI host borrows the input only for the synchronous call;
Rust immediately creates the owned value required by the command boundary. On
success, the handler's output allocation moves into a JSI `MutableBuffer` and
is released exactly once by its finalizer. No `Runtime`, `Value`, or
`PropNameID` is retained by that finalizer, so collection after a React Native
reload is safe. Errors are copied to a typed JS error and freed immediately.

`number[]`, options-bearing calls, old native modules, missing capabilities,
and id/name mismatches keep the existing generated fallback. The fallback also
accepts one-byte typed views and preserves their offsets. Detached storage,
multi-byte views, non-integral/out-of-range bytes, malformed view bounds, and
payloads beyond the dynamic wire limit fail closed.

For an echo operation, Nitro performs one copy into a fresh `ArrayBuffer`.
Rustra performs one copy from the borrowed JS input into the owned Rust vector,
then transfers that vector to JSI without an output copy. The externally
visible fresh-output contract is therefore equivalent while both paths move the
bulk bytes once.

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

The generated-helper/native-route diagnostic median was 1.073x for add, 1.057x
for string, 1.053x for pair, and 1.015x for bytes64. This isolated the remaining
byte gap below the generated JS router and motivated the typed-buffer ownership
path measured next.

### Typed-buffer follow-up evidence

The same iPhone 17 Simulator, iOS 26.2, Hermes, and Release build was run three
times after transferring Rust output ownership directly to JSI. Each run first
checked byte-for-byte output equality. The 64 KiB case used 50 warmups and 500
timed calls; the exact 1 MiB-wire case used 5 warmups and 50 timed calls. Its
data length is 1,048,571 bytes because command id and postcard length consume
the remaining five bytes of the default 1 MiB wire limit.

| Payload    | Nitro avg median | Rustra avg median | Ratio from medians | Paired ratio range |
| ---------- | ---------------: | ----------------: | -----------------: | -----------------: |
| 64 KiB     |         9.388 us |          8.889 us |             0.947x |      0.899x-1.014x |
| 1 MiB wire |        94.748 us |         94.740 us |             1.000x |      0.874x-1.007x |

Before the ownership transfer, the corresponding median ratios were 2.344x and
3.644x. The final rerun after moving JSI installation onto the JS Runtime thread
measured Rustra at 8.889 us for 64 KiB and 94.740 us for 1 MiB wire. These are simulator receipts, not
physical-device or Android performance claims.

## Versioning

`@rustra/types` remains at version `0.3.1` for this work. The change is additive
and old native hosts fall back to their existing route.

# Ordinary function registration

## Outcome

Register an unchanged safe synchronous Rust function with zero through twelve
arguments using `Package::builder("app").function("add", add)`. The caller does
not need a Rustra command macro, input/output DTO, or a `Result` return. Generate
TypeScript `add(arg0, arg1, options?)` with a `Promise` of the actual return type;
`fn reset() {}` becomes `reset(options?): Promise<void>`.

```rust
fn add(a: i32, b: i32) -> i32 { a + b }
fn reset() {}
let package = rustra::Package::builder("app")
    .function("add", add)
    .function("reset", reset)
    .build();
```

Fallible functions use `.try_function("read", read, map_error)` where the mapper
is `Fn(E) -> RustraError`. This preserves arbitrary domain error types and avoids
ambiguous overlapping plain-return and result-unwrapping inference. A `Result`
registered through `.function` remains data if it satisfies the output bounds.

## Contract

- Arguments are owned `DeserializeOwned + JsonSchema + 'static`; returns are
  `Serialize + JsonSchema + 'static`. Handler and mapper are `Send + Sync + 'static`.
- Inference uses an arity marker and safe `Fn` implementations, generated inside
  the library. Do not accept unsafe capability-declaring macro wrappers.
- Input is `()` for arity zero and `(A0, ..., An)` for positive arities. One tuple
  argument is nested, distinct from several arguments. JSON arguments follow
  this tuple representation, with `null` for arity zero.
- Only new registrations add `functionArgs: number` to the command schema. It
  equals the arity, is an integer in 0..12, and is included in wire signatures and
  contract hashes. Legacy command entries omit it and keep their existing shape.
- Validate metadata against the input schema before generation. New generated
  argument names are `arg0` through `arg11`, because `Fn` cannot reflect names.
- Both Rust and CLI TypeScript generators produce the same positional signature.
  Invoke options remain the final optional parameter, including unit arguments.
- Existing `.command`, `.command_fn`, command macros and metadata APIs continue
  to work. Existing command-only schema/hash fixtures remain stable.
- Preserve capability, platform, cancellation, error, payload-limit, and panic
  guards by using the existing registration/dispatch infrastructure.
- Async registration and source parsing are separate future work; users can
  keep the existing async command macro. This is an additive pre-1.0 feature.

## Wire correctness and performance

Ordinary functions use typed binary dispatch without an extra JSON Value round
trip. Extend postcard root handling consistently across Rust, generated TS,
live-schema TS and generated C++ where a root can use the existing field codec.
Flatten fixed root tuples as sequential fields, preserving postcard's absence
of a tuple-length prefix. Scalar, sequence, map and unit outputs must decode to
their declared shape. Preserve complex binary or JSON fallback for unsupported
shapes, and ensure all route selectors agree. Never advertise a native route
whose encoder still assumes an object root.

Generate reusable cursor `encodeInto` for root tuples of supported scalar fields.
Reuse existing Rust caller-buffer serialization. A successful warmed scalar
function `invoke_frame_into` should require zero heap allocations. No new unsafe
production code or C ABI is needed. New raw/positional native scalar specialization is not
required: the existing NaN fallback sentinel makes that a separate contract
change. Do not advertise raw capabilities for function tuple roots.

Unit returns must be `undefined` in generated public TypeScript, including binary
and fallback paths. A too-small output buffer or a NaN result must not execute
the handler twice. No timing improvement claim is valid without measurements
on the current source and an explicit comparison workload.

## Acceptance

1. Rust integration tests cover arities 0, 1, 2, 4, 12, closures, scalar/string/
   unit/tuple/option/collection/struct returns, arbitrary mapped errors, nested
   tuple input, duplicate names, metadata, and existing capability guards.
2. Real generated TS encodes requests consumed by Rust and decodes its responses;
   cover primitive, unit, optional/collection roots and mapped error. Check both
   `encode` and `encodeInto`, static and live-schema routes, and Rust/CLI emitter
   parity. C++ generated code must compile or its unsupported routes must fall
   back coherently; source text assertions alone are not a native runtime proof.
3. Existing Rust, CLI, types, API-surface and architecture gates pass, or a
   demonstrably preexisting failure is recorded with a baseline reproduction.
4. Provide a reproducible benchmark and allocation assertion for scalar function
   dispatch, comparing JSON, binary allocation and caller-buffer paths, plus an
   equivalent legacy object command. Report build/runtime evidence separately.
5. Update bilingual authoring docs and an additive release note. Keep the old
   onboarding worktree and all unrelated user files untouched.

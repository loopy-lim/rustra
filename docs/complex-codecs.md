English | [한국어](./complex-codecs.ko.md)

# Complex binary codecs

Rustra selects a wire route per command.

| Route          | Targets                                                                    | RN path                                                                 |
| -------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| postcard       | primitives, Vec/Set/tuple, primitive maps, string enums, and the rest of the verified subset | C++ JSI or JS codec                                                   |
| complex binary | recursive structs, struct-valued maps, data enums, combinational Options | native-safe schemas go through C++ JSI; the rest go JS codec → `invokeRkyvV2` → Rust |
| Tier 3 JSON    | schemas neither binary codec supports, or runtime-registered commands    | JSON-in-binary                                                          |

A complex request is `[command_id: u16 LE][body]`; a success response is the
existing 8-byte header followed by the complex body. Struct fields are written
in schema declaration order. Map keys are sorted in UTF-8 byte order, and enum
variants are sorted by the deterministic key derived from their name/discriminant
tag. As a result, the wire index does not change even if the order of the `oneOf`
array differs between Rust and the generated TypeScript.
An ambiguous `oneOf` for which no stable name/tag/title can be obtained is not
registered on the complex route and is sent as Tier 3 JSON. Anonymous variants may
declare `x-rustra-variant-order: ["key-for-first", "key-for-second"]` in the
schema. The actual wire index is computed by sorting these stable keys in UTF-8
byte order.

The default limits are depth 32, payload 1 MiB, and collection/string length 100,000.
Truncated frames, duplicate map keys, invalid variants, and trailing bytes are
handled as `command.invalid_args`/`invoke.malformed`, not as success results.

The CLI's shared Codec IR is what the TS/C++ generators use to make recursive ref,
struct field, map, option, tuple, and enum decisions. The RN C++ side statically
advertises primitive-element `Set`s and `int64/uint64` as part of the native-safe
complex subset. Shapes outside the native-safe decision, such as Sets of
object/array elements, go through the JS complex codec. Complex integers accept
`number | bigint` and validate the `int8..uint64` range. Measurement produces a
machine-readable JSON receipt with the following command.

```bash
bun run bench:complex
```

This receipt measures only the JS encode/decode cost and does not prove Rust/C++
dispatch or physical device execution. Inspecting the C++ complex generation
source only verifies the route/structure; a real platform run receipt is separate.
The Android release APK in the current example has been verified up to complex
commands, channels, resources, and benchmarks on the `TB710FU` physical device,
and iOS has been verified up to a `iphoneos` generic Debug link and the
Release embedded-bundle runtime on the iPhone 17 Simulator. Simulator logs
confirmed the codec/complex command, channel/resource, JSI, and benchmark paths.

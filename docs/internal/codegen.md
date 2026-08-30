English | [한국어](./codegen.ko.md)

# TypeScript Code Generation Pipeline

Internal documentation for project contributors. Describes the full flow of
`Package::generate_typescript()`, schema extraction, TS type mapping rules,
and the generated output.

---

## Overall Flow

```
Package::generate_typescript()
  │
  ├─ 1. self.schema()           → JSON Value (packageId + commands array)
  ├─ 2. contract_hash()         → schema.json string → SHA256 hex
  ├─ 3. self.generate_types_ts() → types.ts string
  ├─ 4. self.generate_commands_ts() → commands.ts string
  │
  └─ GeneratedPackage { schema_json, types_ts, commands_ts, contract_hash }
       │
       └─ write_to_dir() → schema.json, types.ts, commands.ts, contract.ts
```

---

## 1. Schema Extraction

### schema_value\<T\>()

Called when a command is registered via `command()` / `command_fn()`. Uses the
`schema_for!()` macro from `schemars`.

```rust
fn schema_value<T: JsonSchema>() -> (Value, Value) {
    let schema = schema_for!(T);
    let root = serde_json::to_value(schema.schema).expect("schema serializes");
    let defs = serde_json::to_value(schema.definitions).expect("definitions serialize");
    (root, defs)
}
```

- First return value: the JSON Schema of type T (object)
- Second return value: the definitions object corresponding to `$defs` (including shared types such as enums)
- Definitions from multiple commands are merged in `PackageBuilder::command()` (BTreeMap merge)
- The merged definitions are emitted as the `$defs` block in `generate_types_ts()` and used for `$ref` resolution in `ts_type_from_schema`

### short_type_name\<T\>()

Extracts the segment after the last `::` from `std::any::type_name::<T>()`.

Example: `calculator::AddNumbersInput` → `AddNumbersInput`

---

## 2. TS Type Mapping Rules

`ts_type_from_schema(schema: &Value, definitions: &Value)` generates a
TypeScript type string based on the JSON Schema `"type"` field. The second
argument, `definitions`, is used for `$ref` resolution.

### Mapping table

| JSON Schema type                  | TypeScript type         | Notes                                          |
| --------------------------------- | ----------------------- | ---------------------------------------------- |
| `"$ref": "#/definitions/X"`       | `X` (referenced type name) | Name extracted with `resolve_ref()`         |
| `"anyOf": [...]`                  | `A \| B \| ...`         | Recursive call per schema, then union          |
| `"object"`                        | `{ field: type; ... }`  | Calls `ts_object_from_schema()`                |
| `"integer"`                       | `number`                |                                                |
| `"number"`                        | `number`                |                                                |
| `"string"` + `"enum"`             | `'A' \| 'B'`            | String enum values become a string literal union |
| `"string"`                        | `string`                | Plain string when there is no enum             |
| `"boolean"`                       | `boolean`               |                                                |
| `"array"` + `"uniqueItems": true` | `Set<T>`                | Mapping for Rust `BTreeSet`/`HashSet` (2026-08-15) |
| `"array"`                         | `type[]`                | Recursive call on `items`, `unknown[]` if absent |
| `"null"`                          | `null`                  |                                                |
| `["string", "null"]` etc.         | `string \| null`        | Type array becomes a union                     |
| Anything else                     | `unknown`               |                                                |

### `$ref` resolution (`resolve_ref`)

```
"#/definitions/MyType" → "MyType"
"#/$defs/MyType"       → "MyType"
```

When a `$ref` is encountered, `resolve_ref` does not look up the actual schema
in the definitions map; it extracts and returns only the type name. The
referenced type must already be emitted by `generate_types_ts()`, which walks
the `$defs` block separately.

### Object mapping details (`ts_object_from_schema`)

```
JSON Schema:
{
  "type": "object",
  "properties": { "a": { "type": "integer" }, "b": { "type": "integer" } },
  "required": ["a", "b"]
}

↓

TypeScript:
{
  a: number;
  b: number;
}
```

- Properties missing from the `required` array are marked `?` (optional)
- If there are no `properties`, it falls back to `Record<string, unknown>`

---

## 3. Command Name Conversion

### command_fn path (automatic extraction)

```
Function definition: fn add_numbers(input: ...) -> Result<...>
                          ↓
type_name::<F>() → "calculator::add_numbers::{{closure}}" etc.
                          ↓
short_type_name() → extract the last segment
                          ↓
trim_end_matches("_command") → strip the "_command" suffix
                          ↓
snake_to_lower_camel() → "addNumbers"
```

### command path (explicit name)

```rust
.command("addNumbers", add_numbers)
```

The user specifies the command name directly. It is used as-is, with no name
conversion.

### TS function name generation (`command_function_name`)

Converts a command name into a TypeScript function name. It is a camelCase
conversion that capitalizes the character following a separator (`_`, `-`,
`.` etc). If the result is an empty string, it falls back to `"command"`.

Example: `"addNumbers"` → `"addNumbers"` (no change when already camelCase)

---

## 4. Contract Hash

```rust
fn contract_hash(input: impl AsRef<[u8]>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_ref());
    hex::encode(hasher.finalize())
}
```

- Input: the `schema_json` string (pretty-printed JSON)
- Output: a SHA256 hex string
- Purpose: stored as the `GENERATED_CONTRACT_HASH` constant in `contract.ts`.
  Used at runtime to verify contract agreement between host and client.

---

## 5. Generated Output

The 4 files produced by `GeneratedPackage`:

### schema.json

```json
{
  "packageId": "example.calculator",
  "commands": [
    {
      "name": "addNumbers",
      "inputType": "AddNumbersInput",
      "outputType": "AddNumbersOutput",
      "inputSchema": { ... },
      "outputSchema": { ... }
    }
  ]
}
```

### types.ts

```typescript
export type EngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

export type RustraError = {
  readonly code: string;
  readonly message: string;
};

// shared types defined in $defs (enums, etc.)
export type Status = 'Active' | 'Inactive';

export type AddNumbersInput = {
  a: number;
  b: number;
};

export type AddNumbersOutput = {
  value: number;
};
```

`generate_types_ts()` emits in the following order:

1. The `EngineClient` type definition
2. The `RustraError` type definition (`readonly code: string; readonly message: string`)
3. Shared types defined in `$defs` (enums, reusable structs, etc), emitted after merging definitions from all commands
4. Each command's input/output types; already-emitted types are not emitted again (tracked with a `BTreeSet`)

### commands.ts

```typescript
import type { AddNumbersInput, AddNumbersOutput, EngineClient, RustraError } from './types.js';

export function addNumbers(
  engine: EngineClient,
  input: AddNumbersInput,
): Promise<AddNumbersOutput> {
  return engine.invoke<AddNumbersOutput>('addNumbers', input);
}
```

- `EngineClient` and `RustraError` are always included in imports
- All types are imported alphabetically
- One function per command

### contract.ts

```typescript
export const GENERATED_CONTRACT_HASH = '<sha256-hex>';
```

---

## 6. Current Limitations

The JSON Schema → TypeScript conversion supports the object/array/union/
intersection, literal enum, and map/set/tuple/$ref recursive surfaces that
rustra emits. Arbitrary schemas that a Rust type contract never generates,
such as JSON Schema conditional keywords (`if`/`then`/`else`) or
`patternProperties`, fall back safely to `unknown`.

**postcard codec (rkyv-codecs.ts/C++) support policy**: commands with
unsupported fields do not get a partial postcard codec. Instead, when the
complex codec supports the full schema, the command is registered in the TS
registry as a complex route. C++ includes only the complex subset that the
shared Codec IR judges native-safe in its static registry and excludes the
rest. Only commands that neither binary codec supports are excluded with a
WARN and routed to the Tier 3 (JSON-in-binary) fallback — structurally
blocking a recurrence of the past "unsupported field silently dropped, wire
broken" defect.

### Already supported types (previously unsupported)

| Type                                     | Support approach                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `Set`                                    | `"array"` + `"uniqueItems": true` → `Set<T>` (2026-08-15). postcard codec `set_*` kind (wire is vec-compatible), JSON path serializes as array via replacer |
| `tuple`                                  | `items` array / `prefixItems` → `[A, B, C]`                                                                                                  |
| `oneOf` (Rust)                           | Produces an `A \| B` union just like `anyOf` (TS CLI being reinforced)                                                                       |
| `$ref`                                   | `#/definitions/X`, `#/$defs/X` → type name extracted                                                                                         |
| `anyOf`                                  | Recursive call per schema, then an `A \| B` union                                                                                            |
| string `enum`                            | `'Value1' \| 'Value2'` string literal union. The postcard codec encodes a variant index varint (`enum_str` kind)                              |
| `null`                                   | `null` type                                                                                                                                  |
| Type array union                         | `["string", "null"]` → `string \| null`                                                                                                      |
| Optional fields                          | `?` + `\| null` when absent from `required` (schemars represents this as `anyOf`)                                                            |
| `allOf`                                  | `A & B` intersection type (2026-08-20, both Rust bin and TS CLI)                                                                             |
| Integer enum                             | `1 \| 2 \| 3` numeric literal union (2026-08-20, both Rust bin and TS CLI)                                                                   |
| `Option<T>` (postcard)                   | Tag byte (0/1) + value — `option_zigzag/f64/f32/bool/string/struct` kinds (2026-08-20)                                                       |
| `Vec<String>` / `Vec<Struct>` (postcard) | varint length + elements — `vec_string`/`vec_struct` kinds (2026-08-20)                                                                      |
| `oneOf` discriminator field (`const`)    | `const_literal`/`constLiteral` builds `{ type: 'A' }` discriminated unions                                                                   |
| single-entry `allOf` newtype (postcard)  | Follows the inner `$ref` of a transparent newtype such as `ChannelHandle(u32)` and generates the same scalar wire                             |

Payload data enums excluded from the postcard fast path, maps with
struct/array values, recursive structures, and `Option<T>` combinations
wrapping collections/enums are handled by the complex binary route. Only when
the complex route also cannot prove the command — an unknown ref, an
ambiguous union, an unsupported JSON Schema keyword — is the whole command
excluded with a single actionable WARN and routed to the JSON-in-binary path.

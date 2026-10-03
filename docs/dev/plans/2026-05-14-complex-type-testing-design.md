# Complex Type Testing Design

## Goal

Validate existing type support and add support for Map, Tuple, Enum-with-data, and deep nesting types with comprehensive tests.

## Changes

### 1. codegen.rs — Add 3 new type conversions

- **Map**: `{ "type": "object", "additionalProperties": {...} }` → `Record<K, V>`
- **Tuple**: `{ "type": "array", "prefixItems": [...] }` → `[T1, T2, T3]`
- **Enum with data**: schemars `oneOf` with tagged union → `{ type: 'Variant'; field: T } | ...`
- Deep nesting already works via recursion — tests only

### 2. Rust tests (public_authoring_api_tests.rs)

- HashMap/BTreeMap type generation
- Tuple type generation
- Tagged enum type generation
- Deep nesting (Vec<Vec<Struct>>, Option<Vec<Option<T>>>)

### 3. E2E tests (calculator example)

- Add complex commands, verify runtime invoke

# Complex Type Support & Testing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add codegen support for Map, Tuple, Enum-with-data types and add comprehensive tests for all complex types including deep nesting.

**Architecture:** Extend `ts_type_from_schema()` in `codegen.rs` to handle 3 new JSON Schema patterns produced by schemars 0.8. Then add TDD-style tests in `public_authoring_api_tests.rs` covering all complex types.

**Tech Stack:** Rust, schemars 0.8, serde_json, serde

---

### Task 1: Add Map type support (HashMap/BTreeMap → Record<K, V>)

**Files:**
- Modify: `crates/rustra/src/codegen.rs:84-96` (ts_object_from_schema)
- Test: `crates/rustra/tests/public_authoring_api_tests.rs`

**Step 1: Write the failing test**

Append to `crates/rustra/tests/public_authoring_api_tests.rs`:

```rust
#[test]
fn ts_generator_handles_hashmap() {
    use std::collections::HashMap;

    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct MapInput {
        scores: HashMap<String, i64>,
    }

    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct MapOutput {
        result: HashMap<String, String>,
    }

    #[command]
    fn map_cmd(input: MapInput) -> Result<MapOutput> {
        let mut result = HashMap::new();
        for (k, v) in input.scores {
            result.insert(k, v.to_string());
        }
        Ok(MapOutput { result })
    }

    let package = Package::builder("test.map")
        .command("mapCmd", map_cmd)
        .build();
    let generated = package.generate_typescript().unwrap();

    assert!(
        generated.types_ts.contains("scores: Record<string, number>;"),
        "HashMap<String, i64> should become Record<string, number>, got:\n{}",
        generated.types_ts
    );
    assert!(
        generated.types_ts.contains("result: Record<string, string>;"),
        "HashMap<String, String> should become Record<string, string>, got:\n{}",
        generated.types_ts
    );
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test --package rustra -- ts_generator_handles_hashmap --nocapture`
Expected: FAIL — `scores` likely shows as `Record<string, unknown>` or similar

**Step 3: Write minimal implementation**

In `crates/rustra/src/codegen.rs`, modify `ts_object_from_schema()` at line 95. Currently when `properties` is None, it returns `Record<string, unknown>`. Change it to check for `additionalProperties`:

```rust
pub(super) fn ts_object_from_schema(schema: &Value, definitions: &Value) -> String {
    let required = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        // Check for Map type: { "type": "object", "additionalProperties": { ... } }
        if let Some(additional) = schema.get("additionalProperties") {
            let value_type = ts_type_from_schema(additional, definitions);
            return format!("Record<string, {value_type}>");
        }
        return "Record<string, unknown>".to_string();
    };

    // ... rest unchanged
}
```

**Step 4: Run test to verify it passes**

Run: `cargo test --package rustra -- ts_generator_handles_hashmap --nocapture`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/rustra/src/codegen.rs crates/rustra/tests/public_authoring_api_tests.rs
git commit -m "feat(codegen): add HashMap/BTreeMap → Record<string, V> support"
```

---

### Task 2: Add Tuple type support ((A, B, C) → [A, B, C])

**Files:**
- Modify: `crates/rustra/src/codegen.rs:46-52` (array handling in ts_type_from_schema)
- Test: `crates/rustra/tests/public_authoring_api_tests.rs`

**Step 1: Write the failing test**

Append to `crates/rustra/tests/public_authoring_api_tests.rs`:

```rust
#[test]
fn ts_generator_handles_tuples() {
    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct TupleInput {
        pair: (String, i64),
        triple: (String, i64, bool),
    }

    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct TupleOutput {
        value: (i64, String),
    }

    #[command]
    fn tuple_cmd(input: TupleInput) -> Result<TupleOutput> {
        Ok(TupleOutput {
            value: (input.pair.1, input.pair.0),
        })
    }

    let package = Package::builder("test.tuple")
        .command("tupleCmd", tuple_cmd)
        .build();
    let generated = package.generate_typescript().unwrap();

    assert!(
        generated.types_ts.contains("pair: [string, number];"),
        "tuple (String, i64) should become [string, number], got:\n{}",
        generated.types_ts
    );
    assert!(
        generated.types_ts.contains("triple: [string, number, boolean];"),
        "tuple (String, i64, bool) should become [string, number, boolean], got:\n{}",
        generated.types_ts
    );
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test --package rustra -- ts_generator_handles_tuples --nocapture`
Expected: FAIL — tuple likely renders as `unknown[]`

**Step 3: Write minimal implementation**

In `crates/rustra/src/codegen.rs`, modify the `"array"` arm (line 46). Check if `items` is an array (tuple) vs object (regular array):

```rust
"array" => {
    // Tuple: items is an array of schemas (schemars 0.8 style)
    if let Some(items_arr) = schema.get("items").and_then(Value::as_array) {
        let elements: Vec<String> = items_arr
            .iter()
            .map(|s| ts_type_from_schema(s, definitions))
            .collect();
        return format!("[{}]", elements.join(", "));
    }
    // Regular array: items is a single schema
    let item_type = schema
        .get("items")
        .map(|s| ts_type_from_schema(s, definitions))
        .unwrap_or_else(|| "unknown".to_string());
    format!("{item_type}[]")
}
```

**Step 4: Run test to verify it passes**

Run: `cargo test --package rustra -- ts_generator_handles_tuples --nocapture`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/rustra/src/codegen.rs crates/rustra/tests/public_authoring_api_tests.rs
git commit -m "feat(codegen): add tuple type → [T1, T2, T3] support"
```

---

### Task 3: Add Enum-with-data support (tagged union)

**Files:**
- Modify: `crates/rustra/src/codegen.rs:13-24` (add oneOf handling before anyOf)
- Test: `crates/rustra/tests/public_authoring_api_tests.rs`

**Step 1: Write the failing test**

Append to `crates/rustra/tests/public_authoring_api_tests.rs`:

```rust
#[test]
fn ts_generator_handles_enum_with_data() {
    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    enum Shape {
        Circle { radius: f64 },
        Rectangle { width: f64, height: f64 },
    }

    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct EnumDataInput {
        shape: Shape,
    }

    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct EnumDataOutput {
        description: String,
    }

    #[command]
    fn enum_data_cmd(input: EnumDataInput) -> Result<EnumDataOutput> {
        let desc = match input.shape {
            Shape::Circle { radius } => format!("circle(r={radius})"),
            Shape::Rectangle { width, height } => format!("rect({width}x{height})"),
        };
        Ok(EnumDataOutput { description: desc })
    }

    let package = Package::builder("test.enum_data")
        .command("enumDataCmd", enum_data_cmd)
        .build();
    let generated = package.generate_typescript().unwrap();

    assert!(
        generated.types_ts.contains("Circle")
            && generated.types_ts.contains("Rectangle"),
        "enum with data should contain variant names, got:\n{}",
        generated.types_ts
    );
    assert!(
        generated.types_ts.contains("radius")
            && generated.types_ts.contains("width")
            && generated.types_ts.contains("height"),
        "enum with data should contain variant fields, got:\n{}",
        generated.types_ts
    );
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test --package rustra -- ts_generator_handles_enum_with_data --nocapture`
Expected: FAIL — enum with data likely renders incorrectly since `oneOf` is not handled

**Step 3: Write minimal implementation**

In `crates/rustra/src/codegen.rs`, add `oneOf` handling after `$ref` resolution (line 16) and before `anyOf`:

```rust
pub(super) fn ts_type_from_schema(schema: &Value, definitions: &Value) -> String {
    if let Some(r#ref) = schema.get("$ref").and_then(Value::as_str) {
        return resolve_ref(r#ref);
    }

    // Handle oneOf (enum with data from schemars)
    if let Some(one_of) = schema.get("oneOf").and_then(Value::as_array) {
        let parts: Vec<String> = one_of
            .iter()
            .map(|s| ts_type_from_schema(s, definitions))
            .collect();
        return parts.join(" | ");
    }

    // ... rest unchanged (anyOf handling follows)
```

**Step 4: Run test to verify it passes**

Run: `cargo test --package rustra -- ts_generator_handles_enum_with_data --nocapture`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/rustra/src/codegen.rs crates/rustra/tests/public_authoring_api_tests.rs
git commit -m "feat(codegen): add enum-with-data → tagged union support via oneOf"
```

---

### Task 4: Add deep nesting tests

**Files:**
- Test: `crates/rustra/tests/public_authoring_api_tests.rs`

**Step 1: Write the test**

Append to `crates/rustra/tests/public_authoring_api_tests.rs`:

```rust
#[test]
fn ts_generator_handles_deep_nesting() {
    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct Tag {
        label: String,
    }

    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct Nested {
        tags: Vec<Tag>,
        parent: Option<Box<Nested>>,
    }

    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct DeepInput {
        matrix: Vec<Vec<i64>>,
        maybe_items: Option<Vec<Option<Tag>>>,
        nested: Nested,
    }

    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct DeepOutput {
        count: i64,
    }

    #[command]
    fn deep_cmd(input: DeepInput) -> Result<DeepOutput> {
        Ok(DeepOutput {
            count: input.matrix.iter().map(|r| r.len() as i64).sum(),
        })
    }

    let package = Package::builder("test.deep")
        .command("deepCmd", deep_cmd)
        .build();
    let generated = package.generate_typescript().unwrap();

    assert!(
        generated.types_ts.contains("matrix: number[][];"),
        "Vec<Vec<i64>> should become number[][], got:\n{}",
        generated.types_ts
    );
    assert!(
        generated.types_ts.contains("export type Tag"),
        "Tag type should be emitted, got:\n{}",
        generated.types_ts
    );
}
```

**Step 2: Run test**

Run: `cargo test --package rustra -- ts_generator_handles_deep_nesting --nocapture`
Expected: PASS (deep nesting already works via recursion)

**Step 3: Commit**

```bash
git add crates/rustra/tests/public_authoring_api_tests.rs
git commit -m "test(codegen): add deep nesting type tests"
```

---

### Task 5: Run full test suite and verify no regressions

**Step 1: Run all tests**

Run: `cargo test --package rustra`
Expected: All tests PASS (old + new)

**Step 2: Verify generated TypeScript for complex types**

Run: `cargo test --package rustra -- --nocapture 2>&1 | head -100`
Expected: No panics, no failures

**Step 3: Commit any final fixes**

```bash
git add -A
git commit -m "test(codegen): verify full suite passes with complex types"
```

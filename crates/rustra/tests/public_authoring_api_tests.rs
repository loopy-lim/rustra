use rustra::prelude::*;
use std::process::Command;

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AddNumbersInput {
    a: i64,
    b: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AddNumbersOutput {
    value: i64,
}

#[command]
fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput {
        value: input.a + input.b,
    })
}

#[test]
fn user_builds_package_without_touching_raw_engine_types() {
    let package = Package::builder("example.calculator")
        .command("addNumbers", add_numbers)
        .build();

    let output: AddNumbersOutput = package
        .invoke("addNumbers", AddNumbersInput { a: 20, b: 22 })
        .unwrap();

    assert_eq!(output, AddNumbersOutput { value: 42 });
}

#[test]
fn user_can_register_command_without_writing_command_name_string() {
    let package = Package::builder("example.calculator")
        .command_fn(add_numbers)
        .build();

    let output: AddNumbersOutput = package
        .invoke("addNumbers", AddNumbersInput { a: 8, b: 13 })
        .unwrap();

    assert_eq!(output, AddNumbersOutput { value: 21 });

    let generated = package.generate_typescript().unwrap();
    assert!(generated.commands_ts.contains("export function addNumbers"));
    assert!(generated.commands_ts.contains("'addNumbers'"));
}

#[test]
fn register_macro_uses_macro_derived_name() {
    let package = register!(Package::builder("example.calculator"), add_numbers).build();

    let output: AddNumbersOutput = package
        .invoke("addNumbers", AddNumbersInput { a: 1, b: 1 })
        .unwrap();

    assert_eq!(output, AddNumbersOutput { value: 2 });
}

#[test]
fn package_generates_host_neutral_typescript_client() {
    let package = Package::builder("example.calculator")
        .command("addNumbers", add_numbers)
        .build();

    let generated = package.generate_typescript().unwrap();

    assert!(generated.types_ts.contains("export type AddNumbersInput"));
    assert!(generated.commands_ts.contains("export function addNumbers"));
    assert!(
        generated
            .commands_ts
            .contains("engine.invoke<AddNumbersOutput>")
    );
    assert!(!generated.commands_ts.contains("EngineRequest"));
    assert!(!generated.commands_ts.contains("Attachment"));
    assert!(!generated.commands_ts.contains("node:"));
    assert!(!generated.commands_ts.contains("react-native"));
}

#[test]
fn generated_package_can_be_written_to_a_directory() {
    let package = Package::builder("example.calculator")
        .command("addNumbers", add_numbers)
        .build();
    let generated = package.generate_typescript().unwrap();
    let output_dir = std::env::temp_dir().join(format!("rustra-generated-{}", std::process::id()));

    let _ = std::fs::remove_dir_all(&output_dir);
    generated.write_to_dir(&output_dir).unwrap();

    assert!(output_dir.join("schema.json").exists());
    assert!(output_dir.join("types.ts").exists());
    assert!(output_dir.join("commands.ts").exists());
    assert!(output_dir.join("contract.ts").exists());

    std::fs::remove_dir_all(output_dir).unwrap();
}

#[test]
fn unknown_command_uses_package_level_error() {
    let package = Package::builder("example.empty").build();
    let error = package
        .invoke::<_, AddNumbersOutput>("missing", AddNumbersInput { a: 1, b: 2 })
        .unwrap_err();

    assert_eq!(error.code(), "command.not_found");
}

#[test]
fn ts_generator_handles_optional_fields() {
    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct OptionalInput {
        name: String,
        age: Option<i64>,
    }

    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct OptionalOutput {
        value: i64,
        label: Option<String>,
    }

    #[command]
    fn optional_cmd(input: OptionalInput) -> Result<OptionalOutput> {
        Ok(OptionalOutput {
            value: input.age.unwrap_or(0),
            label: None,
        })
    }

    let package = Package::builder("test.optional")
        .command("optionalCmd", optional_cmd)
        .build();
    let generated = package.generate_typescript().unwrap();

    assert!(
        generated.types_ts.contains("age?: number | null;"),
        "optional int field should be age?: number | null; got:\n{}",
        generated.types_ts
    );
    assert!(
        generated.types_ts.contains("label?: string | null;"),
        "optional string field should be label?: string | null; got:\n{}",
        generated.types_ts
    );
}

#[test]
fn ts_generator_handles_enums() {
    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    enum Status {
        Active,
        Inactive,
    }

    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct EnumInput {
        status: Status,
    }

    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct EnumOutput {
        result: String,
    }

    #[command]
    fn enum_cmd(input: EnumInput) -> Result<EnumOutput> {
        Ok(EnumOutput {
            result: format!("{:?}", input.status),
        })
    }

    let package = Package::builder("test.enum")
        .command("enumCmd", enum_cmd)
        .build();
    let generated = package.generate_typescript().unwrap();

    assert!(
        generated.types_ts.contains("status: Status;"),
        "enum field should reference Status type, got:\n{}",
        generated.types_ts
    );
    assert!(
        generated.types_ts.contains("'Active' | 'Inactive'"),
        "enum should generate union, got:\n{}",
        generated.types_ts
    );
}

#[test]
fn ts_generator_handles_vec_and_optional_struct() {
    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct Item {
        name: String,
    }

    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct ComplexInput {
        items: Vec<String>,
        parent: Option<Item>,
    }

    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct ComplexOutput {
        count: i64,
    }

    #[command]
    fn complex_cmd(input: ComplexInput) -> Result<ComplexOutput> {
        Ok(ComplexOutput {
            count: input.items.len() as i64,
        })
    }

    let package = Package::builder("test.complex")
        .command("complexCmd", complex_cmd)
        .build();
    let generated = package.generate_typescript().unwrap();

    assert!(
        generated.types_ts.contains("items: string[];"),
        "vec should become string[], got:\n{}",
        generated.types_ts
    );
    assert!(
        generated.types_ts.contains("parent?: Item | null;"),
        "optional struct should be Item | null, got:\n{}",
        generated.types_ts
    );
}

#[test]
fn command_macro_rejects_wrong_signature() {
    let try_compile = |source: &str| -> bool {
        let tmp_dir = std::env::temp_dir().join(format!("rustra-macro-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(tmp_dir.join("src")).unwrap();
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        let workspace_dir = std::path::Path::new(&manifest_dir)
            .parent()
            .unwrap()
            .parent()
            .unwrap();
        std::fs::write(
            tmp_dir.join("Cargo.toml"),
            format!(
                "[package]\nname = \"macro-test\"\nedition = \"2024\"\nversion = \"0.1.0\"\n\n\
                [dependencies]\nrustra = {{ path = \"{}/crates/rustra\" }}\n\
                serde = {{ version = \"1\", features = [\"derive\"] }}\n\
                schemars = {{ version = \"0.8\", features = [\"derive\"] }}\n",
                workspace_dir.display()
            ),
        )
        .unwrap();
        std::fs::write(tmp_dir.join("src").join("lib.rs"), source).unwrap();

        let output = Command::new("cargo")
            .args(["check"])
            .current_dir(&tmp_dir)
            .output()
            .unwrap();

        let _ = std::fs::remove_dir_all(&tmp_dir);
        output.status.success()
    };

    let valid = try_compile(
        "use rustra::prelude::*;\n\
         #[derive(Serialize, Deserialize, JsonSchema)]\n\
         struct In { x: i64 }\n\
         #[derive(Serialize, Deserialize, JsonSchema)]\n\
         struct Out { y: i64 }\n\
         #[command]\n\
         pub fn good(input: In) -> Result<Out> { Ok(Out { y: input.x }) }\n",
    );
    assert!(valid, "valid signature should compile");

    let no_input = try_compile(
        "use rustra::prelude::*;\n\
         #[command]\n\
         pub fn no_args() -> Result<()> { loop {} }\n",
    );
    assert!(!no_input, "missing input parameter should fail");

    let wrong_return = try_compile(
        "use rustra::prelude::*;\n\
         #[derive(Serialize, Deserialize, JsonSchema)]\n\
         struct In { x: i64 }\n\
         #[command]\n\
         pub fn bad_return(input: In) -> String { String::new() }\n",
    );
    assert!(!wrong_return, "non-Result return should fail");
}

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
        generated.types_ts.contains("Circle") && generated.types_ts.contains("Rectangle"),
        "enum with data should contain variant names, got:\n{}",
        generated.types_ts
    );
    assert!(
        generated.types_ts.contains("radius") && generated.types_ts.contains("width") && generated.types_ts.contains("height"),
        "enum with data should contain variant fields, got:\n{}",
        generated.types_ts
    );
}

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

#[test]
fn bridge_type_replaces_four_derives() {
    #[rustra::bridge_type]
    struct BridgedInput {
        pub name: String,
        pub age: Option<u32>,
    }

    // Verify serialization with camelCase
    let input = BridgedInput { name: "test".into(), age: Some(25) };
    let json = serde_json::to_value(&input).unwrap();
    assert_eq!(json["name"], "test");
    assert_eq!(json["age"], 25);

    // Verify round-trip
    let de: BridgedInput = serde_json::from_value(json).unwrap();
    assert_eq!(de.name, "test");
    assert_eq!(de.age, Some(25));

    // Verify JsonSchema works
    let schema = schemars::schema_for!(BridgedInput);
    let schema_json = serde_json::to_value(&schema).unwrap();
    assert!(schema_json["$schema"].is_string());
}

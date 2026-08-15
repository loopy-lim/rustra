use rustra::prelude::*;
use std::fs;
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
        .command_fn(add_numbers)
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
        .command_fn(add_numbers)
        .build();

    let generated = package.generate_typescript().unwrap();

    assert!(generated.types_ts.contains("export type AddNumbersInput"));
    assert!(generated.commands_ts.contains("export function addNumbers"));
    assert!(
        generated
            .commands_ts
            .contains("invoke<AddNumbersOutput>('addNumbers'")
    );
    assert!(
        generated
            .commands_ts
            .contains("import { invoke } from '@rustra/types'")
    );
    assert!(!generated.commands_ts.contains("EngineRequest"));
    assert!(!generated.commands_ts.contains("Attachment"));
    assert!(!generated.commands_ts.contains("node:"));
    assert!(!generated.commands_ts.contains("react-native"));
}

#[test]
fn generated_package_can_be_written_to_a_directory() {
    let output_dir = std::env::temp_dir().join(format!("rustra-generated-{}", std::process::id()));

    let _ = std::fs::remove_dir_all(&output_dir);
    let generated = Package::builder("example.calculator")
        .command_fn(add_numbers)
        .build()
        .generate_typescript()
        .unwrap();
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
        .command_fn(optional_cmd)
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

    let package = Package::builder("test.enum").command_fn(enum_cmd).build();
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
        .command_fn(complex_cmd)
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
        let tmp_dir =
            std::env::temp_dir().join(format!("rustra-macro-test-{}", std::process::id()));
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

    let bare_return = try_compile(
        "use rustra::prelude::*;\n\
         #[derive(Serialize, Deserialize, JsonSchema)]\n\
         struct In { x: i64 }\n\
         #[command]\n\
         pub fn bare_return(input: In) -> String { String::new() }\n",
    );
    assert!(!bare_return, "bare (non-Result) return should fail");

    let multi_param = try_compile(
        "use rustra::prelude::*;\n\
         #[command]\n\
         pub fn add(a: i64, b: i64) -> Result<i64> { Ok(a + b) }\n",
    );
    assert!(!multi_param, "multiple params should fail");
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

    let package = Package::builder("test.map").command_fn(map_cmd).build();
    let generated = package.generate_typescript().unwrap();

    assert!(
        generated
            .types_ts
            .contains("scores: Record<string, number>;"),
        "HashMap<String, i64> should become Record<string, number>, got:\n{}",
        generated.types_ts
    );
    assert!(
        generated
            .types_ts
            .contains("result: Record<string, string>;"),
        "HashMap<String, String> should become Record<string, string>, got:\n{}",
        generated.types_ts
    );
}

#[test]
fn ts_generator_handles_sets() {
    use std::collections::BTreeSet;

    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct SetInput {
        tags: BTreeSet<String>,
        primes: BTreeSet<i64>,
    }

    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct SetOutput {
        unique: BTreeSet<i64>,
    }

    #[command]
    fn set_cmd(input: SetInput) -> Result<SetOutput> {
        let mut unique = input.primes;
        unique.insert(4);
        Ok(SetOutput { unique })
    }

    let package = Package::builder("test.set").command_fn(set_cmd).build();
    let generated = package.generate_typescript().unwrap();

    assert!(
        generated.types_ts.contains("tags: Set<string>;"),
        "BTreeSet<String> should become Set<string>, got:\n{}",
        generated.types_ts
    );
    assert!(
        generated.types_ts.contains("primes: Set<number>;"),
        "BTreeSet<i64> should become Set<number>, got:\n{}",
        generated.types_ts
    );
    assert!(
        generated.types_ts.contains("unique: Set<number>;"),
        "output BTreeSet<i64> should become Set<number>, got:\n{}",
        generated.types_ts
    );

    // JSON 왕복: serde 가 Set 을 배열로 직렬화하므로 invoke 도 정상 동작해야 한다.
    let out: SetOutput = package
        .invoke(
            "setCmd",
            SetInput {
                tags: BTreeSet::from(["a".to_string(), "b".to_string()]),
                primes: BTreeSet::from([2, 3, 5]),
            },
        )
        .unwrap();
    assert_eq!(out.unique, BTreeSet::from([2, 3, 4, 5]));
}

#[test]
fn ts_generator_handles_recursive_types() {
    /// 재귀 트리 노드 — self-reference(`children: Vec<TreeNode>`)가 schemars 에서
    /// `$ref: "#/definitions/TreeNode"` 로 내보내지는지, 그리고 그 정의가
    /// generated types.ts 에 누락 없이 emit 되는지 검증한다.
    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct TreeNode {
        name: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        children: Vec<TreeNode>,
    }

    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct TreeInput {
        root: Box<TreeNode>,
    }

    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct TreeOutput {
        depth: i64,
    }

    #[command]
    fn tree_depth(input: TreeInput) -> Result<TreeOutput> {
        fn depth(n: &TreeNode) -> i64 {
            1 + n.children.iter().map(depth).max().unwrap_or(0)
        }
        Ok(TreeOutput {
            depth: depth(&input.root) - 1,
        })
    }

    let package = Package::builder("test.tree").command_fn(tree_depth).build();
    let generated = package.generate_typescript().unwrap();

    // self-$ref 가 이름으로 풀려 자기 참조 타입이 만들어진다.
    assert!(
        generated.types_ts.contains("export type TreeNode = {"),
        "TreeNode definition should be emitted, got:\n{}",
        generated.types_ts
    );
    assert!(
        generated.types_ts.contains("children?: TreeNode[]"),
        "Vec<TreeNode> should become self-referencing TreeNode[] \
         (skip_serializing_if 로 선택적 필드), got:\n{}",
        generated.types_ts
    );

    // JSON 왕복: 중첩 노드가 $ref 로 직렬화·역직렬화 되는지 (루트 definitions 공유).
    let tree = TreeNode {
        name: "root".into(),
        children: vec![
            TreeNode {
                name: "a".into(),
                children: vec![TreeNode {
                    name: "a1".into(),
                    children: vec![],
                }],
            },
            TreeNode {
                name: "b".into(),
                children: vec![],
            },
        ],
    };
    let out: TreeOutput = package
        .invoke(
            "treeDepth",
            TreeInput {
                root: Box::new(tree),
            },
        )
        .unwrap();
    assert_eq!(out.depth, 2);
}

#[test]
fn ts_generator_handles_discriminated_unions() {
    /// `#[serde(tag = "kind")]` — schemars 는 oneOf + 각 variant 에
    /// `kind: { const: "..." }` 태그를 내보낸다. codegen 이 이를
    /// `{ kind: 'circle' }` 판별 필드로 매핑하는지 검증.
    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(tag = "kind", rename_all = "camelCase")]
    enum Shape {
        Circle { radius: f64 },
        Rectangle { width: f64, height: f64 },
    }

    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct AreaInput {
        shape: Shape,
    }

    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct AreaOutput {
        area: f64,
    }

    #[command]
    fn shape_area(input: AreaInput) -> Result<AreaOutput> {
        let area = match input.shape {
            Shape::Circle { radius } => std::f64::consts::PI * radius * radius,
            Shape::Rectangle { width, height } => width * height,
        };
        Ok(AreaOutput { area })
    }

    let package = Package::builder("test.shape")
        .command_fn(shape_area)
        .build();
    let generated = package.generate_typescript().unwrap();

    // 태그 프로퍼티가 리터럴 타입으로 판별 필드가 된다.
    assert!(
        generated.types_ts.contains("kind: 'circle';"),
        "serde tag should map to literal 'circle' discriminator, got:\n{}",
        generated.types_ts
    );
    assert!(
        generated.types_ts.contains("kind: 'rectangle';"),
        "serde tag should map to literal 'rectangle' discriminator, got:\n{}",
        generated.types_ts
    );

    // JSON 왕복: 태그 기반 역직렬화.
    let out: AreaOutput = package
        .invoke(
            "shapeArea",
            AreaInput {
                shape: Shape::Rectangle {
                    width: 3.0,
                    height: 4.0,
                },
            },
        )
        .unwrap();
    assert!((out.area - 12.0).abs() < 1e-9);
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

    let package = Package::builder("test.tuple").command_fn(tuple_cmd).build();
    let generated = package.generate_typescript().unwrap();

    assert!(
        generated.types_ts.contains("pair: [string, number];"),
        "tuple (String, i64) should become [string, number], got:\n{}",
        generated.types_ts
    );
    assert!(
        generated
            .types_ts
            .contains("triple: [string, number, boolean];"),
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
        .command_fn(enum_data_cmd)
        .build();
    let generated = package.generate_typescript().unwrap();

    assert!(
        generated.types_ts.contains("Circle") && generated.types_ts.contains("Rectangle"),
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

    let package = Package::builder("test.deep").command_fn(deep_cmd).build();
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
    #[derive(Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct BridgedInput {
        pub name: String,
        pub age: Option<u32>,
    }

    // Verify serialization with camelCase
    let input = BridgedInput {
        name: "test".into(),
        age: Some(25),
    };
    let json_val = serde_json::to_value(&input).unwrap();
    assert_eq!(json_val["name"], "test");
    assert_eq!(json_val["age"], 25);

    // Verify round-trip
    let de: BridgedInput = serde_json::from_value(json_val).unwrap();
    assert_eq!(de.name, "test");
    assert_eq!(de.age, Some(25));

    // Verify JsonSchema works
    let schema = schemars::schema_for!(BridgedInput);
    let schema_json = serde_json::to_value(&schema).unwrap();
    assert!(schema_json["$schema"].is_string());
}

#[test]
fn build_api_registers_scalar_command() {
    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct ScalarAddInput {
        a: i64,
        b: i64,
    }

    #[command]
    fn scalar_add(input: ScalarAddInput) -> Result<i64> {
        Ok(input.a + input.b)
    }

    let pkg = register!(Package::builder("test.scalar"), scalar_add).build();

    let result: i64 = pkg
        .invoke("scalarAdd", ScalarAddInput { a: 2, b: 3 })
        .unwrap();
    assert_eq!(result, 5);
}

#[test]
fn build_api_scalar_command_with_result() {
    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct ScalarDivideInput {
        a: i64,
        b: i64,
    }

    #[command]
    fn scalar_divide(input: ScalarDivideInput) -> Result<i64> {
        if input.b == 0 {
            Err(RustraError::invalid_args("division by zero"))
        } else {
            Ok(input.a / input.b)
        }
    }

    let pkg = register!(Package::builder("test.scalar"), scalar_divide).build();

    let result: i64 = pkg
        .invoke("scalarDivide", ScalarDivideInput { a: 10, b: 2 })
        .unwrap();
    assert_eq!(result, 5);

    let err =
        pkg.invoke::<ScalarDivideInput, i64>("scalarDivide", ScalarDivideInput { a: 10, b: 0 });
    assert!(err.is_err());
}

#[test]
fn build_api_generates_typescript() {
    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct GreetInput {
        name: String,
        greeting: String,
    }

    #[command]
    fn greet(input: GreetInput) -> Result<String> {
        Ok(format!("{}, {}!", input.greeting, input.name))
    }

    let dir = tempfile::tempdir().unwrap();
    let generated = register!(Package::builder("test.greet"), greet)
        .build()
        .generate_typescript()
        .unwrap();
    generated.write_to_dir(dir.path()).unwrap();

    assert!(dir.path().join("types.ts").exists());
    assert!(dir.path().join("commands.ts").exists());
    assert!(dir.path().join("schema.json").exists());
    assert!(dir.path().join("contract.ts").exists());

    let types_ts = fs::read_to_string(dir.path().join("types.ts")).unwrap();
    assert!(
        types_ts.contains("GreetInput"),
        "expected GreetInput type, got:\n{types_ts}"
    );
}

// ---- Runtime command registry (dev mutable / prod frozen) ----

#[test]
#[cfg(debug_assertions)]
fn runtime_register_adds_command_and_generates() {
    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct EchoInput {
        msg: String,
    }
    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct EchoOutput {
        echoed: String,
    }

    #[command]
    fn echo(input: EchoInput) -> Result<EchoOutput> {
        Ok(EchoOutput { echoed: input.msg })
    }

    let pkg = Package::builder("test.runtime").build(); // empty package
    pkg.register("echo", echo).unwrap();

    let out: EchoOutput = pkg.invoke("echo", EchoInput { msg: "hi".into() }).unwrap();
    assert_eq!(
        out,
        EchoOutput {
            echoed: "hi".into()
        }
    );

    // 런타임에 추가된 명령도 codegen 결과에 포함된다.
    let generated = pkg.generate_typescript().unwrap();
    assert!(generated.commands_ts.contains("export function echo"));
    assert!(generated.types_ts.contains("EchoInput"));
}

#[test]
#[cfg(debug_assertions)]
fn runtime_register_fn_derives_name() {
    let pkg = Package::builder("test.register_fn").build();
    pkg.register_fn(add_numbers).unwrap();
    let out: AddNumbersOutput = pkg
        .invoke("addNumbers", AddNumbersInput { a: 5, b: 7 })
        .unwrap();
    assert_eq!(out.value, 12);
}

#[test]
#[cfg(debug_assertions)]
fn frozen_package_rejects_mutation() {
    let pkg = Package::builder("test.frozen").build();
    pkg.register("cmd", add_numbers).unwrap();
    pkg.freeze();

    assert_eq!(
        pkg.register("other", add_numbers).unwrap_err().code(),
        "registry.frozen"
    );
    assert_eq!(pkg.unregister("cmd").unwrap_err().code(), "registry.frozen");
    assert_eq!(
        pkg.replace("cmd", add_numbers).unwrap_err().code(),
        "registry.frozen"
    );

    // 동결 상태에서도 호출은 정상
    let out: AddNumbersOutput = pkg.invoke("cmd", AddNumbersInput { a: 40, b: 2 }).unwrap();
    assert_eq!(out.value, 42);
}

#[test]
#[cfg(not(debug_assertions))]
fn release_build_is_frozen_by_default() {
    let pkg = Package::builder("test.release_frozen").build();
    assert!(pkg.is_frozen(), "release build should be frozen by default");
    assert_eq!(
        pkg.register("cmd", add_numbers).unwrap_err().code(),
        "registry.frozen"
    );
}

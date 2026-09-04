use rustra::prelude::*;
use std::fs;
use std::process::Command;
use std::thread;
use std::time::Duration;

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

/// Adds two numbers and exposes this sentence to generated TypeScript callers.
#[command]
fn documented_add(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput {
        value: input.a + input.b,
    })
}

/// `#[command(capability = "...")]` 속성 — require_capability 문자열 결합 없이
/// 매크로 시점에 권한을 심는다 (register!/build! 가 require_capability_if 로 연결).
#[command(capability = "compute:secure")]
fn locked_add(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput {
        value: input.a + input.b + 1000,
    })
}

fn mobile_package() -> Package {
    Package::builder("example.mobile").build()
}

rustra::native_entry!(mobile_package);

#[test]
fn native_entry_exposes_the_stable_native_initialization_contract() {
    rustra_mobile_init();
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
    assert!(
        generated
            .commands_ts
            .contains("export const addNumbers = createGeneratedFields2")
    );
    assert!(generated.commands_ts.contains("'addNumbers'"));
}

/// 코드젠 경고 소비 계약 — 정상 스키마는 경고가 비어 있고, 생성 파일 바이트는
/// 경고 유무와 무관하다(별도 진행 채널).
#[test]
fn codegen_of_wellformed_schemas_reports_no_warnings() {
    let generated = Package::builder("example.warnings")
        .command_fn(add_numbers)
        .build()
        .generate_typescript()
        .unwrap();
    assert!(
        generated.warnings.is_empty(),
        "well-formed schema must not produce codegen warnings: {:?}",
        generated.warnings
    );
}

#[test]
fn command_doc_comments_flow_to_schema_and_typescript_jsdoc() {
    let generated = register!(Package::builder("example.docs"), documented_add)
        .build()
        .generate_typescript()
        .unwrap();
    assert!(generated.schema_json.contains("documentedAdd"));
    assert!(
        generated
            .schema_json
            .contains("Adds two numbers and exposes this sentence")
    );
    assert!(
        generated
            .commands_ts
            .contains("Adds two numbers and exposes this sentence")
    );
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
fn command_capability_attribute_enforces_deny_by_default() {
    // register! 가 #[command(capability)] 메타를 읽어 require_capability_if 로
    // 연결하는지 — grant 전 deny, grant 후 허용.
    let package = register!(Package::builder("example.calculator"), locked_add).build();

    // grant 전에는 deny-by-default.
    assert_eq!(
        package
            .invoke::<_, AddNumbersOutput>("lockedAdd", AddNumbersInput { a: 1, b: 1 })
            .unwrap_err()
            .code(),
        "capability.denied"
    );

    // grant 후에는 핸들러가 실행된다.
    package.grant_capability("compute:secure").unwrap();
    let out: AddNumbersOutput = package
        .invoke("lockedAdd", AddNumbersInput { a: 1, b: 1 })
        .unwrap();
    assert_eq!(out.value, 1002);
}

#[test]
fn build_macro_also_applies_capability_attribute() {
    // build! 경로도 동일하게 연결된다.
    let package = build!("example.calculator", locked_add).done();

    assert_eq!(
        package
            .invoke::<_, AddNumbersOutput>("lockedAdd", AddNumbersInput { a: 2, b: 2 })
            .unwrap_err()
            .code(),
        "capability.denied"
    );
    package.grant_capability("compute:secure").unwrap();
    let out: AddNumbersOutput = package
        .invoke("lockedAdd", AddNumbersInput { a: 2, b: 2 })
        .unwrap();
    assert_eq!(out.value, 1004);
}

/// (감사 #5) capability 무음 드랍 차단 — `#[command(capability = "...")]` 함수를
/// 일반 등록 경로(`.command_fn`/`.command`)로 등록하면 capability 가 조용히
/// 버려진다. 계약: 그 등록은 **컴파일 에러**로 거부되고, register!/build! 경로는
/// capability 를 require_capability 로 연결한다(위의
/// command_capability_attribute_enforces_deny_by_default 테스트).
///
/// trybuild 가 없으므로 기존 관례(command_macro_rejects_wrong_signature)대로
/// 중첩 temp crate cargo check 로 컴파일 실패를 증명한다.
#[test]
fn capability_command_cannot_be_silently_registered_without_capability() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let workspace_dir = std::path::Path::new(&manifest_dir)
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let workspace_dir = workspace_dir.display().to_string().replace('\\', "/");
    let tmp_dir = std::env::temp_dir().join(format!("rustra-cap-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp_dir);

    // try_compile: 단일 temp crate 에 `source` 를 넣고 cargo check. 밀폐성(I2) —
    // 네트워크 차단 환경에서 중첩 cargo 가 crates.io 해석 오류로 fail-open 하지
    // 않도록 CARGO_NET_OFFLINE 을 강제한다.
    let try_compile = |source: &str| -> (bool, String) {
        std::fs::create_dir_all(tmp_dir.join("src")).unwrap();
        std::fs::write(
            tmp_dir.join("Cargo.toml"),
            format!(
                "[package]\nname = \"cap-test\"\nedition = \"2024\"\nversion = \"0.1.0\"\n\n\
                [dependencies]\nrustra = {{ path = \"{}/crates/rustra\" }}\n\
                serde = {{ version = \"1\", features = [\"derive\"] }}\n\
                schemars = {{ version = \"0.8\", features = [\"derive\"] }}\n",
                workspace_dir
            ),
        )
        .unwrap();
        std::fs::write(tmp_dir.join("src").join("lib.rs"), source).unwrap();

        let output = Command::new("cargo")
            .args(["check"])
            .env("CARGO_NET_OFFLINE", "true")
            .current_dir(&tmp_dir)
            .output()
            .unwrap();

        let stderr = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        (output.status.success(), stderr)
    };

    // try_compile_cross_crate: lib 크레이트(`lib_source`) + 의존하는 user
    // 크레이트(`user_source`)의 2-크레이트 임시 워크스페이스. 매크로 생성
    // 심벌의 프라이버시는 모듈 경계가 아니라 크레이트 경계에서만 검증되므로
    // (자식 모듈은 부모의 private 도 이름解할 수 있다) 우회 차단 계약은 이
    // 레이아웃으로 증명한다.
    let try_compile_cross_crate = |lib_source: &str, user_source: &str| -> (bool, String) {
        for d in ["lib", "lib/src", "user", "user/src"] {
            std::fs::create_dir_all(tmp_dir.join(d)).unwrap();
        }
        let manifest = format!(
            "[package]\nname = \"cap-lib\"\nedition = \"2024\"\nversion = \"0.1.0\"\n\n\
             [dependencies]\nrustra = {{ path = \"{}/crates/rustra\" }}\n\
             serde = {{ version = \"1\", features = [\"derive\"] }}\n\
             schemars = {{ version = \"0.8\", features = [\"derive\"] }}\n",
            workspace_dir
        );
        std::fs::write(tmp_dir.join("lib").join("Cargo.toml"), manifest).unwrap();
        std::fs::write(tmp_dir.join("lib").join("src").join("lib.rs"), lib_source).unwrap();
        std::fs::write(
            tmp_dir.join("user").join("Cargo.toml"),
            format!(
                "[package]\nname = \"cap-user\"\nedition = \"2024\"\nversion = \"0.1.0\"\n\n\
                 [dependencies]\ncap-lib = {{ path = \"../lib\" }}\n\
                 rustra = {{ path = \"{}/crates/rustra\" }}\n",
                workspace_dir
            ),
        )
        .unwrap();
        std::fs::write(tmp_dir.join("user").join("src").join("lib.rs"), user_source).unwrap();
        std::fs::write(
            tmp_dir.join("Cargo.toml"),
            "[workspace]\nmembers = [\"lib\", \"user\"]\nresolver = \"2\"\n",
        )
        .unwrap();

        let output = Command::new("cargo")
            .args(["check", "--offline"])
            .env("CARGO_NET_OFFLINE", "true")
            .current_dir(tmp_dir.join("user"))
            .output()
            .unwrap();

        let stderr = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        (output.status.success(), stderr)
    };

    let shared = "\
        use rustra::prelude::*;\n\
        #[derive(Serialize, Deserialize, JsonSchema)]\n\
        pub struct In { pub x: i64 }\n\
        #[derive(Serialize, Deserialize, JsonSchema)]\n\
        pub struct Out { pub y: i64 }\n\
        #[command(capability = \"test:secure\")]\n\
        pub fn locked(input: In) -> Result<Out> { Ok(Out { y: input.x }) }\n\
        #[command(capability = \"test:secure2\")]\n\
        pub fn locked2(input: In) -> Result<Out> { Ok(Out { y: input.x }) }\n";

    // GREEN 경로 — register! 는 capability 를 연결하므로 컴파일된다.
    let (ok, stderr) = try_compile(&format!(
        "{shared}\n\
         pub fn pkg() -> Package {{ register!(Package::builder(\"cap.ok\"), locked).build() }}\n"
    ));
    assert!(
        ok,
        "register! must keep wiring the capability; got:\n{stderr}"
    );

    // 계약 — 일반 등록 경로는 컴파일 에러로 거부되고, 에러가 capability 를 이름한다.
    let (ok, stderr) = try_compile(&format!(
        "{shared}\n\
         #[allow(dead_code)]\n\
         fn silent_drop_a() {{\n\
         \x20   let _ = Package::builder(\"cap.bad\").command_fn(locked);\n\
         }}\n\
         #[allow(dead_code)]\n\
         fn silent_drop_b() {{\n\
         \x20   let _ = Package::builder(\"cap.bad\").command(\"locked2\", locked2);\n\
         }}\n"
    ));
    assert!(
        !ok,
        "capability fn must NOT compile through plain registration \
         (capability silently dropped); got:\n{stderr}"
    );
    assert!(
        stderr.contains("capability"),
        "compile error must name the capability contract; got:\n{stderr}"
    );

    // 우회 차단(감사 #5 후속) — 매크로가 생성하는 inner 클론과 등록 어댑터는
    // 비공개여야 한다. 공개라면 안전 `fn`/`__rustra_register_{fn}` 을 그대로
    // `.command_fn` 에 넘겨 capability 없이 등록하는 우회 경로가 된다.
    // 프라이버시는 크레이트 경계에서만 강제되므로(자식 모듈은 부모의 private 도
    // 이름 解 가능) 2-크레이트 임시 워크스페이스로 증명한다 — 참조는 E0603.
    let (ok, stderr) = try_compile_cross_crate(
        &format!(
            "{shared}\n\
             pub fn pkg_ok() -> Package {{ register!(Package::builder(\"cap.ok\"), locked).build() }}\n"
        ),
        "\
         #[allow(dead_code)]\n\
         fn bypass_inner() {\n\
         \x20   let _ = rustra::Package::builder(\"x\").command_fn(cap_lib::__rustra_inner_locked);\n\
         }\n\
         #[allow(dead_code)]\n\
         fn bypass_adapter() {\n\
         \x20   let _ = rustra::Package::builder(\"x\").command_fn(cap_lib::__rustra_register_locked);\n\
         }\n",
    );
    assert!(
        !ok,
        "inner clone and register adapter must be private (no bypass via \
         __rustra_inner_* / __rustra_register_*); got:\n{stderr}"
    );
    assert!(
        stderr.contains("private"),
        "bypass rejection must be a privacy error (E0603); got:\n{stderr}"
    );

    // 잔여 허용 경로가 여전히 유효한지 — cap-lib 의 문서화된 표면(register!로
    // 만든 패키지)은 크로스 크레이트에서 그대로 동작한다.
    let (ok, stderr) = try_compile_cross_crate(
        &format!(
            "{shared}\n\
             pub fn pkg_ok() -> Package {{ register!(Package::builder(\"cap.ok\"), locked).build() }}\n"
        ),
        "pub fn use_pkg() -> rustra::Package { cap_lib::pkg_ok() }\n\
         pub fn invoke_ok() -> i64 {\n\
         \x20   let pkg = use_pkg();\n\
         \x20   pkg.grant_capability(\"test:secure\").unwrap();\n\
         \x20   pkg.invoke::<cap_lib::In, cap_lib::Out>(\"locked\", cap_lib::In { x: 9 }).unwrap().y\n\
         }\n",
    );
    // user 크레이트는 rustra 를 직접 의존해야 한다(타입 언급).
    assert!(
        ok,
        "documented cross-crate surface (register!-built package) must keep \
         compiling; got:\n{stderr}"
    );

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[test]
fn package_generates_host_neutral_typescript_client() {
    let package = Package::builder("example.calculator")
        .command_fn(add_numbers)
        .build();

    let generated = package.generate_typescript().unwrap();

    assert!(generated.types_ts.contains("export type AddNumbersInput"));
    assert!(
        generated
            .commands_ts
            .contains("export const addNumbers = createGeneratedFields2")
    );
    assert!(
        generated
            .commands_ts
            .contains("createGeneratedFields2<AddNumbersInput, AddNumbersOutput>")
    );
    assert!(
        generated
            .commands_ts
            .contains("(1, 'addNumbers', \"a\", \"b\", 'addNumbers')")
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

/// 단일 테스트로 병합한 이유 — `RUSTRA_SCHEMA_OUT` 는 프로세스 전역 env 다. 두 시나리오를
/// 별도 테스트로 나누면 카고 병렬 실행 시 서로의 env 를 오염시켜 간헐적으로 깨진다.
#[test]
fn write_schema_to_dir_emits_schema_only_and_honors_rustra_schema_out() {
    let output_dir = std::env::temp_dir().join(format!("rustra-probe-{}", std::process::id()));
    let override_dir =
        std::env::temp_dir().join(format!("rustra-probe-override-{}", std::process::id()));

    let _ = std::fs::remove_dir_all(&output_dir);
    let _ = std::fs::remove_dir_all(&override_dir);
    let generated = Package::builder("example.calculator")
        .command_fn(add_numbers)
        .build()
        .generate_typescript()
        .unwrap();

    // 시나리오 1 — 프로브 계약: schema.json 만 쓰고 TS 표면은 손대지 않는다.
    generated.write_schema_to_dir(&output_dir).unwrap();
    assert!(output_dir.join("schema.json").exists());
    assert!(!output_dir.join("types.ts").exists());
    assert!(!output_dir.join("commands.ts").exists());
    assert!(!output_dir.join("contract.ts").exists());

    // 시나리오 2 — RUSTRA_SCHEMA_OUT 우회: codegen --check 의 임시 디렉토리 검증 경로.
    let write_result = unsafe {
        std::env::set_var("RUSTRA_SCHEMA_OUT", &override_dir);
        let result = generated.write_schema_to_dir(&output_dir);
        std::env::remove_var("RUSTRA_SCHEMA_OUT");
        result
    };
    write_result.unwrap();
    assert!(override_dir.join("schema.json").exists());
    // requested 쪽 두 번째 쓰기는 override 로 리다이렉트됐다 — requested 는 시나리오 1 산출물만.
    assert_eq!(std::fs::read_dir(&override_dir).unwrap().count(), 1);

    std::fs::remove_dir_all(output_dir).unwrap();
    std::fs::remove_dir_all(override_dir).unwrap();
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
        // `Option<i64>` 는 union(["integer","null"]) 로 내려오므로 format
        // int64 를 확인해 `number | bigint` 로 넓힌다(TS CLI 규칙과 동일).
        generated.types_ts.contains("age?: number | bigint | null;"),
        "optional int field should be age?: number | bigint | null; got:\n{}",
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
                // Windows 경로의 백슬래시는 TOML 기본 문자열에서 이스케이프로
                // 해석돼 매니페스트가 깨진다 — forward-slash 로 정규화 (cargo 는
                // Windows 에서도 슬래시 경로를 받아들인다).
                workspace_dir.display().to_string().replace('\\', "/")
            ),
        )
        .unwrap();
        std::fs::write(tmp_dir.join("src").join("lib.rs"), source).unwrap();

        let output = Command::new("cargo")
            .args(["check"])
            // 밀폐성 — 오프라인 환경에서 crates.io 해석 오류가 컴파일 실패로
            // 오독되지 않도록 오프라인을 강제한다.
            .env("CARGO_NET_OFFLINE", "true")
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

    let zero_args = try_compile(
        "use rustra::prelude::*;\n\
         #[command]\n\
         pub fn no_args() -> Result<()> { Ok(()) }\n",
    );
    assert!(zero_args, "zero args command should compile");

    let async_cmd = try_compile(
        "use rustra::prelude::*;\n\
         #[command]\n\
         pub async fn async_cmd() -> Result<()> { Ok(()) }\n",
    );
    assert!(async_cmd, "async fn command should compile");

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
            .contains("scores: Record<string, number | bigint>;"),
        "HashMap<String, i64> should become Record<string, number | bigint>, got:\n{}",
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
        generated.types_ts.contains("primes: Set<number | bigint>;"),
        "BTreeSet<i64> should become Set<number | bigint>, got:\n{}",
        generated.types_ts
    );
    assert!(
        generated.types_ts.contains("unique: Set<number | bigint>;"),
        "output BTreeSet<i64> should become Set<number | bigint>, got:\n{}",
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
fn ts_generator_exposes_both_vec_u8_runtime_representations() {
    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    struct BytesPayload {
        data: Vec<u8>,
    }

    #[command]
    fn echo_bytes(input: BytesPayload) -> Result<BytesPayload> {
        Ok(input)
    }

    let generated = Package::builder("test.bytes")
        .command_fn(echo_bytes)
        .build()
        .generate_typescript()
        .unwrap();
    assert!(
        generated
            .types_ts
            .contains("data: Uint8Array | ArrayBuffer | number[];"),
        "Vec<u8> must describe JSON and native byte-buffer representations, got:\n{}",
        generated.types_ts
    );
    assert!(
        generated
            .commands_ts
            .contains("invokeGeneratedBytes<BytesPayload>"),
        "single Vec<u8> commands must use the dedicated generated helper, got:\n{}",
        generated.commands_ts
    );
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
        generated
            .types_ts
            .contains("pair: [string, number | bigint];"),
        "tuple (String, i64) should become [string, number | bigint], got:\n{}",
        generated.types_ts
    );
    assert!(
        generated
            .types_ts
            .contains("triple: [string, number | bigint, boolean];"),
        "tuple (String, i64, bool) should become [string, number | bigint, boolean], got:\n{}",
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
        generated
            .types_ts
            .contains("matrix: ((number | bigint)[])[];"),
        "Vec<Vec<i64>> should become ((number | bigint)[])[], got:\n{}",
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

#[test]
fn generated_output_skips_unchanged_writes() {
    let dir = tempfile::tempdir().unwrap();
    let generated = register!(Package::builder("test.write-stability"), add_numbers)
        .build()
        .generate_typescript()
        .unwrap();

    generated.write_to_dir(dir.path()).unwrap();
    let before = fs::metadata(dir.path().join("schema.json"))
        .unwrap()
        .modified()
        .unwrap();
    thread::sleep(Duration::from_millis(20));
    generated.write_to_dir(dir.path()).unwrap();
    let after = fs::metadata(dir.path().join("schema.json"))
        .unwrap()
        .modified()
        .unwrap();

    assert_eq!(
        before, after,
        "unchanged generated files must not be rewritten"
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

#[test]
#[cfg(debug_assertions)]
fn replace_preserves_required_capability() {
    let pkg = Package::builder("test.cap_replace")
        .command("secret", add_numbers)
        .require_capability("secret", "admin:access")
        .build();

    // Denied before grant
    assert_eq!(
        pkg.invoke::<_, AddNumbersOutput>("secret", AddNumbersInput { a: 1, b: 2 })
            .unwrap_err()
            .code(),
        "capability.denied"
    );

    // Replace the handler with another function
    fn add_numbers_alt(input: AddNumbersInput) -> Result<AddNumbersOutput> {
        Ok(AddNumbersOutput {
            value: input.a + input.b + 10,
        })
    }
    pkg.replace("secret", add_numbers_alt).unwrap();

    // Still denied because required_capability must be preserved
    assert_eq!(
        pkg.invoke::<_, AddNumbersOutput>("secret", AddNumbersInput { a: 1, b: 2 })
            .unwrap_err()
            .code(),
        "capability.denied"
    );

    // After grant, invokes replaced handler
    pkg.grant_capability("admin:access").unwrap();
    let out: AddNumbersOutput = pkg
        .invoke("secret", AddNumbersInput { a: 1, b: 2 })
        .unwrap();
    assert_eq!(out.value, 13);
}

#[test]
fn ts_generator_handles_unit_output_type() {
    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct VoidInput {
        action: String,
    }

    #[command]
    fn do_action(_input: VoidInput) -> Result<()> {
        Ok(())
    }

    let pkg = Package::builder("test.void").command_fn(do_action).build();
    let generated = pkg.generate_typescript().unwrap();

    // Should NOT contain invalid "export type () = null"
    assert!(
        !generated.types_ts.contains("export type ()"),
        "types.ts should not define type () = ...: got\n{}",
        generated.types_ts
    );
    // Should NOT import ()
    assert!(
        !generated.commands_ts.contains("()"),
        "commands.ts should not import or reference () type: got\n{}",
        generated.commands_ts
    );
    // Should generate Promise<void>
    assert!(
        generated.commands_ts.contains(
            "export function doAction(input: VoidInput, options?: InvokeOptions): Promise<void>"
        ),
        "commands.ts should map unit to Promise<void>: got\n{}",
        generated.commands_ts
    );
}

#[test]
fn ffi_free_handles_zero_byte_allocation() {
    let mut out_len = 0;
    // contract_hash when not set returns empty string (0-byte payload)
    let ptr = unsafe { rustra::ffi::rustra_ffi_contract_hash(&mut out_len) };
    assert!(!ptr.is_null());
    assert_eq!(out_len, 0);
    // rustra_ffi_free must safely free 0-byte allocation without leaking or crashing
    unsafe { rustra::ffi::rustra_ffi_free(ptr, out_len) };
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
struct StatusOutput {
    online: bool,
    counter: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
struct EchoOutput {
    msg: String,
}

struct AppConfig {
    app_name: String,
    multiplier: i64,
}

#[command]
fn ping_server() -> Result<StatusOutput> {
    Ok(StatusOutput {
        online: true,
        counter: 42,
    })
}

#[command]
async fn async_ping() -> Result<StatusOutput> {
    Ok(StatusOutput {
        online: true,
        counter: 100,
    })
}

#[command]
fn get_with_state(input: AddNumbersInput, config: State<AppConfig>) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput {
        value: (input.a + input.b) * config.multiplier,
    })
}

#[command]
async fn async_with_state(config: State<AppConfig>) -> Result<EchoOutput> {
    Ok(EchoOutput {
        msg: config.app_name.clone(),
    })
}

#[test]
fn zero_arg_and_async_command_execution() {
    let pkg = Package::builder("test.dx")
        .command_fn(ping_server)
        .command_fn(async_ping)
        .build();

    let res: StatusOutput = pkg.invoke("pingServer", ()).unwrap();
    assert!(res.online);
    assert_eq!(res.counter, 42);

    let res_async: StatusOutput = pkg.invoke("asyncPing", ()).unwrap();
    assert!(res_async.online);
    assert_eq!(res_async.counter, 100);

    let generated = pkg.generate_typescript().unwrap();
    assert!(
        generated
            .commands_ts
            .contains("export function pingServer(options?: InvokeOptions): Promise<StatusOutput>")
    );
    assert!(
        generated
            .commands_ts
            .contains("export function asyncPing(options?: InvokeOptions): Promise<StatusOutput>")
    );
}

#[test]
fn state_dependency_injection_works() {
    let config = AppConfig {
        app_name: "RustraBridgeApp".to_string(),
        multiplier: 10,
    };

    let pkg = Package::builder("test.dx.state")
        .manage(config)
        .command_fn(get_with_state)
        .command_fn(async_with_state)
        .build();

    // Verify State getter
    let state = pkg
        .state::<AppConfig>()
        .expect("State<AppConfig> must exist");
    assert_eq!(state.app_name, "RustraBridgeApp");

    // Invoke sync command with State
    let res: AddNumbersOutput = pkg
        .invoke("getWithState", AddNumbersInput { a: 2, b: 3 })
        .unwrap();
    assert_eq!(res.value, 50);

    // Invoke async command with State and 0 data args
    let res_echo: EchoOutput = pkg.invoke("asyncWithState", ()).unwrap();
    assert_eq!(res_echo.msg, "RustraBridgeApp");
}

// ── (이벤트 계약) PackageBuilder::event 선언 → schema.json events 섹션 ──

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    value: i64,
}

#[test]
fn event_contract_appears_in_schema_json() {
    let package = Package::builder("example.stream")
        .event::<ProgressPayload>("progress.tick")
        .build();

    let schema = package.live_schema();
    let events = schema["events"].as_array().expect("events section present");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["name"], "progress.tick");
    assert!(
        events[0]["payload"]["properties"]["value"].is_object(),
        "payload schema is exposed: {}",
        events[0]["payload"]
    );
}

#[test]
fn schema_without_events_has_no_section() {
    // 하위호환 — event 선언이 없으면 events 키 자체가 없다.
    let package = Package::builder("example.plain").build();
    let schema = package.live_schema();
    assert!(schema.get("events").is_none());
}

#[test]
fn event_contract_flows_to_generate_typescript_schema() {
    let package = Package::builder("example.stream")
        .event::<ProgressPayload>("progress.tick")
        .build();
    let generated = package.generate_typescript().unwrap();
    assert!(
        generated.schema_json.contains("\"events\""),
        "generate_typescript schema includes events section"
    );
    assert!(generated.schema_json.contains("progress.tick"));
}

// ── (사용자 정의 제네릭) 모노몰포이즈 스키마가 전 계층에서 식별자로 흐른다 ──
//
// schemars 0.8은 제네릭 구조체의 구체 인스턴스마다 `Wrapper_for_String` 형태의
// 모노몰포이즈 스키마 이름을 만든다(유효 TS 식별자). 명령의 inputType/outputType도
// 이 이름과 정합해야 한다 — type_name의 `Wrapper<String >` 꼴은 비식별자라 검증과
// TS 코드젠이 모두 깨진다. 3계층 계약:
//   (1) schema.json의 inputType/outputType이 유효 식별자 (schemars title과 일치)
//   (2) generate_typescript가 `export type Wrapper_for_String = ...` 방출
//   (3) TS 렌더러(CLI)도 같은 이름으로 렌더 — wire round-trip은 스키마 주도라 불변

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct Wrapper<T> {
    value: T,
}

#[command]
fn echo_wrapped(input: Wrapper<String>) -> Result<Wrapper<String>> {
    Ok(Wrapper { value: input.value })
}

#[test]
fn generic_root_type_yields_identifier_input_type_matching_schemars_title() {
    let package = Package::builder("example.generic")
        .command("echoWrapped", echo_wrapped)
        .build();
    let schema = package.live_schema();
    let commands = schema["commands"].as_array().expect("commands section");
    let echo = &commands[0];

    let input_type = echo["inputType"].as_str().expect("inputType string");
    assert!(
        !input_type.contains('<') && !input_type.contains('>'),
        "inputType must be a plain identifier, got: {input_type}"
    );
    // schemars 의 모노몰포이즈 이름과 정합 — definitions 키·루트 title 이 이 이름으로
    // 만들어지므로 코드젠 전 계층이 하나의 이름으로 묶인다.
    assert_eq!(
        input_type,
        <Wrapper<String> as schemars::JsonSchema>::schema_name(),
        "inputType must match the schemars schema_name"
    );
    // 루트 스키마 title 도 같은 이름 — inputType 이 스키마를 지목하는 유일한 대상.
    assert_eq!(echo["inputSchema"]["title"], input_type);
    assert_eq!(echo["outputType"], echo["inputType"]);
}

#[test]
fn generic_root_type_renders_valid_typescript() {
    let package = Package::builder("example.generic")
        .command("echoWrapped", echo_wrapped)
        .build();
    let generated = package.generate_typescript().unwrap();

    let name = <Wrapper<String> as schemars::JsonSchema>::schema_name();
    let expected = format!("export type {name} = {{");
    assert!(
        generated.types_ts.contains(&expected),
        "generated types.ts must emit the monomorphized type:\n{}",
        generated.types_ts
    );
    assert!(
        !generated.types_ts.contains("Wrapper<String"),
        "raw generic type_name must never leak into generated TS:\n{}",
        generated.types_ts
    );
}

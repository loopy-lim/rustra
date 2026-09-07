//! command_errors 빌더 단위 테스트 — lib.rs 의 `#[cfg(test)] mod` 스탠드얼론
//! 테스트 모듈 관례(builder_platform_tests.rs 참고).

use crate::{CommandErrorVariant, Package, RustraError};

fn errors_package() -> Package {
    Package::builder("example.errors")
        .command("divide", |input: serde_json::Value| {
            Ok::<_, RustraError>(input)
        })
        .command_errors(
            "divide",
            &[CommandErrorVariant::new("math.divide_by_zero").describe("0으로 나눌 때")],
        )
        .build()
}

#[test]
fn command_errors_records_variants() {
    let package = errors_package();
    // Task 2 이전에는 내부 상태 direct assert — commands BTreeMap 접근.
    let state = package
        .state
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let command = state.commands.get("divide").expect("divide registered");
    assert_eq!(command.error_variants.len(), 1);
    assert_eq!(command.error_variants[0].code(), "math.divide_by_zero");
    assert_eq!(
        command.error_variants[0].description(),
        Some("0으로 나눌 때")
    );
    assert!(!command.error_variants[0].is_retryable());
}

/// 선언 없는 명령의 error_variants 는 빈 벡터 — 기존 패키지 계약 불변.
#[test]
fn command_without_declaration_keeps_empty_variants() {
    let package = Package::builder("example.errors")
        .command("divide", |input: serde_json::Value| {
            Ok::<_, RustraError>(input)
        })
        .build();
    let state = package
        .state
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    assert!(
        state
            .commands
            .get("divide")
            .unwrap()
            .error_variants
            .is_empty(),
        "undeclared command must not carry error variants"
    );
}

/// const 문맥 구성 — #[command(error(...))] 매크로가 생성하는 상수와 같은 형태.
#[test]
fn command_error_variant_composes_in_const_context() {
    const VARIANTS: &[CommandErrorVariant] = &[
        CommandErrorVariant::new("math.divide_by_zero").describe("0으로 나눌 때"),
        CommandErrorVariant::new("math.overflow").retryable(),
    ];
    assert_eq!(VARIANTS[0].code(), "math.divide_by_zero");
    assert_eq!(VARIANTS[1].description(), None);
    assert!(VARIANTS[1].is_retryable());
}

#[test]
fn errors_meta_if_is_noop_on_none_and_sets_on_some() {
    const DECLARED: &[CommandErrorVariant] = &[CommandErrorVariant::new("math.divide_by_zero")];

    // None — 선언 없는 #[command] 도 체인을 그대로 통과한다(platform_meta_if 관례).
    let package = Package::builder("example.errors")
        .command("divide", |input: serde_json::Value| {
            Ok::<_, RustraError>(input)
        })
        .errors_meta_if("divide", None)
        .build();
    let state = package
        .state
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    assert!(
        state
            .commands
            .get("divide")
            .unwrap()
            .error_variants
            .is_empty()
    );

    // Some — command_errors 와 동일하게 기록된다.
    let package = Package::builder("example.errors")
        .command("divide", |input: serde_json::Value| {
            Ok::<_, RustraError>(input)
        })
        .errors_meta_if("divide", Some(DECLARED))
        .build();
    let state = package
        .state
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    assert_eq!(
        state.commands.get("divide").unwrap().error_variants.len(),
        1
    );
}

#[test]
#[should_panic(expected = "command_errors: command 'nope' is not registered")]
fn command_errors_panics_on_unknown_command() {
    let _ = Package::builder("example.errors")
        .command("divide", |input: serde_json::Value| {
            Ok::<_, RustraError>(input)
        })
        .command_errors("nope", &[CommandErrorVariant::new("math.divide_by_zero")])
        .build();
}

#[test]
#[should_panic(expected = "invalid error code")]
fn command_errors_panics_on_invalid_code_pattern() {
    // "Math/Divide" (대문자/슬래시) — ^[a-z][a-z0-9_.]*$ 위반.
    let _ = Package::builder("example.errors")
        .command("divide", |input: serde_json::Value| {
            Ok::<_, RustraError>(input)
        })
        .command_errors("divide", &[CommandErrorVariant::new("Math/Divide")])
        .build();
}

#[test]
#[should_panic(expected = "duplicate error code")]
fn command_errors_panics_on_duplicate_code() {
    let _ = Package::builder("example.errors")
        .command("divide", |input: serde_json::Value| {
            Ok::<_, RustraError>(input)
        })
        .command_errors(
            "divide",
            &[
                CommandErrorVariant::new("math.divide_by_zero"),
                CommandErrorVariant::new("math.divide_by_zero"),
            ],
        )
        .build();
}

#[test]
#[should_panic(expected = "errors must not be empty")]
fn command_errors_panics_on_empty_slice() {
    let _ = Package::builder("example.errors")
        .command("divide", |input: serde_json::Value| {
            Ok::<_, RustraError>(input)
        })
        .command_errors("divide", &[])
        .build();
}

// ── 스키마 엔트리 — 조건부 "errors" 필드 (platforms 관례와 동일) ──

#[test]
fn schema_entry_includes_errors_when_declared() {
    let schema = errors_package().live_schema();
    let errors = schema["commands"][0]["errors"]
        .as_array()
        .expect("declared command records an errors array");
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0]["code"], "math.divide_by_zero");
    assert_eq!(errors[0]["description"], "0으로 나눌 때");
    assert_eq!(errors[0]["retryable"], false);
    // 원소는 항상 3키 고정 — 바이트 안정성(조건부는 errors 필드 자체와
    // 배열 원소 수준에서만).
    let keys: Vec<&str> = errors[0]
        .as_object()
        .expect("variant is an object")
        .keys()
        .map(|key| key.as_str())
        .collect();
    assert_eq!(keys, vec!["code", "description", "retryable"]);
}

#[test]
fn schema_entry_omits_errors_when_undeclared() {
    let package = Package::builder("example.errors")
        .command("divide", |input: serde_json::Value| {
            Ok::<_, RustraError>(input)
        })
        .build();
    let schema = package.live_schema();
    // 선언 없는 명령 엔트리에 "errors" 키가 없어야 한다 — 기존 패키지의
    // schema.json/계약 해시 불변.
    assert!(
        schema["commands"][0].get("errors").is_none(),
        "undeclared command must not record an errors key: {}",
        schema["commands"][0]
    );
}

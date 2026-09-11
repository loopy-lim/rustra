//! UniFFI 미러 계층 통합 테스트 — `--features uniffi` 빌드에서만 실행된다.
//!
//! 생성된 래퍼는 `calculator_package()` OnceLock 싱글턴을 공유하므로, 레지스트리를
//! mutate 하는 명령(rustraRegistryDemo/freeze)은 여기서 호출하지 않는다 — 싱글턴
//! 상태가 다른 테스트로 샐 수 있다. 레지스트리 자체의 계약은 lib.rs 단위 테스트가
//! 개별 패키지에서 검증한다.
#![cfg(feature = "uniffi")]

use rustra_calculator_example::uniffi_api::{
    AddNumbersInput, DivideInput, KindEchoInput, OpKind, RustraCommandFailure, TagSetInput,
    WideAggInput, addNumbers, contractHash, deviceDemo, divide, getSchema, invokeJson, kindEcho,
    tagSet, wideAgg,
};

/// 성공 경로 — 생성 래퍼가 invoke_typed 로 실제 커맨드에 위임한다.
#[test]
fn add_numbers_wrapper_round_trips() {
    let out = addNumbers(AddNumbersInput { a: 2, b: 3 }).unwrap();
    assert_eq!(out.value, 5);
}

/// 타입 에러 경로 — RustraError 가 RustraCommandFailure 로 변환되어 전파된다.
#[test]
fn divide_by_zero_maps_to_typed_failure() {
    let error = divide(DivideInput { a: 10, b: 0 }).unwrap_err();
    let text = error.to_string();
    match error {
        RustraCommandFailure::Failure {
            code,
            detail,
            retryable,
        } => {
            assert_eq!(code, "math.divide_by_zero");
            assert_eq!(detail, "cannot divide by zero");
            assert!(!retryable);
        }
    }
    // Display — 에러 미러의 사람용 표현.
    assert!(text.contains("math.divide_by_zero"), "{text}");
}

/// 데이터 동반 enum 미러 왕복 — 외부 태그 oneOf 스키마의 변형 순서 보존.
#[test]
fn kind_echo_enum_variant_round_trips() {
    let out = kindEcho(KindEchoInput {
        kind: OpKind::Set { value: 42 },
    })
    .unwrap();
    match out.echoed {
        OpKind::Set { value } => assert_eq!(value, 42),
        OpKind::Clear => panic!("wrong variant"),
    }
    assert!(matches!(
        kindEcho(KindEchoInput {
            kind: OpKind::Clear,
        })
        .unwrap()
        .echoed,
        OpKind::Clear
    ));
}

/// 셋(uniqueItems) 미러 — Vec 경계 표현이 실제 BTreeSet 으로 모인다.
#[test]
fn tag_set_collects_mirrored_vec_into_btree_set() {
    let out = tagSet(TagSetInput {
        ids: vec![3, 1, 2, 2],
    })
    .unwrap();
    // 실제 타입은 BTreeSet — 중복 제거 + 정렬이 와이어로 관측된다.
    assert_eq!(out.tags, vec!["t1", "t2", "t3"]);
}

/// u64/Option 필드 미러 — usize 가 아닌 와이드 정수 경계.
#[test]
fn wide_agg_option_and_u64_fields() {
    let out = wideAgg(WideAggInput {
        samples: vec![7, 3, 9],
        offset: Some(100),
    })
    .unwrap();
    assert_eq!(out.max, 9);
    assert_eq!(out.adjusted, 103);
}

/// unit 입력 명령 — 파라미터 없는 생성 래퍼.
#[test]
fn device_demo_takes_no_parameter() {
    let out = deviceDemo().unwrap();
    assert_eq!(out.os, std::env::consts::OS);
}

/// 제네릭 JSON 표면 — invokeJson 문자열 경계.
#[test]
fn invoke_json_generic_surface() {
    let out = invokeJson(
        "addNumbers".to_string(),
        r#"{"a": 20, "b": 22}"#.to_string(),
    )
    .unwrap();
    assert!(out.contains("42"), "{out}");
    // 알 수 없는 커맨드 — command.not_found 로 타입 에러 변환.
    let error = invokeJson("nope".to_string(), String::new()).unwrap_err();
    match error {
        RustraCommandFailure::Failure { code, .. } => assert_eq!(code, "command.not_found"),
    }
}

/// getSchema — 라이브 스키마 JSON.
#[test]
fn get_schema_returns_live_schema() {
    let schema = getSchema();
    assert!(schema.contains("addNumbers"), "{schema}");
    // JSON 으로 파싱 가능해야 한다.
    let value: serde_json::Value = serde_json::from_str(&schema).unwrap();
    assert_eq!(value["packageId"], "examples.calculator");
}

/// contractHash — FFI rustra_ffi_contract_hash 와 동일 단일 소스.
#[test]
fn contract_hash_matches_generate_typescript() {
    let generated = rustra_calculator_example::calculator_package()
        .generate_typescript()
        .unwrap();
    assert_eq!(contractHash().unwrap(), generated.contract_hash);
}

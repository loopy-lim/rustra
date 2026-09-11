//! invoke_typed + decode_rkyv_v2_response 통합 테스트.
//!
//! typed invoke 가 invoke_rkyv_v2 의 단일 dispatch 경로를 타는지(같은 와이어,
//! 같은 에러 전파 계약)와 프레임 디코더가 encode_rkyv_v2_error 가 만드는
//! 에러 프레임을 정확히 되읽는지 검증한다. 프레임 포맷 정의는
//! examples/calculator/tests/wire_fixtures.rs 헤더 참고.

use rustra::{Package, RustraError};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

// ── 픽스처 타입/핸들러 ─────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AddInput {
    a: i64,
    b: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AddOutput {
    value: i64,
}

fn add(input: AddInput) -> rustra::Result<AddOutput> {
    Ok(AddOutput {
        value: input.a + input.b,
    })
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct GreetInput {
    name: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct GreetOutput {
    message: String,
}

fn greet(input: GreetInput) -> rustra::Result<GreetOutput> {
    Ok(GreetOutput {
        message: format!("hello {name}", name = input.name),
    })
}

/// 도메인 에러를 반환하는 핸들러 — 에러 전파 계약(code/message 보존) 검증용.
fn divide(input: AddInput) -> rustra::Result<AddOutput> {
    if input.b == 0 {
        return Err(RustraError::custom(
            "math.divide_by_zero",
            "cannot divide by zero",
        ));
    }
    Ok(AddOutput {
        value: input.a / input.b,
    })
}

fn static_pkg() -> Package {
    Package::builder("typed.test")
        .command("add", add)
        .command("greet", greet)
        .command("divide", divide)
        .build()
}

// ── 1. invoke_typed happy path ─────────────────────────────

#[test]
fn invoke_typed_static_round_trip() {
    let pkg = static_pkg();
    let out: AddOutput = pkg
        .invoke_typed("add", &AddInput { a: 40, b: 2 })
        .expect("typed invoke ok");
    assert_eq!(out, AddOutput { value: 42 });

    // String 본문(Tier 2)도 같은 경로로 왕복된다.
    let out: GreetOutput = pkg
        .invoke_typed(
            "greet",
            &GreetInput {
                name: "typed".into(),
            },
        )
        .expect("typed invoke ok");
    assert_eq!(out.message, "hello typed");
}

#[test]
#[cfg(debug_assertions)]
fn invoke_typed_dynamic_registered_round_trip() {
    // register 로 등록한 동적 명령 — mutable 경로(clone-out) 통과.
    let pkg = Package::builder("typed.dyn").build();
    pkg.register("add", add).unwrap();
    let out: AddOutput = pkg
        .invoke_typed("add", &AddInput { a: 5, b: 37 })
        .expect("typed invoke ok");
    assert_eq!(out.value, 42);
}

#[test]
#[cfg(debug_assertions)]
fn invoke_typed_frozen_registry_round_trip() {
    // freeze 후 — frozen snapshot borrow 경로 통과.
    let pkg = Package::builder("typed.frozen").build();
    pkg.register("add", add).unwrap();
    pkg.freeze();
    let out: AddOutput = pkg
        .invoke_typed("add", &AddInput { a: 1, b: 41 })
        .expect("typed invoke ok");
    assert_eq!(out.value, 42);
}

// ── 2. 에러 전파 — 핸들러의 RustraError code/message 보존 ──

#[test]
fn invoke_typed_preserves_handler_error() {
    let pkg = static_pkg();
    let err = pkg
        .invoke_typed::<AddInput, AddOutput>("divide", &AddInput { a: 1, b: 0 })
        .unwrap_err();
    assert_eq!(err.code(), "math.divide_by_zero");
    assert_eq!(err.message(), "cannot divide by zero");
    // 성공 케이스 — 같은 명령이 정상 값도 반환한다(0 division 게이트 확인).
    let out: AddOutput = pkg
        .invoke_typed("divide", &AddInput { a: 9, b: 3 })
        .expect("typed invoke ok");
    assert_eq!(out.value, 3);
}

#[test]
fn invoke_typed_unknown_command_name() {
    let pkg = static_pkg();
    let err = pkg
        .invoke_typed::<AddInput, AddOutput>("nope", &AddInput { a: 1, b: 2 })
        .unwrap_err();
    assert_eq!(err.code(), "command.not_found");
    // invoke_json 과 동일한 제안 메시지(사용 가능 명령 나열)가 유지된다.
    assert!(err.message().contains("command not found: nope"));
    assert!(
        err.message()
            .contains("Available commands: add, divide, greet")
    );
}

// ── 3. decode_rkyv_v2_response — 실제 dispatch 와이어와 정합 ──

#[test]
fn decode_rkyv_v2_response_matches_real_dispatch_wire() {
    let pkg = static_pkg();
    // builder 선언이 부여한 실제 command_id 를 live_schema 로 조회한다.
    let id = pkg.live_schema()["commands"]
        .as_array()
        .unwrap()
        .iter()
        .find(|command| command["name"] == "add")
        .expect("add in live schema")["commandId"]
        .as_u64()
        .unwrap() as u16;
    let mut req = id.to_le_bytes().to_vec();
    req.extend_from_slice(&postcard::to_allocvec(&AddInput { a: 40, b: 2 }).unwrap());
    let frame = pkg.invoke_rkyv_v2(&req).expect("dispatch ok");
    assert_eq!(frame[0], 1, "성공 프레임 ok 플래그");

    let body = rustra::decode_rkyv_v2_response(&frame).expect("success frame decodes");
    // 본문 슬라이스가 @8 offset 부터 시작함을 고정(7B reserved 존중).
    assert_eq!(body.len(), frame.len() - 8);
    let out: AddOutput = postcard::from_bytes(body).expect("postcard decode");
    assert_eq!(out.value, 42);
}

// ── 4. decode_rkyv_v2_response — 에러 프레임(encode 와 교차 검증) ──

#[test]
fn decode_rkyv_v2_response_error_frame_from_encoder() {
    let error = RustraError::custom("math.divide_by_zero", "cannot divide by zero");
    let frame = rustra::encode_rkyv_v2_error(&error);

    // 고정 시그니처 디코더 — 동적 코드는 RustraError.code(&'static str) 에 못 들어가므로
    // internal 에 code: message 텍스트로 통합해 전달한다(문서화된 한계).
    let err = rustra::decode_rkyv_v2_response(&frame).unwrap_err();
    assert_eq!(err.code(), "internal");
    assert_eq!(err.message(), "math.divide_by_zero: cannot divide by zero");

    // 구조화 변형 — (code, message) 가 정확히 보존된다.
    let (code, message) = rustra::decode_rkyv_v2_error_parts(&frame).expect("parts decode");
    assert_eq!(code, "math.divide_by_zero");
    assert_eq!(message, "cannot divide by zero");
}

#[test]
fn decode_rkyv_v2_error_parts_rejects_success_frame() {
    // add 의 실제 성공 프레임과 동일한 최소 프레임: ok=1 + 본문 1바이트.
    let frame = [1u8, 0, 0, 0, 0, 0, 0, 0, 84];
    let err = rustra::decode_rkyv_v2_error_parts(&frame).unwrap_err();
    assert_eq!(err.code(), "command.invalid_args");
    assert!(err.message().contains("not an error frame"));
    // 고정 시그니처 디코더는 같은 프레임을 본문 슬라이스로 반환한다.
    assert_eq!(rustra::decode_rkyv_v2_response(&frame).unwrap(), &[84]);
}

// ── 5. decode_rkyv_v2_response — malformed 프레임 거절 ─────

#[test]
fn decode_rkyv_v2_response_rejects_malformed_frames() {
    // 8바이트 미만 — 헤더 불충분.
    let short_frames: [&[u8]; 3] = [&[], &[1u8], &[0u8; 7]];
    for short in short_frames {
        let err = rustra::decode_rkyv_v2_response(short).unwrap_err();
        assert_eq!(err.code(), "command.invalid_args");
        assert_eq!(err.message(), "rkyv v2: response frame too short");
    }
    // ok 바이트가 {0,1} 밖.
    let frame = [2u8, 0, 0, 0, 0, 0, 0, 0];
    let err = rustra::decode_rkyv_v2_response(&frame).unwrap_err();
    assert_eq!(err.code(), "command.invalid_args");
    assert_eq!(err.message(), "rkyv v2: unknown ok byte 2");
    // ok=0 인데 err_len(u16 @8) 자리가 비어 있음.
    let frame = [0u8, 0, 0, 0, 0, 0, 0, 0, 5];
    let err = rustra::decode_rkyv_v2_response(&frame).unwrap_err();
    assert_eq!(err.code(), "command.invalid_args");
    assert_eq!(err.message(), "rkyv v2: error frame too short for err_len");
    // err_len 이 프레임 끝을 넘는다.
    let frame = [0u8, 0, 0, 0, 0, 0, 0, 0, 100, 0];
    let err = rustra::decode_rkyv_v2_response(&frame).unwrap_err();
    assert_eq!(err.code(), "command.invalid_args");
    assert_eq!(err.message(), "rkyv v2: error frame body truncated");
    // err_len 은 유효하지만 본문이 postcard {code, message} 가 아님(빈 본문).
    let frame = [0u8, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    let err = rustra::decode_rkyv_v2_response(&frame).unwrap_err();
    assert_eq!(err.code(), "command.invalid_args");
    assert!(
        err.message()
            .starts_with("rkyv v2: error frame body decode failed")
    );
}

#[test]
fn decode_rkyv_v2_response_parts_malformed_matches_fixed_signature() {
    // 구조화 변형도 동일한 검증 게이트를 통과한다(빈 프레임).
    let err = rustra::decode_rkyv_v2_error_parts(&[]).unwrap_err();
    assert_eq!(err.code(), "command.invalid_args");
    assert_eq!(err.message(), "rkyv v2: response frame too short");
}

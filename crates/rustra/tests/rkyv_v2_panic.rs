//! `Package::invoke_rkyv_v2` 의 핸들러 패닉 전파 검증 — 패닉은 `Err(RustraError)`
//! 로 정규화되어야 하고 절대 unwinding 을 호출자에게 새어나가지 않는다
//! (FFI 진입점 — `rustra_calculator_invoke_rkyv_v2` 등 extern "C" — 에서
//! abort 로 이어지기 때문). JSON/postcard FFI 의 `ffi::with_panic_guard` 와
//! 동일한 계약을 rkyv V2 바이너리 경로에도 적용하는지 확인한다.

use rustra::prelude::*;

#[path = "../benches/common.rs"]
mod common;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct BoomInput {
    n: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct BoomOutput {
    value: i64,
}

/// 디코드는 성공하고 핸들러 본문에서 패닉하는 명령 — postcard fast-path(tier 1)
/// 까지 도달해야 패닉 경로가 실제로 실행된다.
#[command]
fn boom(input: BoomInput) -> Result<BoomOutput> {
    let _ = input;
    panic!("intentional");
}

#[test]
fn handler_panic_is_contained_as_internal_error() {
    let pkg = rustra::build!("test.panic", boom).done();
    // 등록순 첫 명령이지만 하드코딩 회피 — live_schema 에서 cmd_id 조회.
    let id = common::command_id_of(&pkg, "boom");
    // 요청 프레임: [cmd_id u16 LE][postcard(BoomInput{n:1})] — typed fast-path 가
    // 디코드에 성공해 핸들러까지 가야 한다 (디코드 실패는 invalid_args 로,
    // 패닉 경로를 건드리지 않는다).
    let req = common::postcard_request(id, &BoomInput { n: 1 });
    let result =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| pkg.invoke_rkyv_v2(&req)));
    match result {
        Ok(Err(e)) => assert!(
            e.to_string().starts_with("internal"),
            "panic must be normalized to an internal error frame, got: {e}"
        ),
        Ok(Ok(_)) => panic!("panicking handler must not succeed"),
        Err(_) => panic!("panic escaped invoke_rkyv_v2 — would abort at extern C"),
    }
}

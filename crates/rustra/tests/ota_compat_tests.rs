//! 트랙 2 — OTA 하위 호환: 구 command_id alias 수용.

use rustra::Package;

#[path = "../benches/common.rs"]
mod common;

#[test]
fn legacy_command_id_still_dispatches_after_schema_growth() {
    // v1 스키마: add 가 command_id=1 이었다. v2 에서 새 명령이 앞에 삽입돼
    // add=2 가 되었지만, alias 로 구 id 1 도 수용한다.
    let pkg = Package::builder("ota.test")
        .command("ping", |_input: common::GreetInput| {
            Ok(common::GreetOutput {
                message: "pong".into(),
            })
        })
        .alias_command_id("add", 1) // 구 클라이언트 호환
        .command("add", common::add)
        .build();

    // 구 클라이언트가 보낸 페이로드: cmd_id=1 + postcard AddInput{a:2,b:3}
    let mut legacy_payload = vec![1, 0]; // u16 LE cmd_id=1
    legacy_payload
        .extend_from_slice(&postcard::to_allocvec(&common::AddInput { a: 2, b: 3 }).unwrap());

    let resp = pkg
        .invoke_rkyv_v2(&legacy_payload)
        .expect("legacy id must dispatch");
    // Tier1 응답: ok=1 @0, pad 7B, value @8
    assert_eq!(resp[0], 1);
    let value = postcard::from_bytes::<common::AddOutput>(&resp[8..]).unwrap();
    assert_eq!(value.value, 5);
}

#[test]
fn current_command_id_still_works_alongside_alias() {
    let pkg = Package::builder("ota.test2")
        .alias_command_id("add", 1)
        .command("add", common::add)
        .build();
    // 새 클라이언트는 add=1 (첫 명령) 로 호출 — 실제 id 와 alias 가 같은 값이면
    // 문제없이 동작해야 한다.
    let mut payload = vec![1, 0];
    payload.extend_from_slice(&postcard::to_allocvec(&common::AddInput { a: 10, b: 20 }).unwrap());
    let resp = pkg.invoke_rkyv_v2(&payload).unwrap();
    assert_eq!(resp[0], 1);
    let value = postcard::from_bytes::<common::AddOutput>(&resp[8..]).unwrap();
    assert_eq!(value.value, 30);
}

#[test]
fn alias_for_unknown_command_fails_loudly_at_build() {
    let result = std::panic::catch_unwind(|| {
        Package::builder("ota.bad")
            .alias_command_id("nonexistent", 7)
            .build()
    });
    assert!(
        result.is_err(),
        "alias to unknown command must fail at build()"
    );
}

#[test]
fn alias_conflicting_with_real_command_id_fails_loudly_at_declaration() {
    let result = std::panic::catch_unwind(|| {
        Package::builder("ota.conflict")
            .command("add", common::add)
            .command("ping", |_i: common::GreetInput| {
                Ok(common::GreetOutput {
                    message: String::new(),
                })
            })
            // add 는 id 1, ping 은 id 2 — ping 에 id 1 을 alias 하면 충돌.
            // 대상이 이미 등록된 상태라 선언 시점 검증에서 즉시 패닉한다.
            .alias_command_id("ping", 1)
            .build()
    });
    assert!(
        result.is_err(),
        "alias colliding with a real command_id must fail at declaration"
    );
}

/// 회귀 (리뷰 지적): 축소 스키마에서 displacement 의 fresh id 가 이미 병합된
/// alias id 를 덮어쓰는 순서 결함. 구 스키마가 더 컸다면(명령 제거) alias id 가
/// 현재 next_command_id 보다 커질 수 있다 — fresh id 할당을 alias 병합 **이후**에
/// next_command_id 기준으로 하면 병합된 alias 항목을 조용히 덮어쓴다.
/// 구 클라이언트가 `oldone` 을 호출했는데 `run` 이 실행되는 silent
/// misrouting 이므로, fresh id 는 절대 어떤 alias id 에도 겹치면 안 된다.
#[test]
fn displaced_command_never_lands_on_a_merged_alias_id() {
    let pkg = Package::builder("ota.shrink")
        .alias_command_id("oldone", 4) // 구 id 4 — 병합 시작 시점엔 미점유
        .alias_command_id("oldtwo", 1) // 구 id 1 — 현재 "run" 이 점유
        .command("run", common::add) // 실제 id 1 → displacement 대상
        .command("oldone", common::echo) // 실제 id 2
        .command("oldtwo", common::greet) // 실제 id 3; next_command_id=4
        .build();

    // 구 id → alias 목적지가 그대로 살아 있어야 한다.
    assert_eq!(pkg.resolve_command_id(4).as_deref(), Some("oldone"));
    assert_eq!(pkg.resolve_command_id(1).as_deref(), Some("oldtwo"));

    // 밀려난 "run" 은 fresh id 로 도달 가능해야 한다 — alias id 4 가 아니다.
    let run_id = common::command_id_of(&pkg, "run");
    assert_ne!(run_id, 4, "displaced fresh id must not land on alias id 4");
    let mut payload = run_id.to_le_bytes().to_vec();
    payload.extend_from_slice(&postcard::to_allocvec(&common::AddInput { a: 1, b: 2 }).unwrap());
    let resp = pkg.invoke_rkyv_v2(&payload).unwrap();
    assert_eq!(resp[0], 1);
    assert_eq!(
        postcard::from_bytes::<common::AddOutput>(&resp[8..])
            .unwrap()
            .value,
        3
    );

    // wire 디스패치: 구 id 4 로 호출하면 oldone(echo) 이 실행되어야 한다.
    let mut legacy = 4u16.to_le_bytes().to_vec();
    legacy.extend_from_slice(&postcard::to_allocvec(&common::EchoInput { v: 42 }).unwrap());
    let resp = pkg.invoke_rkyv_v2(&legacy).unwrap();
    assert_eq!(resp[0], 1);
    assert_eq!(
        postcard::from_bytes::<common::EchoOutput>(&resp[8..])
            .unwrap()
            .v,
        42
    );
}

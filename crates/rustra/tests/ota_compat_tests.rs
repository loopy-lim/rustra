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
fn alias_conflicting_with_real_command_id_fails_loudly_at_build() {
    let result = std::panic::catch_unwind(|| {
        Package::builder("ota.conflict")
            .command("add", common::add)
            .command("ping", |_i: common::GreetInput| {
                Ok(common::GreetOutput {
                    message: String::new(),
                })
            })
            // add 는 id 1, ping 은 id 2 — ping 에 id 1 을 alias 하면 충돌.
            .alias_command_id("ping", 1)
            .build()
    });
    assert!(
        result.is_err(),
        "alias colliding with a real command_id must fail at build()"
    );
}

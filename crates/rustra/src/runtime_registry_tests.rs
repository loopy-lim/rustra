use super::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct TestIn {
    _v: i64,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct TestOut {
    v: i64,
}

// NOTE: 이 handler들은 #[command] 없이 일반 fn. `register(name, handler)` 는
// 이름 추론이 필요 없으므로 매크로 없이도 등록 가능하다. (매크로는 크레이트 내부
// 인라인 테스트에선 rustra::__private 경로가 해석되지 않아 사용할 수 없다.)
fn c1(_: TestIn) -> Result<TestOut> {
    Ok(TestOut { v: 1 })
}
fn c2(_: TestIn) -> Result<TestOut> {
    Ok(TestOut { v: 2 })
}
fn c3(_: TestIn) -> Result<TestOut> {
    Ok(TestOut { v: 3 })
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct EchoIn {
    v: i64,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct EchoOut {
    v: i64,
}
fn echo(input: EchoIn) -> Result<EchoOut> {
    Ok(EchoOut { v: input.v })
}

fn empty_pkg() -> Package {
    Package::builder("test.wb").build()
}

fn id_of(pkg: &Package, name: &str) -> u16 {
    pkg.state
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .commands
        .get(name)
        .unwrap()
        .command_id
}

#[test]
#[cfg(debug_assertions)]
fn debug_build_is_mutable_by_default() {
    let pkg = empty_pkg();
    assert!(!pkg.is_frozen(), "debug build should be mutable by default");
    pkg.freeze();
    assert!(pkg.is_frozen());
}

// ── 레지스트리 RwLock 포이즈닝 관용 ───────────────────────
// 레지스트리 writer 가 임계구역 안에서 패닉하면 RwLock 이 포이즈닝된다.
// 포이즈닝은 "락을 잡은 채 패닉이 일어났다" 신호일 뿐 — BTreeMap 자체는
// 구조적으로 유효하다(중간 상태 corruption 없음). .unwrap() 이면 이후
// 모든 invoke 가 패닉하는데, FFI 진입점(extern "C") 경계에서는 프로세스
// abort 다. 관용 처리로 과거 패닉 이후에도 앱이 invoke 가능해야 한다.

#[test]
#[cfg(debug_assertions)]
fn poisoned_registry_lock_still_serves_invokes() {
    let pkg = empty_pkg();
    pkg.register("c1", c1).unwrap();
    // 의도적 포이즈닝 — write guard 를 잡은 채 패닉
    let _ = std::panic::catch_unwind(|| {
        let _guard = pkg.state.write().unwrap();
        panic!("intentional poison");
    });
    // 관용 처리 후: invoke/조회가 패닉하지 않고 정상 동작한다
    let out: TestOut = pkg.invoke("c1", TestIn { _v: 0 }).unwrap();
    assert_eq!(out.v, 1);
    let id = id_of(&pkg, "c1");
    assert_eq!(pkg.resolve_command_id(id).as_deref(), Some("c1"));
    assert!(pkg.live_schema()["commands"].as_array().is_some());
}

/// release 빌드 동등 검증 — `build()` 산출 패키지는 동결 상태지만 포이즈닝
/// 관용 자체는 동작해야 한다. 등록은 불가(동결)하므로 빌더로 명령을 넣은
/// 뒤(build 시점엔 미동결) 포이즈닝 후 invoke 가능성만 확인한다.
/// (인라인 테스트에선 build! 매크로를 못 쓴다 — 위 NOTE 참조.)
#[test]
#[cfg(not(debug_assertions))]
fn poisoned_registry_lock_still_serves_invokes_release() {
    let pkg = Package::builder("test.poison.release")
        .command("c1", c1)
        .build();
    let _ = std::panic::catch_unwind(|| {
        let _guard = pkg.state.write().unwrap();
        panic!("intentional poison");
    });
    let out: TestOut = pkg.invoke("c1", TestIn { _v: 0 }).unwrap();
    assert_eq!(out.v, 1);
}

#[test]
#[cfg(not(debug_assertions))]
fn release_build_is_frozen_by_default() {
    let pkg = empty_pkg();
    assert!(pkg.is_frozen(), "release build should be frozen by default");
}

#[test]
#[cfg(debug_assertions)]
fn register_assigns_monotonic_ids() {
    let pkg = empty_pkg();
    pkg.register("c1", c1).unwrap();
    pkg.register("c2", c2).unwrap();
    assert_eq!(id_of(&pkg, "c1"), 1);
    assert_eq!(id_of(&pkg, "c2"), 2);
}

#[test]
#[cfg(debug_assertions)]
fn unregistered_id_is_never_reused() {
    let pkg = empty_pkg();
    pkg.register("c1", c1).unwrap();
    pkg.register("c2", c2).unwrap();
    let id_c2 = id_of(&pkg, "c2");
    pkg.unregister("c2").unwrap();
    pkg.register("c3", c3).unwrap();
    let id_c3 = id_of(&pkg, "c3");
    assert_ne!(id_c2, id_c3, "retired id must not be reused");
    assert_eq!(id_c2, 2);
    assert_eq!(id_c3, 3);
}

#[test]
#[cfg(debug_assertions)]
fn register_replaces_with_stable_id() {
    let pkg = empty_pkg();
    pkg.register("c1", c1).unwrap();
    let id_before = id_of(&pkg, "c1");
    pkg.register("c1", c2).unwrap(); // 같은 이름 → replace, id 유지
    let id_after = id_of(&pkg, "c1");
    assert_eq!(
        id_before, id_after,
        "command_id must stay stable on replace"
    );
    let out: TestOut = pkg.invoke("c1", TestIn { _v: 0 }).unwrap();
    assert_eq!(out.v, 2, "replaced handler should be in effect");
}

#[test]
#[cfg(debug_assertions)]
fn replace_missing_errors_and_unregister_twice_errors() {
    let pkg = empty_pkg();
    let err = pkg.replace("nope", c1).unwrap_err();
    assert_eq!(err.code(), "command.not_found");
    let err = pkg.unregister("nope").unwrap_err();
    assert_eq!(err.code(), "command.not_found");
}

#[test]
#[cfg(debug_assertions)]
fn missing_json_command_lists_available_names_and_suggestion() {
    let pkg = empty_pkg();
    pkg.register("addNumbers", c1).unwrap();
    pkg.register("greet", c2).unwrap();
    let error = pkg
        .invoke_json("addNumber", serde_json::json!({}))
        .unwrap_err();
    assert_eq!(error.code(), "command.not_found");
    assert!(
        error
            .message()
            .contains("Available commands: addNumbers, greet")
    );
    assert!(error.message().contains("Did you mean 'addNumbers'?"));
}

/// release 빌드 동등 검증 — release 는 동결 시작이라 register 대신 빌더로
/// 명령을 넣는다(위 release 동등 검증 관례와 동일). not_found 안내 메시지
/// (사용 가능 목록 + Did you mean 제안) 자체는 빌드 프로필과 무관하다.
#[test]
#[cfg(not(debug_assertions))]
fn missing_json_command_lists_available_names_and_suggestion_release() {
    let pkg = Package::builder("test.missing.release")
        .command("addNumbers", c1)
        .command("greet", c2)
        .build();
    let error = pkg
        .invoke_json("addNumber", serde_json::json!({}))
        .unwrap_err();
    assert_eq!(error.code(), "command.not_found");
    assert!(
        error
            .message()
            .contains("Available commands: addNumbers, greet")
    );
    assert!(error.message().contains("Did you mean 'addNumbers'?"));
}

#[test]
#[cfg(debug_assertions)]
fn register_errors_when_id_space_exhausted() {
    let pkg = empty_pkg();
    {
        let mut st = pkg.state.write().unwrap();
        st.next_command_id = u16::MAX; // exhausted sentinel
    }
    let err = pkg.register("c1", c1).unwrap_err();
    assert_eq!(err.code(), "registry.id_exhausted");
}

#[test]
#[cfg(debug_assertions)]
fn frozen_blocks_all_mutation_but_invoke_works() {
    let pkg = empty_pkg();
    pkg.register("c1", c1).unwrap();
    pkg.freeze();

    assert_eq!(
        pkg.register("c2", c2).unwrap_err().code(),
        "registry.frozen"
    );
    assert_eq!(pkg.unregister("c1").unwrap_err().code(), "registry.frozen");
    assert_eq!(pkg.replace("c1", c2).unwrap_err().code(), "registry.frozen");

    // 동결 상태에서도 invoke/generate 는 정상 동작
    let out: TestOut = pkg.invoke("c1", TestIn { _v: 0 }).unwrap();
    assert_eq!(out.v, 1);
    assert!(pkg.generate_typescript().is_ok());
}

#[test]
#[cfg(debug_assertions)]
fn shared_clone_sees_runtime_mutation() {
    // Package clone 은 동일 레지스트리를 공유한다 (Arc semantics).
    let pkg = empty_pkg();
    let pkg2 = pkg.clone();
    pkg.register("c1", c1).unwrap();
    // 다른 clone 에서도 보여야 한다
    assert_eq!(id_of(&pkg2, "c1"), 1);
    let out: TestOut = pkg2.invoke("c1", TestIn { _v: 0 }).unwrap();
    assert_eq!(out.v, 1);
}

/// 동적(런타임 등록) 명령이 rkyv V2 Tier 3 경로로 호출되는지 검증.
#[test]
#[cfg(debug_assertions)]
fn dynamic_command_invokable_via_rkyv_v2_tier3() {
    let pkg = empty_pkg();
    pkg.register("echo", echo).unwrap();
    // Tier 3 wire: [command_id: u16 LE @0][json @2]
    let json = br#"{"v":7}"#;
    let mut payload = vec![0u8; 2 + json.len()];
    payload[0..2].copy_from_slice(&1u16.to_le_bytes());
    payload[2..].copy_from_slice(json);
    let resp = pkg.invoke_rkyv_v2(&payload).unwrap();
    // success tier3: [ok:1 @0][pad 3B][json_len: u32 LE @4][json @8]
    assert_eq!(resp[0], 1, "ok flag should be 1");
    let len = u32::from_le_bytes(resp[4..8].try_into().unwrap()) as usize;
    let out: serde_json::Value = serde_json::from_slice(&resp[8..8 + len]).unwrap();
    assert_eq!(out["v"], 7);
}

/// schema_generation 이 레지스트리 구조 변경(register/replace/unregister)마다
/// 증가한다 — dev 치환 워크플로우의 재동기화 계약. 계약은 "증가 방향 보존"
/// 만 요구한다(동일 이름 재등록 등 무실질 변경도 증가해도 무해).
#[test]
#[cfg(debug_assertions)]
fn schema_generation_advances_on_register_replace_unregister() {
    let pkg = empty_pkg();
    let g0 = pkg.schema_generation();
    pkg.register("echo", echo).unwrap();
    let g1 = pkg.schema_generation();
    assert!(g1 > g0, "register must advance generation");
    pkg.replace("echo", c1).unwrap();
    let g2 = pkg.schema_generation();
    assert!(g2 > g1, "replace must advance generation");
    pkg.unregister("echo").unwrap();
    assert!(
        pkg.schema_generation() > g2,
        "unregister must advance generation"
    );
}

/// live_schema() 가 동적 명령을 포함하는지 검증.
#[test]
#[cfg(debug_assertions)]
fn live_schema_includes_dynamic_command() {
    let pkg = empty_pkg();
    // 빈 레지스트리 조회로 캐시를 먼저 채운 뒤 등록해도 최신 스키마여야 한다.
    assert!(pkg.live_schema()["commands"].as_array().unwrap().is_empty());
    pkg.register("echo", echo).unwrap();
    let s = pkg.live_schema();
    let cmds = s["commands"].as_array().unwrap();
    let echo_entry = cmds
        .iter()
        .find(|c| c["name"] == "echo")
        .expect("echo should be in live schema");
    assert_eq!(echo_entry["commandId"], 1);
    assert_eq!(
        echo_entry["inputSchema"]["properties"]["v"]["type"],
        "integer"
    );
}

#[test]
#[cfg(debug_assertions)]
fn live_schema_cache_tracks_replace_and_unregister() {
    let pkg = empty_pkg();
    pkg.register("echo", echo).unwrap();
    let before = pkg.live_schema();
    // 동일 상태의 반복 조회는 같은 공개 값을 반환한다.
    assert_eq!(pkg.live_schema(), before);

    pkg.replace("echo", c1).unwrap();
    let replaced = pkg.live_schema();
    assert_ne!(
        replaced["commands"][0]["inputSchema"],
        before["commands"][0]["inputSchema"]
    );
    assert_eq!(replaced["commands"][0]["commandId"], 1);

    pkg.unregister("echo").unwrap();
    assert!(pkg.live_schema()["commands"].as_array().unwrap().is_empty());
}

/// deny-by-default: capability 가 부여되지 않으면 capability.denied 로 거부.
#[test]
#[cfg(debug_assertions)]
fn capability_required_command_denied_without_grant() {
    let pkg = Package::builder("test.wb")
        .command("locked", c1)
        .require_capability("locked", "compute:secure")
        .build();
    // capability 미부여 → 거부. 핸들러(c1) 는 호출되지 않는다.
    let err = pkg
        .invoke::<_, TestOut>("locked", TestIn { _v: 0 })
        .unwrap_err();
    assert_eq!(err.code(), "capability.denied");
    assert!(!pkg.has_capability("compute:secure"));
}

/// grant 후에는 동일 명령이 허용된다.
#[test]
#[cfg(debug_assertions)]
fn capability_grant_allows_command() {
    let pkg = Package::builder("test.wb")
        .command("locked", c1)
        .require_capability("locked", "compute:secure")
        .build();
    pkg.grant_capability("compute:secure").unwrap();
    assert!(pkg.has_capability("compute:secure"));
    let out: TestOut = pkg.invoke("locked", TestIn { _v: 0 }).unwrap();
    assert_eq!(out.v, 1, "granted capability should allow execution");
}

/// capability 가 없는 일반 명령은 grant 여부와 무관하게 항상 허용.
#[test]
#[cfg(debug_assertions)]
fn non_gated_command_always_allowed() {
    let pkg = Package::builder("test.wb").command("open", c1).build();
    let out: TestOut = pkg.invoke("open", TestIn { _v: 0 }).unwrap();
    assert_eq!(out.v, 1);
}

/// rkyv V2 바이너리 경로에서도 deny-by-default 가 동작한다.
#[test]
#[cfg(debug_assertions)]
fn capability_denied_on_rkyv_v2_path() {
    let pkg = Package::builder("test.wb")
        .command("locked", echo) // command_id 1
        .require_capability("locked", "compute:secure")
        .build();
    // locked(EchoIn) 는 Tier 1 (단일 i64) — fast postcard path.
    // capability 게이트가 디코더보다 먼저 평가되므로 cmd_id 만 있어도 된다.
    let mut payload = vec![0u8; 2];
    payload[0..2].copy_from_slice(&1u16.to_le_bytes()); // command_id = 1
    let err = pkg.invoke_rkyv_v2(&payload).unwrap_err();
    assert_eq!(err.code(), "capability.denied");
}

/// 동결 상태에서는 레지스트리 mutation(register)은 거부되지만 grant_capability 는
/// 허용된다 — grant는 구조 변경이 아닌 런타임 권한 부여이며, release 빌드(동결
/// 시작)에서 권한을 부여할 유일한 경로다.
#[test]
#[cfg(debug_assertions)]
fn grant_capability_allowed_when_frozen_but_register_blocked() {
    let pkg = Package::builder("test.wb")
        .command("locked", c1)
        .require_capability("locked", "compute:secure")
        .build();
    pkg.freeze();

    // 구조 mutation은 동결로 차단된다.
    assert_eq!(
        pkg.register("new_cmd", c2).unwrap_err().code(),
        "registry.frozen"
    );

    // grant는 동결과 무관하게 동작한다.
    pkg.grant_capability("compute:secure").unwrap();
    assert!(pkg.has_capability("compute:secure"));

    // 부여된 뒤에는 해당 명령이 실제로 호출된다.
    let out = pkg
        .invoke_json("locked", serde_json::json!({ "_v": 0 }))
        .unwrap();
    assert_eq!(out["v"], 1);
}

/// 코어 FFI rkyv V2 심볼이 등록된 패키지로 동작하는지 검증한다 —
/// 소비자마다 복제하던 패닉 가드+버퍼 프로토콜의 단일 구현.
/// (전역 PACKAGE OnceLock 을 다른 FFI 테스트와 공유하므로, 여기서는
/// 심볼의 정상 경로만 검증한다 — trust_baseline_ffi.rs 가 나머지 계약을
/// 담당한다.)
#[test]
fn core_rkyv_v2_ffi_symbol_dispatches() {
    let pkg = Package::builder("test.wb")
        .command("double", |args: serde_json::Value| {
            Ok::<_, RustraError>(serde_json::json!(args["v"].as_i64().unwrap_or(0) * 2))
        })
        .build();
    pkg.register_ffi();
    // command_id 1 번 프레임: [cmd_id u16][pad 6][postcard payload]
    let mut payload = [0u8; 8];
    payload[0..2].copy_from_slice(&1u16.to_le_bytes());
    let mut out_len = 0usize;
    let ptr = unsafe {
        crate::ffi::rustra_ffi_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len)
    };
    // 전역 패키지가 다른 테스트의 것일 수 있다(OnceLock 선점) — 어느 쪽이든
    // 심볼이 유효한 프레임을 반환하는지만 검증한다(에러 프레임도 ok=0 헤더를
    // 가진다). null/빈 응답이 아니면 심블의 계약은 성립이다.
    assert!(
        out_len >= 10,
        "rkyv V2 frame must have 10-byte header, got {out_len}"
    );
    if !ptr.is_null() {
        let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) };
        assert!(bytes[0] == 0 || bytes[0] == 1, "ok flag must be 0 or 1");
        unsafe { crate::ffi::rustra_ffi_free(ptr, out_len) };
    }
}

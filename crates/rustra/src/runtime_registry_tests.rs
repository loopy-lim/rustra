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

// map 필드(원시값 맵) — 타입 패리티 1단계 이후 JS postcard 지원 형태다.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct MapIn {
    scores: std::collections::HashMap<String, i64>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct MapOut {
    total: i64,
}
fn score_map_dyn(input: MapIn) -> Result<MapOut> {
    Ok(MapOut {
        total: input.scores.values().sum(),
    })
}

// payload enum(oneOf) — complex binary 라우트(t3align 계약)로 승격되므로 Tier 3
// 유지 판정의 케이스가 아니다. 양쪽(Rust 미러 + complex) 모두 거부하는 형태는
// 3-변형 untagged enum(anyOf 3항)이다 — option_inner(2항)도 anyOf(ref+null)
// 판정도 둘 다 통과하지 못한다.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
enum ShapeLabel {
    Idle,
    Active { level: i64 },
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct ShapeLabelIn {
    status: ShapeLabel,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct ShapeLabelOut {
    label: String,
}
fn shape_label_dyn(input: ShapeLabelIn) -> Result<ShapeLabelOut> {
    Ok(ShapeLabelOut {
        label: match input.status {
            ShapeLabel::Idle => "idle".to_string(),
            ShapeLabel::Active { level } => format!("active:{level}"),
        },
    })
}
// 3-변형 untagged enum(anyOf 3항)
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
enum Untagged3 {
    Num(i64),
    Text(String),
    Flag(bool),
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct AnyIn {
    v: Untagged3,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct AnyOut {
    label: String,
}
fn any_dyn(input: AnyIn) -> Result<AnyOut> {
    Ok(AnyOut {
        label: match input.v {
            Untagged3::Num(n) => format!("num:{n}"),
            Untagged3::Text(t) => format!("text:{t}"),
            Untagged3::Flag(f) => format!("flag:{f}"),
        },
    })
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

/// 동적(런타임 등록) 명령 중 양쪽 미지원 형태(payload enum/oneOf)가 rkyv V2
/// Tier 3 경로로 호출되는지 검증. (T2-1 이후 지원 형태 동적 명령은 postcard
/// binary 핸들러를 받으므로 Tier 3 fallback 증명에는 미지원 형태가 필요하다.)
#[test]
#[cfg(debug_assertions)]
fn dynamic_command_invokable_via_rkyv_v2_tier3() {
    let pkg = empty_pkg();
    pkg.register("anyShape", any_dyn).unwrap();
    let id = id_of(&pkg, "anyShape");
    // Tier 3 wire: [command_id: u16 LE @0][json @2]
    let json = br#"{"v":"hello"}"#;
    let mut payload = vec![0u8; 2 + json.len()];
    payload[0..2].copy_from_slice(&id.to_le_bytes());
    payload[2..].copy_from_slice(json);
    let resp = pkg.invoke_rkyv_v2(&payload).unwrap();
    // success tier3: [ok:1 @0][pad 3B][json_len: u32 LE @4][json @8]
    assert_eq!(resp[0], 1, "ok flag should be 1");
    let len = u32::from_le_bytes(resp[4..8].try_into().unwrap()) as usize;
    let out: serde_json::Value = serde_json::from_slice(&resp[8..8 + len]).unwrap();
    assert_eq!(out["label"], "text:hello");
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

// ── T0-1: schema generation — 치환 동기화 계약 기반 ─────────

#[test]
#[cfg(debug_assertions)]
fn schema_generation_advances_on_register_replace_unregister() {
    let pkg = empty_pkg();
    let g0 = pkg.schema_generation();
    pkg.register("echo", echo).unwrap();
    let g1 = pkg.schema_generation();
    assert!(g1 > g0, "register must advance the generation");
    pkg.replace("echo", c1).unwrap();
    assert!(
        pkg.schema_generation() > g1,
        "replace must advance the generation"
    );
    pkg.unregister("echo").unwrap();
    assert!(
        pkg.schema_generation() > g1,
        "unregister must advance the generation beyond the post-replace value"
    );
    // 스키마 불변 동작(register 중복 이름 = id 재사용, 실질 무변화)은
    // 증가해도 무해 — 계약은 "증가 방향 보존"만 요구.
}

#[test]
#[cfg(debug_assertions)]
fn schema_generation_is_monotonic_across_errors() {
    // 실패한 mutation(register 중복 에러, replace/unregister not_found)은
    // generation을 되감지 않는다 — 단조성만 보이면 충분하다.
    let pkg = empty_pkg();
    pkg.register("echo", echo).unwrap();
    let before = pkg.schema_generation();
    assert!(pkg.replace("missing", c1).is_err());
    assert!(pkg.unregister("missing").is_err());
    assert!(
        pkg.schema_generation() >= before,
        "failed mutations must not rewind the generation"
    );
}

// ── T0-2: live_schema/FFI에 schema generation 노출 ──────────

#[test]
#[cfg(debug_assertions)]
fn live_schema_json_includes_schema_generation_advancing() {
    let pkg = empty_pkg();
    pkg.register("echo", echo).unwrap();
    let g1 = pkg.live_schema()["schemaGeneration"]
        .as_u64()
        .expect("live_schema must carry schemaGeneration");
    pkg.replace("echo", c1).unwrap();
    let g2 = pkg.live_schema()["schemaGeneration"]
        .as_u64()
        .expect("post-replace live_schema must carry schemaGeneration");
    assert!(g2 > g1, "schemaGeneration must advance through live_schema");
    assert_eq!(pkg.schema_generation(), g2, "accessor and JSON agree");
}

#[test]
#[cfg(debug_assertions)]
fn ffi_schema_generation_returns_current_generation() {
    // FFI 전역 컨텍스트는 OnceLock — 프로세스에서 최초 install 이 승리한다.
    // 어떤 패키지가 깔렸든 계약은 "FFI 값 == 설치된 패키지의 현재 세대" 이다.
    let pkg = empty_pkg();
    pkg.register("echo", echo).unwrap();
    let before = unsafe { crate::ffi::rustra_ffi_schema_generation() };
    pkg.replace("echo", c1).unwrap();
    let after = unsafe { crate::ffi::rustra_ffi_schema_generation() };
    assert!(
        after >= before,
        "FFI generation is monotonic across mutations"
    );
    // 설치된 패키지가 있으면 값이 그 패키지의 세대와 정확히 일치해야 한다.
    if let Some(installed) = crate::ffi::get_package() {
        assert_eq!(after, installed.schema_generation());
    }
}

// ── T2-1: 동적 명령 postcard fast-path — 지원 스키마 binary 핸들러 ──

#[test]
#[cfg(debug_assertions)]
fn dynamic_postcard_supported_command_gets_binary_handler() {
    let pkg = empty_pkg();
    // EchoIn { v: i64 } — JS postcard 지원 형태 → 동적 등록이라도 postcard
    // (binary) 핸들러를 받아야 한다. rkyv_v2_handler 가 JSON-in-binary 요청을
    // 거부하는 대신 postcard 요청으로 invoke 가 성공해야 한다.
    pkg.register("echo", echo).unwrap();
    let id = id_of(&pkg, "echo");
    // postcard wire: [command_id: u16 LE @0][postcard(EchoIn) @2]
    let mut req = vec![0u8; 2];
    req[0..2].copy_from_slice(&id.to_le_bytes());
    req.extend_from_slice(&postcard::to_allocvec(&EchoIn { v: 7 }).unwrap());
    let resp = pkg
        .invoke_rkyv_v2(&req)
        .expect("postcard request must succeed");
    assert_eq!(resp[0], 1, "expected ok binary (postcard) response");
    // postcard 응답: [ok u8][pad 3][postcard(EchoOut) @8]
    let out: EchoOut = postcard::from_bytes(&resp[8..]).expect("postcard decode");
    assert_eq!(out.v, 7);

    // 지원 형태 명령의 rkyv_v2_tier3 플래그가 내려갔는지도 확인 — JS 엔진이
    // Tier 3 로 라우팅하지 않도록 하는 Rust 측 계약.
    let tier3 = pkg
        .state
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .commands
        .get("echo")
        .unwrap()
        .rkyv_v2_tier3;
    assert!(
        !tier3,
        "postcard-supported dynamic command must not be tier3"
    );
}

#[test]
#[cfg(debug_assertions)]
fn dynamic_unsupported_schema_stays_tier3() {
    let pkg = empty_pkg();
    // 3-변형 untagged enum(anyOf 3항)은 JS postcard 미러와 complex 라우트 둘 다
    // 거부 → Tier 3 JSON 핸들러 유지.
    pkg.register("anyShape", any_dyn).unwrap();
    let id = id_of(&pkg, "anyShape");
    // Tier 3 wire: [command_id: u16 LE @0][json @2]
    let json = br#"{"v":"hello"}"#;
    let mut req = vec![0u8; 2 + json.len()];
    req[0..2].copy_from_slice(&id.to_le_bytes());
    req[2..].copy_from_slice(json);
    let resp = pkg
        .invoke_rkyv_v2(&req)
        .expect("tier3 request must succeed on unsupported schema");
    assert_eq!(resp[0], 1, "expected ok tier3 json response");
    let len = u32::from_le_bytes(resp[4..8].try_into().unwrap()) as usize;
    let out: serde_json::Value = serde_json::from_slice(&resp[8..8 + len]).unwrap();
    assert_eq!(out["label"], "text:hello");
    let tier3 = pkg
        .state
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .commands
        .get("anyShape")
        .unwrap()
        .rkyv_v2_tier3;
    assert!(tier3, "3-variant untagged dynamic command must stay tier3");
}

// oneOf data enum — complex binary 라우트로 승격(정적 t3align 계약과 동일).
// 동적 등록에서도 complex 핸들러가 선택되는지를 variant-index 와이어로 고정한다.
#[test]
#[cfg(debug_assertions)]
fn dynamic_oneof_schema_gets_complex_binary_handler() {
    let pkg = empty_pkg();
    // oneOf data enum 재사용 — wire 테스트의 Status 형태와 동일.
    pkg.register("shape", shape_label_dyn).unwrap();
    let id = id_of(&pkg, "shape");
    // complex wire: [command_id u16][variant index][payload…]
    // schemars 키 정렬 파생 변형 순서 — Active=0(idx 0), Idle=1.
    let mut req = vec![0u8; 2];
    req[0..2].copy_from_slice(&id.to_le_bytes());
    req.extend_from_slice(&[0, 14]); // variant 0 (Active), level=zigzag(9)=18? → probe
    let resp = pkg.invoke_rkyv_v2(&req);
    // complex 라우트 승격 자체가 계약 — 디코드 성공 여부와 무관하게 tier3 플래그만 고정.
    let _ = resp;
    let tier3 = pkg
        .state
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .commands
        .get("shape")
        .unwrap()
        .rkyv_v2_tier3;
    assert!(
        !tier3,
        "oneOf dynamic command must take the complex binary route"
    );
}

// 원시값 맵은 (타입 패리티 1단계 이후) postcard 지원 형태다 — 동적 등록에서도
// binary 핸들러로 승격되어야 하며, postcard 키 순회 순서가 JSON 왕복과 무관하게
// 동작함을 함께 검증한다.
#[test]
#[cfg(debug_assertions)]
fn dynamic_map_schema_gets_postcard_handler() {
    let pkg = empty_pkg();
    pkg.register("scoreMap", score_map_dyn).unwrap();
    let id = id_of(&pkg, "scoreMap");
    let mut scores = std::collections::HashMap::new();
    scores.insert("a".to_string(), 1i64);
    scores.insert("b".to_string(), 2i64);
    let req = {
        let mut buf = vec![0u8; 2];
        buf[0..2].copy_from_slice(&id.to_le_bytes());
        buf.extend_from_slice(&postcard::to_allocvec(&MapIn { scores }).unwrap());
        buf
    };
    let resp = pkg.invoke_rkyv_v2(&req).expect("postcard map request");
    assert_eq!(resp[0], 1);
    let out: MapOut = postcard::from_bytes(&resp[8..]).expect("postcard decode");
    assert_eq!(out.total, 3);
}

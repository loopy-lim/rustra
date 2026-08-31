//! `rustra_ffi_capture_snapshot` (B1 표준 덤프 API) 테스트.
//!
//! 전역 `FFI_CONTEXT` 는 테스트 바이너리 전체가 공유하고 등록은 첫 호출이
//! 이긴다. 따라서 이 파일의 테스트는 두 가지 관례로 실행 순서 독립을 유지한다:
//! 1. 전역 등록 테스트는 ffi_tests.rs 와 동일한 id/명령 구성("test.ffi" +
//!    addNumbers)으로 등록해 선점 순서와 무관하게 관측을 동일하게 만든다.
//! 2. 구성이 다른 패키지를 다뤄야 하는 테스트는 전역을 건드리지 않고
//!    `assemble_snapshot` 을 직접 호출해 결정적으로 검증한다.

use super::*;
use crate::Package;

/// 전역 FFI_CONTEXT + 그 패키지의 레지스트리를 mutate 하는 테스트 간 상호배제 —
/// 등록은 첫 호출이 이기고(FFI_CONTEXT.set), 명령 집합 단언은 공유 패키지에서
/// 이뤄지므로 병렬 실행 시 서로의 스냅샷을 오염시킨다 (ffi_tests.rs 의
/// SINK_TEST_MUTEX 와 같은 패턴).
static SNAPSHOT_TEST_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 스냅샷을 호출하고 JSON 으로 파싱한 뒤 버퍼를 해제한다.
fn capture_json() -> serde_json::Value {
    let mut out_len: usize = 0;
    let ptr = unsafe { rustra_ffi_capture_snapshot(&mut out_len) };
    assert!(!ptr.is_null(), "registered package → non-null snapshot");
    assert!(out_len > 0);
    let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) };
    let v: serde_json::Value = serde_json::from_slice(bytes).expect("snapshot must be valid JSON");
    unsafe { rustra_ffi_free(ptr, out_len) };
    v
}

/// 전역 FFI 패키지 보장 — ffi_tests.rs 의 test_package 와 **동일한 id/명령
/// 구성**("test.ffi" + addNumbers)으로 등록한다. FFI_CONTEXT.set 은 첫 호출이
/// 이기므로, 선점 순서와 무관하게 전역 패키지의 관측 결과(id, 명령 이름 집합)가
/// 동일해야 ffi_tests.rs 의 단언(packageId == "test.ffi")과 충돌하지 않는다 —
/// 이 파일의 모든 전역 등록은 이 관례를 따른다.
fn ensure_global_package() -> Package {
    let pkg = Package::builder("test.ffi")
        .command("addNumbers", |args: serde_json::Value| {
            let a = args["a"].as_i64().unwrap_or(0);
            let b = args["b"].as_i64().unwrap_or(0);
            Ok::<_, crate::RustraError>(serde_json::json!(a + b))
        })
        .build();
    pkg.register_ffi();
    get_package().expect("package must be registered").clone()
}

/// 스냅샷이 계약 필드(contractHash/schemaGeneration/commands/limits/stats)를
/// 노출하고, 각 필드가 기존 FFI 심벌/레지스트리 값과 정합임을 검증한다.
#[test]
fn snapshot_exposes_contract_generation_commands() {
    let _guard = SNAPSHOT_TEST_MUTEX.lock().unwrap();
    // 등록 보장 — 단, 실제 등록 패키지는 선점자일 수 있다(ffi_tests.rs 가 먼저
    // 등록했을 수 있다). 모든 단언은 get_package() 의 반환 기준으로 한다
    // (실행 순서 독립). 반환된 pkg 는 등록 보장 트리거일 뿐이다.
    let _pkg = ensure_global_package();
    let registered = get_package().expect("package must be registered");

    let v = capture_json();

    // contractHash == rustra_ffi_contract_hash 반환값 (generation 미포함 입력).
    let mut hash_len: usize = 0;
    let hash_ptr = unsafe { rustra_ffi_contract_hash(&mut hash_len) };
    let expected_hash =
        unsafe { String::from_utf8(std::slice::from_raw_parts(hash_ptr, hash_len).to_vec()) }
            .expect("hash is UTF-8");
    unsafe { rustra_ffi_free(hash_ptr, hash_len) };
    assert_eq!(v["contractHash"].as_str(), Some(expected_hash.as_str()));

    // schemaGeneration == rustra_ffi_schema_generation.
    let generation = unsafe { rustra_ffi_schema_generation() };
    assert_eq!(
        v["schemaGeneration"].as_u64(),
        Some(generation),
        "snapshot generation must match the dedicated FFI symbol"
    );

    // commands — 등록된 명령(id/name/capability)과 정합. 전역 패키지는
    // 선점 순서와 무관하게 test.ffi + addNumbers 1개(ensure_global_package
    // 관례)이므로 구체적으로 단언할 수 있다.
    let commands = v["commands"].as_array().expect("commands is an array");
    assert_eq!(commands.len(), 1, "test.ffi registers exactly one command");
    let entry = &commands[0];
    assert!(entry["id"].is_u64(), "command id must be numeric");
    assert_eq!(entry["name"].as_str(), Some("addNumbers"));
    assert_eq!(entry["capability"], serde_json::Value::Null);

    // limits — 현재 페이로드 한도와 정합.
    assert_eq!(
        v["limits"]["maxPayloadBytes"].as_u64(),
        Some(unsafe { rustra_ffi_get_max_payload() } as u64),
    );

    // stats — 기존 카운터(등록 명령 수)와 정합.
    assert_eq!(
        v["stats"]["registeredCommands"].as_u64(),
        Some(commands.len() as u64),
    );
    assert!(v["stats"]["grantedCapabilities"].is_array());

    // packageId — 라이브 스키마의 packageId 와 정합.
    assert_eq!(v["packageId"].as_str(), Some(registered.id()));
}

/// capability 가 요구된 명령은 스냅샷에 그 이름이 그대로 노출된다.
#[test]
fn snapshot_exposes_required_capability() {
    // require_capability 는 빌더 전용(레지스트리 동결 후에는 mutation 불가) —
    // 빌더로 요구를 심고, 스냅샷이 capability 이름을 그대로 보여주는지 검증한다.
    // 이 패키지를 전역에 등록해도(idempotent) 이전 등록이 이기면 이 테스트의
    // 명령 집합이 스냅샷에 반영되지 않으므로, 전역 대신 어셈블러를 직접 호출해
    // 이 패키지의 스냅샷을 결정적으로 검증한다.
    let pkg = Package::builder("test.inspector.cap")
        .command("addNumbers", |args: serde_json::Value| {
            let a = args["a"].as_i64().unwrap_or(0);
            let b = args["b"].as_i64().unwrap_or(0);
            Ok::<_, crate::RustraError>(serde_json::json!(a + b))
        })
        .require_capability("addNumbers", "admin")
        .build();

    let v = serde_json::to_value(super::assemble_snapshot(Some(&pkg))).expect("snapshot JSON");

    let commands = v["commands"].as_array().unwrap();
    let add = commands
        .iter()
        .find(|c| c["name"] == "addNumbers")
        .expect("addNumbers present");
    assert_eq!(add["capability"].as_str(), Some("admin"));
    assert!(add["id"].is_u64());
}

/// 동적 register/unregister 이후 스냅샷 세대와 명령 집합이 함께 움직인다.
/// 전역 FFI_CONTEXT 선점 순서에 독립하도록 어셈블러를 이 패키지에 직접
/// 호출해 결정적으로 검증한다.
#[test]
fn snapshot_reflects_runtime_mutation() {
    let pkg = Package::builder("test.inspector.mutation")
        .command("addNumbers", |args: serde_json::Value| {
            let a = args["a"].as_i64().unwrap_or(0);
            let b = args["b"].as_i64().unwrap_or(0);
            Ok::<_, crate::RustraError>(serde_json::json!(a + b))
        })
        .build();
    let snap = |pkg: &Package| serde_json::to_value(super::assemble_snapshot(Some(pkg))).unwrap();

    let before = snap(&pkg);

    pkg.register::<serde_json::Value, serde_json::Value, _>("temporary", |_| {
        Ok(serde_json::json!(null))
    })
    .expect("register");

    let after = snap(&pkg);
    assert!(
        after["schemaGeneration"].as_u64() > before["schemaGeneration"].as_u64(),
        "mutation must advance the generation"
    );
    assert_eq!(
        after["stats"]["registeredCommands"].as_u64(),
        Some(before["stats"]["registeredCommands"].as_u64().unwrap() + 1),
    );
    assert!(
        after["commands"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["name"] == "temporary"),
    );

    pkg.unregister("temporary").expect("unregister");
    let final_snapshot = snap(&pkg);
    assert!(
        !final_snapshot["commands"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["name"] == "temporary"),
    );
}

/// 미등록 상태 — 전역 패키지가 없으면 스냅샷은 null 계약으로 귀환한다
/// (`rustra_ffi_get_schema` 의 `{}` 폴백과 같은 온건한 degenerate 계약).
/// 전역 FFI_CONTEXT 는 테스트 바이너리에서 이미 채워져 있으므로, 내부 어셈블러
/// 함수를 직접 호출해 None 경로를 검증한다.
#[test]
fn snapshot_assembler_none_package_yields_null_contract() {
    let value = super::assemble_snapshot(None);
    assert_eq!(value["contractHash"], serde_json::Value::Null);
    assert_eq!(value["schemaGeneration"], serde_json::Value::Null);
    assert_eq!(value["commands"], serde_json::json!([]));
    assert_eq!(value["packageId"], serde_json::Value::Null);
}

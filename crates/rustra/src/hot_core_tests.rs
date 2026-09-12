use super::*;
use crate::Package;
use std::path::{Path, PathBuf};

// ── prepare_swap_copy: 버전 카피 + 카운터 + 원본 불변 ──────
//
// 파일 시스템 단위 테스트 — dylib 로딩이 없어도 결정적으로 검증한다. macOS
// codesign 경로와 non-macos 무서명 경로는 cfg 로 갈라지며, 양쪽 다 이 테스트를
// 통과해야 한다(Linux CI = 무서명 경로, macOS 로컬/게이트 = 재서명 경로).

#[test]
fn prepare_swap_copy_versions_by_counter_and_keeps_original() {
    let dir = tempfile::tempdir().expect("tempdir");
    let artifact = dir.path().join("libdemo.dylib");
    std::fs::write(&artifact, b"dylib-bytes-v1").expect("artifact write");

    let first = prepare_swap_copy(&artifact, 7).expect("first copy");
    let second = prepare_swap_copy(&artifact, 8).expect("second copy");

    assert_eq!(first.file_name().unwrap(), "libdemo-hot-7.dylib");
    assert_eq!(second.file_name().unwrap(), "libdemo-hot-8.dylib");
    assert_ne!(
        first, second,
        "카운터가 다르면 경로가 다르다 — 동일 경로 재 dlopen 캐시 히트(libloading #59)를 피하는 전제"
    );

    assert_eq!(
        std::fs::read(&first).expect("copy read"),
        b"dylib-bytes-v1",
        "카피는 아티팩트 바이트를 그대로 담는다"
    );
    assert_eq!(
        std::fs::read(&artifact).expect("artifact read"),
        b"dylib-bytes-v1",
        "원본은 스왑 단위가 아니다 — 카피만 교체 대상"
    );
    assert!(first.exists() && second.exists(), "두 카피는 공존한다");
}

#[test]
fn prepare_swap_copy_handles_extension_less_artifacts() {
    let dir = tempfile::tempdir().expect("tempdir");
    let artifact = dir.path().join("demo");
    std::fs::write(&artifact, b"bytes").expect("artifact write");

    let copy = prepare_swap_copy(&artifact, 1).expect("copy");
    assert_eq!(copy.file_name().unwrap(), "demo-hot-1");
}

// ── FailureTracker: 같은 바이트 연속 실패 포이즌 정책 ──────────
//
// 열리지 않는 아티팩트가 폴링 주기(300ms)마다 prepare_swap_copy(macOS codesign
// spawn)와 on_swap(Err)을 무한 반복하는 폭주로 퇴화하지 않게 하는 상한이다.
// 순수 상태 조각이라 스레드 없이 결정적으로 검증한다.

#[test]
fn failure_tracker_poisons_after_cap_and_waits_for_new_bytes() {
    let mut failures = FailureTracker::default();
    let bad = "a".repeat(64);

    // 상한 직전까지는 포이즌되지 않는다 — 반쯤 쓰인 아티팩트의 재시도 창.
    for i in 1..5 {
        assert!(
            !failures.note_failure(&bad),
            "{i}번째 실패에서는 포이즌되지 않는다"
        );
    }
    assert!(!failures.is_poisoned(&bad));

    // 상한 도달 실패 — 이 바이트는 포이즌.
    assert!(
        failures.note_failure(&bad),
        "5번째 연속 실패에서 포이즌된다"
    );
    assert!(failures.is_poisoned(&bad));

    // 포이즌 후 같은 바이트는 재시도 대상에서 제외된다(run_watch_loop 의
    // is_poisoned 조건). 새 바이트는 즉시 재시도 대상이 된다.
    let fresh = "b".repeat(64);
    assert!(!failures.is_poisoned(&fresh));

    // 새 바이트가 성공하면 포이즌이 해제된다 — 다음 불량 아티팩트도
    // 동일하게 상한만큼 재시도 창을 갖는다.
    failures.note_success();
    assert!(!failures.is_poisoned(&bad));
    for _ in 0..4 {
        assert!(!failures.note_failure(&bad));
    }
    assert!(
        !failures.is_poisoned(&bad),
        "성공 후 streak 은 0부터 다시 센다"
    );
}

#[test]
fn failure_tracker_reset_by_interleaved_success() {
    let mut failures = FailureTracker::default();
    let bad = "c".repeat(64);

    for _ in 0..4 {
        assert!(!failures.note_failure(&bad));
    }
    // 같은 바이트라도 중간에 성공이 끼면 streak 이 초기화된다 — 바이트가
    // 살아 다시 죽는 진동 상태는 무한 재시도가 아니다(매번 새 상한 창).
    failures.note_success();
    assert!(!failures.note_failure(&bad));
    assert!(!failures.is_poisoned(&bad));
}

#[test]
fn failure_tracker_streak_is_per_bytes() {
    let mut failures = FailureTracker::default();
    let a = "d".repeat(64);
    let b = "e".repeat(64);

    // A 바이트가 상한 직전까지 실패한 뒤 B 로 바이트가 바뀌면 — streak 은
    // 바이트 단위로만 센다. B 의 첫 실패가 A 의 실패를 이어받아 즉시 포이즌
    // 되는 일이 없어야 한다(새 바이트는 언제나 새 재시도 창).
    for _ in 0..4 {
        assert!(!failures.note_failure(&a));
    }
    assert!(!failures.note_failure(&b));
    assert!(!failures.is_poisoned(&b));

    // B 가 자기 상한만큼 실패하면 그제야 포이즌된다.
    for _ in 0..3 {
        assert!(!failures.note_failure(&b));
    }
    assert!(
        failures.note_failure(&b),
        "B 의 5번째 연속 실패에서 포이즌된다"
    );
    assert!(failures.is_poisoned(&b));
    assert!(!failures.is_poisoned(&a));
}

// ── JsonDispatch for Package — rustra_dispatch 의 에러 매핑 동일성 ──

#[test]
fn json_dispatch_for_package_maps_success_and_error_shapes() {
    let package = Package::builder("test.hot_dispatch")
        .command("addNumbers", |args: serde_json::Value| {
            let a = args["a"].as_i64().unwrap_or(0);
            let b = args["b"].as_i64().unwrap_or(0);
            Ok::<_, crate::RustraError>(serde_json::json!(a + b))
        })
        .build();
    let dispatch: std::sync::Arc<dyn JsonDispatch> = std::sync::Arc::new(package);

    let value = dispatch
        .invoke_json("addNumbers", serde_json::json!({"a": 2, "b": 3}))
        .expect("invoke must succeed");
    assert_eq!(value, serde_json::json!(5));

    // 미지 명령의 실패 값은 rustra_dispatch 가 돌려주는 것과 같은
    // {code, message} 객체다(serde_json::to_value(RustraError)).
    let error = dispatch
        .invoke_json("definitelyNotACommand", serde_json::json!({}))
        .unwrap_err();
    assert_eq!(error["code"], serde_json::json!("command.not_found"));
    assert!(error["message"].is_string());
}

// ── 통합: calculator cdylib open → invoke → 카피 → 스왑 → leak 확인 ──

/// 계산기 cdylib 을 빌드하고 아티팩트 경로를 돌려준다. 빌드 실패는 이 테스트의
/// 전제 붕괴이므로 skip-with-pass 하지 않고 loud fail 한다.
fn build_calculator_cdylib() -> PathBuf {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let workspace_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let status = std::process::Command::new(&cargo)
        .args(["build", "-p", "rustra-calculator-example"])
        .current_dir(&workspace_root)
        .status()
        .expect("failed to spawn cargo build for the calculator cdylib");
    assert!(
        status.success(),
        "calculator cdylib build failed ({cargo:?}) — hot-core integration test requires a buildable artifact"
    );

    let (prefix, extension) = if cfg!(target_os = "macos") {
        ("lib", "dylib")
    } else if cfg!(target_os = "windows") {
        ("", "dll")
    } else {
        ("lib", "so")
    };
    let target_dir = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_root.join("target"));
    let artifact = target_dir
        .join("debug")
        .join(format!("{prefix}rustra_calculator_example.{extension}"));
    assert!(
        artifact.exists(),
        "cdylib not found at {} — build reported success",
        artifact.display()
    );
    artifact
}

#[test]
fn dylib_core_opens_invokes_and_swaps_calculator_cdylib() {
    let artifact = build_calculator_cdylib();
    let before = retained_library_stats();

    // open — Bun 어댑터와 동일 초기화(dlopen → rustra_mobile_init)를 거친다.
    let core = DylibCore::open(&artifact).expect("calculator cdylib must open");
    let out = core
        .invoke_json("addNumbers", serde_json::json!({"a": 2, "b": 3}))
        .expect("invoke must succeed");
    assert_eq!(out["value"], serde_json::json!(5));

    // 미지 명령 — 코어 FFI 에러 문자열이 {code, message} 로 재분할된다.
    let error = core
        .invoke_json("definitelyNotACommand", serde_json::json!({}))
        .unwrap_err();
    assert_eq!(error["code"], serde_json::json!("command.not_found"));

    let hash = core.contract_hash().expect("contract hash");
    assert_eq!(hash.len(), 64, "계약 해시는 SHA-256 hex 다");

    // 버전 카피 → 열기 — macOS 에서는 codesign 재서명 경로를 함께 검증한다.
    let copy = prepare_swap_copy(&artifact, 1).expect("swap copy");
    assert_ne!(copy, artifact);
    let swapped_core = DylibCore::open(&copy).expect("copied cdylib must open");
    let after = retained_library_stats();
    assert!(after.libraries >= before.libraries + 2);
    assert!(
        after.artifact_bytes
            >= before.artifact_bytes
                + std::fs::metadata(&artifact).unwrap().len()
                + std::fs::metadata(&copy).unwrap().len()
    );
    assert_eq!(
        swapped_core.contract_hash().expect("copy contract hash"),
        hash,
        "같은 바이트의 카피이므로 계약 해시가 동일하다"
    );
    let copy_out = swapped_core
        .invoke_json("addNumbers", serde_json::json!({"a": 4, "b": 4}))
        .expect("copy invoke");
    assert_eq!(copy_out["value"], serde_json::json!(8));

    // 핸들 스왑 — write lock 으로 교체 후 새 호출은 새 코어로 향한다.
    let handle = HotCoreHandle::new(core);
    let old_core = handle.swap(swapped_core);
    assert_eq!(
        handle.contract_hash().expect("handle hash after swap"),
        hash
    );
    let via_handle = handle
        .invoke_json("addNumbers", serde_json::json!({"a": 6, "b": 7}))
        .expect("handle invoke after swap");
    assert_eq!(via_handle["value"], serde_json::json!(13));

    // leak 계약 — 밀려난 구 코어는 dlclose 없이 계속 호출 가능하다.
    let legacy = old_core
        .invoke_json("addNumbers", serde_json::json!({"a": 20, "b": 22}))
        .expect("old core stays callable after swap");
    assert_eq!(legacy["value"], serde_json::json!(42));
}

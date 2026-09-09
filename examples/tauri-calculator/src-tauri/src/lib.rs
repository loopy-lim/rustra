// ── Tauri 계산기 예제 — 모바일 공유 엔트리 (lib/bin 분리 레이아웃) ───────────
//
// Tauri 2 모바일(iOS/Android)은 앱을 **라이브러리 타깃**(staticlib/cdylib)으로
// 빌드해 플랫폼 셸(Xcode/Gradle 프로젝트)이 로드한다 — bin 전용 레이아웃이면
// `no library targets found` 로 모바일 빌드 자체가 실패한다. 데스크톱은
// main.rs 가 이 `run()` 을 호출하는 얇은 래퍼가 되고, 모바일은
// `tauri::mobile_entry_point` 가 런타임 부팅 엔트리가 된다.
//
// 핫 모드·프로브·벤치 등록 분기는 main.rs 에서 그대로 이동했다 — 동작은
// 이전과 동일하다(데스크톱 smoke 가 회귀를 지켜준다).

use rustra::hot_core::{self, DylibCore, DylibWatchConfig, HotCoreHandle};
use rustra::tauri_support;
use rustra_calculator_example::calculator_package;
use std::{env, fs, path::PathBuf, sync::Arc};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Ok(path) = env::var("RUSTRA_TAURI_PROBE_FILE") {
        let output = calculator_package()
            .invoke_json("addNumbers", serde_json::json!({"a": 20, "b": 22}))
            .expect("invoke should succeed");
        let value = output
            .get("value")
            .and_then(|v| v.as_i64())
            .expect("result should be a number");
        let _ = fs::write(path, value.to_string());
    }

    // 등록 선택 — 기본은 프로덕션 등록(register_with_events: register + 이벤트
    // 푸시 배선). 벤치 호스트(benchmark.mjs)만 RUSTRA_BENCH=1 로 띄우며, 이때는
    // 측정 전용 rustra_dispatch_profiled 커맨드가 노출되는 register_profiled 로
    // 빌드한다(A07). 프로덕션 앱에는 profiled 커맨드가 도달하지 않는다.
    //
    // 핫 모드 — RUSTRA_HOT_CORE 가 cdylib 아티팩트 경로를 가리키면 그 dylib 을
    // 열어 디스패치하고, 감시 스레드가 아티팩트 재빌드(sha256 변화)를 감시해
    // 무재시작 스왑을 한다. 스왑은 코어 내부 상태(채널·이벤트 싱크)를 버리므로
    // 이벤트 푸시 배선이 없는 register_dispatch 를 쓴다(design: 상태 소실 정책).
    // 모바일(iOS 시뮬레이터)은 SIMCTL_CHILD_ 접두사 환경변수로 이 모드에 진입한다.
    let builder = if let Some(artifact) = env::var_os("RUSTRA_HOT_CORE").map(PathBuf::from) {
        let core = DylibCore::open(&artifact)
            .unwrap_or_else(|e| panic!("RUSTRA_HOT_CORE dylib open failed: {e}"));
        let handle = Arc::new(HotCoreHandle::new(core));
        let mut config = DylibWatchConfig::new(artifact.clone(), handle.clone());
        config.on_swap = Arc::new(|outcome| match outcome {
            Ok((old, new)) => eprintln!("rustra hot-core: swapped {old} -> {new}"),
            Err(error) => eprintln!("rustra hot-core: swap failed: {error}"),
        });
        hot_core::spawn_dylib_watch(config);
        eprintln!(
            "rustra hot-core: watching {} (poll 300ms) — rebuild the artifact to swap; \
             in-core state (channels/events) resets on each swap",
            artifact.display()
        );
        tauri_support::register_dispatch(handle, tauri::Builder::default())
    } else if env::var("RUSTRA_BENCH").as_deref() == Ok("1") {
        tauri_support::register_profiled(calculator_package(), tauri::Builder::default())
    } else {
        tauri_support::register_with_events(calculator_package(), tauri::Builder::default())
    };

    builder
        .run(tauri::generate_context!())
        .expect("failed to run tauri calculator app");
}

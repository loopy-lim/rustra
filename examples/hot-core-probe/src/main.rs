// ── hot-core 검증 프로브 (dylib open/스왑 온디바이스 시험 바이너리) ──────────
//
// 호스트 프로세스 안에서 hot-core 표면 전체를 실제로 밟아보는 단독 실행
// 바이너리다. 시뮬레이터/에뮬레이터에 호스트 앱을 띄우기 어려운 환경에서도
// 같은 검증을 할 수 있게 호스트 앱(tauri-calculator main.rs)의 핫 모드와
// 동일한 시퀀스를 최소 코드로 재현한다:
//
//   open → invoke → 미지 명령 에러 분할 → 계약 해시 → 버전 카피 → 재 open →
//   핸들 스왑 → 구 코어 생존(dlclose 금지 계약)
//
// 감시 스레드 모드(--watch N)는 여기에 sha256 폴링 스왑을 더한다 — 아티팩트
// 바이트가 외부에서 교체되면 감시가 카피→open→swap 하고 on_swap 결과를
// stdout 으로 보고한다. 전달 수단(adb push / simctl 컨테이너 기록)은 프로브
// 바깥의 호스트 영역이다(design: "기기 푸시는 호스트 영역" 경계와 동일).
//
// 사용법:
//   hot-core-probe <cdylib-artifact>            # 동기 검증만 — PROBE PASS 로 끝남
//   hot-core-probe <cdylib-artifact> --watch 8  # + N초 폴링 감시 — PROBE WATCH DONE 으로 끝남
//
// 종료 코드 0 = 전 단계 통과. 어떤 단계든 실패하면 stderr 에 단계명과 함께
// exit 1 — CI/스크립트에서 판정 가능하게 loud fail 이다.

use rustra::hot_core::{self, DylibCore, DylibWatchConfig, HotCoreHandle, JsonDispatch};
use std::{path::PathBuf, process, sync::Arc, time::Duration};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let artifact = args
        .get(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| usage_and_exit("missing <cdylib-artifact> argument"));
    let watch_seconds = match args.get(2).map(String::as_str) {
        None => None,
        Some("--watch") => Some(
            args.get(3)
                .and_then(|raw| raw.parse::<u64>().ok())
                .unwrap_or_else(|| usage_and_exit("--watch needs a seconds number")),
        ),
        Some(other) => usage_and_exit(&format!("unknown argument {other}")),
    };

    // 1. open + invoke — Bun 어댑터/호스트 앱과 동일 초기화(dlopen →
    //    rustra_mobile_init → 디스패치).
    let core = DylibCore::open(&artifact).unwrap_or_else(|e| fail("open", &e.to_string()));
    let out = core
        .invoke_json("addNumbers", serde_json::json!({"a": 2, "b": 3}))
        .unwrap_or_else(|e| fail("invoke addNumbers", &e.to_string()));
    assert_eq!(out["value"], serde_json::json!(5), "addNumbers(2,3) == 5");

    // 2. 미지 명령 — 코어 FFI 에러 문자열이 {code, message} 로 재분할된다.
    let error = core
        .invoke_json("definitelyNotACommand", serde_json::json!({}))
        .unwrap_err();
    assert_eq!(
        error["code"],
        serde_json::json!("command.not_found"),
        "unknown command must map to command.not_found"
    );

    // 3. 계약 해시 — SHA-256 hex 64자.
    let hash = core
        .contract_hash()
        .unwrap_or_else(|e| fail("contract hash", &e.to_string()));
    assert_eq!(hash.len(), 64, "contract hash is sha256 hex");
    println!("PROBE CONTRACT {hash}");

    // --watch 모드에서는 여기서 동기 검증을 멈춘다 — 아래 스왑 카피(4~6)가
    // 감시 스레드의 카피 경로(<stem>-hot-1)와 겹치면 감시의 fs::copy 가
    // **매핑된 실행 파일을 제자리 덮어쓰고**, macOS/iOS 커널은 매핑된 서명
    // 코드의 변조를 SIGKILL 로 응징한다. 실제 호스트 흐름은 이 충돌이 없다 —
    // 앱의 초기 코어는 -hot-live 경로(CLI 가 rename 으로 원자 발행, 기존
    // inode 보존)를 열고 감시 카피는 매 시도 고유 경로로 새로 만들어지기
    // 때문이다. 감시 모드의 초기 코어도 라이브 경로를 그대로 열어 그 계약을
    // 따라간다.
    if let Some(seconds) = watch_seconds {
        run_watch(artifact, seconds);
        return;
    }

    // 4. 버전 카피 → 재 open — macOS 에서는 codesign 재서명 경로를 함께 검증한다.
    let copy = hot_core::prepare_swap_copy(&artifact, 1)
        .unwrap_or_else(|e| fail("prepare_swap_copy", &e.to_string()));
    let swapped = DylibCore::open(&copy).unwrap_or_else(|e| fail("open swap copy", &e.to_string()));
    let copy_out = swapped
        .invoke_json("addNumbers", serde_json::json!({"a": 4, "b": 4}))
        .unwrap_or_else(|e| fail("invoke via swap copy", &e.to_string()));
    assert_eq!(copy_out["value"], serde_json::json!(8));
    assert_eq!(
        swapped
            .contract_hash()
            .unwrap_or_else(|e| fail("copy contract hash", &e.to_string())),
        hash,
        "같은 바이트의 카피이므로 계약 해시가 동일하다"
    );

    // 5. 핸들 스왑 — write lock 교체 뒤 새 호출은 새 코어로 향한다.
    let handle = Arc::new(HotCoreHandle::new(core));
    let old_core = handle.swap(swapped);
    let via_handle = handle
        .invoke_json("addNumbers", serde_json::json!({"a": 6, "b": 7}))
        .unwrap_or_else(|e| fail("invoke via handle after swap", &e.to_string()));
    assert_eq!(via_handle["value"], serde_json::json!(13));

    // 6. leak 계약 — 밀려난 구 코어는 dlclose 없이 계속 호출 가능하다.
    let legacy = old_core
        .invoke_json("addNumbers", serde_json::json!({"a": 20, "b": 22}))
        .unwrap_or_else(|e| fail("old core after swap", &e.to_string()));
    assert_eq!(legacy["value"], serde_json::json!(42));
    println!("PROBE PASS");
}

/// 감시 모드 — 외부 바이트 교체 → sha256 폴링 → 스왑 보고. 감시 결과는
/// stdout 의 PROBE SWAP 라인이 증거고, 감시 종료 뒤 최종 invoke 로 스왑 뒤
/// 코어가 계속 서비스하는지 확인한다.
fn run_watch(artifact: PathBuf, seconds: u64) {
    // 초기 코어는 라이브 경로를 그대로 연다 — 실제 호스트 앱과 동일.
    let core = DylibCore::open(&artifact).unwrap_or_else(|e| fail("watch open", &e.to_string()));
    let handle = Arc::new(HotCoreHandle::new(core));
    let mut config = DylibWatchConfig::new(artifact, handle.clone());
    config.on_swap = Arc::new(|outcome| match outcome {
        Ok((old, new)) => println!("PROBE SWAP {old} -> {new}"),
        Err(error) => println!("PROBE SWAP FAILED {error}"),
    });
    hot_core::spawn_dylib_watch(config);
    for _ in 0..seconds {
        std::thread::sleep(Duration::from_secs(1));
        let value = handle
            .invoke_json("addNumbers", serde_json::json!({"a": 1, "b": 1}))
            .unwrap_or_else(|e| fail("invoke during watch", &e.to_string()));
        assert_eq!(
            value["value"],
            serde_json::json!(2),
            "watch 중 invoke 는 계속 성공해야 한다"
        );
    }
    let final_hash = handle
        .contract_hash()
        .unwrap_or_else(|e| fail("final contract hash", &e.to_string()));
    println!("PROBE WATCH DONE {final_hash}");
}

fn usage_and_exit(message: &str) -> ! {
    eprintln!("hot-core-probe: {message}");
    eprintln!("usage: hot-core-probe <cdylib-artifact> [--watch <seconds>]");
    process::exit(2);
}

fn fail(step: &str, message: &str) -> ! {
    eprintln!("PROBE FAIL step={step}: {message}");
    process::exit(1);
}

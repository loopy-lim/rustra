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
// 감시가 끝나면 관측 단계가 이어진다 — 고정 커맨드 목록을 스왑 뒤 코어에
// invoke 해 "스왑 후 실제 데이터가 변했는지, 명령 추가/이름 변경/시그니처
// 변화가 코어 레벨에서 어떻게 관측되는지"를 와이어 그대로 보여준다(스왑 유닛은
// examples/hot-core-variant — feature 조합이 시나리오다).
//
// 사용법:
//   hot-core-probe <cdylib-artifact>            # 동기 검증만 — PROBE PASS 로 끝남
//   hot-core-probe <cdylib-artifact> --watch 8  # + N초 폴링 감시+관측 — PROBE OBS 로 끝남
//
// 출력 계약(감시 모드): PROBE CONTRACT <해시> → (스왑마다) PROBE SWAP <old> ->
// <new> → PROBE WATCH DONE <해시> → PROBE OBS <명령> ok <json>|err <코드>…
//
// 종료 코드 0 = 전 단계 통과. 어떤 단계든 실패하면 stderr 에 단계명과 함께
// exit 1 — CI/스크립트에서 판정 가능하게 loud fail 이다.

use rustra::hot_core::{self, DylibCore, DylibWatchConfig, HotCoreHandle, JsonDispatch};
use serde_json::{Value, json};
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

    // --watch 모드에서는 동기 검증(2~6)을 건너뛴다 — 두 가지 계약이다:
    //   (a) 아래 스왑 카피(4~6)가 감시 스레드의 카피 경로(<stem>-hot-1)와
    //       겹치면 감시의 fs::copy 가 **매핑된 실행 파일을 제자리 덮어쓰고**,
    //       macOS/iOS 커널은 매핑된 서명 코드의 변조를 SIGKILL 로 응징한다
    //       (절대 되돌리지 않는다 — 실제 호스트 흐름도 이 충돌이 없다: 앱의
    //       초기 코어는 -hot-live 경로(CLI 가 rename 으로 원자 발행)를 열고
    //       감시 카피는 매 시도 고유 경로로 새로 만들어진다).
    //   (b) 스왑 시나리오의 시작 아티팩트는 variant feature 조합에 따라
    //       addNumbers 의 의미가 다르다(behavior: +100, sig-change: 인자 3개).
    //       addNumbers(2,3)==5 단정은 고정 계약 아티팩트(calculator 등)를
    //       열는 동기 모드에서만 성립한다.
    if let Some(seconds) = watch_seconds {
        run_watch(core, artifact, seconds);
        return;
    }

    // 2. invoke — 기본 산술 왕복.
    let out = core
        .invoke_json("addNumbers", json!({"a": 2, "b": 3}))
        .unwrap_or_else(|e| fail("invoke addNumbers", &e.to_string()));
    assert_eq!(out["value"], json!(5), "addNumbers(2,3) == 5");

    // 3. 미지 명령 — 코어 FFI 에러 문자열이 {code, message} 로 재분할된다.
    let error = core
        .invoke_json("definitelyNotACommand", json!({}))
        .unwrap_err();
    assert_eq!(
        error["code"],
        json!("command.not_found"),
        "unknown command must map to command.not_found"
    );

    // 4. 계약 해시 — SHA-256 hex 64자.
    let hash = core
        .contract_hash()
        .unwrap_or_else(|e| fail("contract hash", &e.to_string()));
    assert_eq!(hash.len(), 64, "contract hash is sha256 hex");
    println!("PROBE CONTRACT {hash}");

    // 5. 버전 카피 → 재 open — macOS 에서는 codesign 재서명 경로를 함께 검증한다.
    let copy = hot_core::prepare_swap_copy(&artifact, 1)
        .unwrap_or_else(|e| fail("prepare_swap_copy", &e.to_string()));
    let swapped = DylibCore::open(&copy).unwrap_or_else(|e| fail("open swap copy", &e.to_string()));
    let copy_out = swapped
        .invoke_json("addNumbers", json!({"a": 4, "b": 4}))
        .unwrap_or_else(|e| fail("invoke via swap copy", &e.to_string()));
    assert_eq!(copy_out["value"], json!(8));
    assert_eq!(
        swapped
            .contract_hash()
            .unwrap_or_else(|e| fail("copy contract hash", &e.to_string())),
        hash,
        "같은 바이트의 카피이므로 계약 해시가 동일하다"
    );

    // 6. 핸들 스왑 — write lock 교체 뒤 새 호출은 새 코어로 향한다.
    let handle = Arc::new(HotCoreHandle::new(core));
    let old_core = handle.swap(swapped);
    let via_handle = handle
        .invoke_json("addNumbers", json!({"a": 6, "b": 7}))
        .unwrap_or_else(|e| fail("invoke via handle after swap", &e.to_string()));
    assert_eq!(via_handle["value"], json!(13));

    // 7. leak 계약 — 밀려난 구 코어는 dlclose 없이 계속 호출 가능하다.
    let legacy = old_core
        .invoke_json("addNumbers", json!({"a": 20, "b": 22}))
        .unwrap_or_else(|e| fail("old core after swap", &e.to_string()));
    assert_eq!(legacy["value"], json!(42));
    println!("PROBE PASS");
}

/// 감시 모드 — 외부 바이트 교체 → sha256 폴링 → 스왑 보고 → 관측. 스왑의
/// 증거는 stdout 의 `PROBE SWAP <old> -> <new>` 라인이고, 감시 종료 뒤 관측
/// 단계(`observe`)가 스왑 뒤 코어의 실제 와이어를 그대로 보여준다.
fn run_watch(core: DylibCore, artifact: PathBuf, seconds: u64) {
    // 초기 코어의 계약 해시 — 스왑 보고의 old 해시와 대조할 기준선 출력.
    let initial_hash = core
        .contract_hash()
        .unwrap_or_else(|e| fail("watch contract hash", &e.to_string()));
    assert_eq!(initial_hash.len(), 64, "contract hash is sha256 hex");
    println!("PROBE CONTRACT {initial_hash}");

    // 초기 코어는 라이브 경로를 그대로 연다 — 실제 호스트 앱과 동일.
    let handle = Arc::new(HotCoreHandle::new(core));
    let mut config = DylibWatchConfig::new(artifact, handle.clone());
    config.on_swap = Arc::new(|outcome| match outcome {
        Ok((old, new)) => println!("PROBE SWAP {old} -> {new}"),
        Err(error) => println!("PROBE SWAP FAILED {error}"),
    });
    hot_core::spawn_dylib_watch(config);
    for _ in 0..seconds {
        std::thread::sleep(Duration::from_secs(1));
        // 감시 중 liveness — 디스패치 경로를 계속 밟되 결과는 단정하지 않는다.
        // 시나리오에 따라 같은 커맨드가 ok(behavior +100)도 err(rename 으로
        // 소멸, sig-change 로 인자 거부)도 정답이기 때문이다. 스왑 뒤 실측은
        // 아래 관측 단계가 담당한다.
        let _ = handle.invoke_json("addNumbers", json!({"a": 1, "b": 1}));
    }
    let final_hash = handle
        .contract_hash()
        .unwrap_or_else(|e| fail("final contract hash", &e.to_string()));
    println!("PROBE WATCH DONE {final_hash}");
    observe(&handle);
}

/// 관측 단계 — 고정 커맨드 목록을 스왑 뒤 코어에 invoke 하고 결과를 stdout 으로
/// 보고한다. hard assert 는 없다: 시나리오에 따라 ok/err 모두 정답이 될 수
/// 있고(rename-cmd 스왑 뒤 addNumbers 의 command.not_found 가 정답인 식), 이
/// 단계의 계약은 "관측된 와이어를 그대로 보여준다"뿐이다. 목록에는 이름 변경
/// 시나리오의 신구 이름을 함께 관측할 수 있게 addNumbersV2 도 포함한다. 인자는
/// 세 커맨드가 모두 받는 {a,b} 스칼라 쌍 — sig-change 코어는 c 가 없는 이
/// 요청을 어떻게 거부하는지가 관측 대상이다(시나리오 4).
fn observe(handle: &HotCoreHandle) {
    for (command, args) in [
        ("addNumbers", json!({"a": 2, "b": 3})),
        ("multiplyNumbers", json!({"a": 2, "b": 3})),
        ("addNumbersV2", json!({"a": 2, "b": 3})),
    ] {
        match handle.invoke_json(command, args) {
            Ok(value) => println!("PROBE OBS {command} ok {value}"),
            Err(error) => {
                let code = error
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                println!("PROBE OBS {command} err {code}");
            }
        }
    }
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

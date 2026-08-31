//! B1 인스펙터 스냅샷의 **정준 골든 바이트** (Rust↔TS 단일 아티팩트).
//!
//! 실제 `rustra_ffi_capture_snapshot` 캡처를
//! `crates/rustra/tests/fixtures/inspector-golden.hex.txt` (committed) 와
//! 대조한다. 같은 파일을 `packages/types/src/inspector.test.ts` 가 읽어
//! TS `parseSnapshot` 이 디코딩하므로, 한쪽 blob 필드가 드리프트하면
//! **양쪽 언어에서 동시에** 실패한다 — 손으로 만든 hex 양쪽 복제의 갈라짐을
//! 구조적으로 막는다.
//!
//! # 갱신 절차 (fixture regeneration)
//!
//! ```text
//! RUSTRA_UPDATE_GOLDEN=1 cargo test -p rustra --test inspector_golden
//! ```
//!
//! 환경변수를 주면 테스트가 캡처 결과를 fixture 에 다시 쓴다(api-surface 의
//! `--update` 와 같은 "의도적 갱신" 관례). 갱신 후 TS 쪽 테스트도 함께
//! 돌려 두 언어가 같은 아티팩트를 보는지 확인한다:
//!
//! ```text
//! bun run --cwd packages/types test
//! ```
//!
//! 결정론성: 패키지 구성(id "inspector.golden", 명령 "sum" 1개)과 페이로드
//! 한도(명시적으로 1 MiB 로 고정)가 고정되고, 레지스트리는 BTreeMap 이라
//! 명령 순서가 바이트로 안정이다. 테스트는 자기 프로세스의 전역 FFI 컨텍스트를
//! 선점한다(각 `--test` 바이너리는 독립 프로세스).

use rustra::Package;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

const FIXTURE_PATH: &str = "tests/fixtures/inspector-golden.hex.txt";

static PAYLOAD_GUARD: AtomicUsize = AtomicUsize::new(0);

fn golden_package() -> Package {
    // 페이로드 한도는 프로세스 전역 상태 — fixture 바이트 결정론을 위해
    // 명시적으로 기본값(1 MiB)으로 고정한다. PAYLOAD_GUARD 는 임계구역
    // 표시용이 아니라 "이 테스트가 전역 한도를 만졌다"는 문서화다(같은
    // 바이너리 안 다른 테스트가 없음을 파일 구조로 보장).
    unsafe { rustra::ffi::rustra_ffi_set_max_payload(1024 * 1024) };
    let _ = PAYLOAD_GUARD.fetch_add(1, Ordering::Relaxed);

    let pkg = Package::builder("inspector.golden")
        .command("sum", |args: serde_json::Value| {
            let a = args["a"].as_i64().unwrap_or(0);
            let b = args["b"].as_i64().unwrap_or(0);
            Ok::<_, rustra::RustraError>(serde_json::json!(a + b))
        })
        .build();
    // register_ffi 는 이 바이너리 안에서 최초 호출이므로 반드시 이 패키지가
    // 전역 컨텍스트를 선점한다(OnceLock — 이후 호출은 no-op).
    pkg.register_ffi();
    pkg
}

fn capture_hex() -> String {
    let mut out_len: usize = 0;
    let ptr = unsafe { rustra::ffi::rustra_ffi_capture_snapshot(&mut out_len) };
    assert!(!ptr.is_null(), "registered package must capture a snapshot");
    let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) }.to_vec();
    unsafe { rustra::ffi::rustra_ffi_free(ptr, out_len) };
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn fixture_path() -> PathBuf {
    // CARGO_MANIFEST_DIR 기준 — cargo 실행 디렉터리와 무관하게 결정적.
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(FIXTURE_PATH)
}

#[test]
fn captured_snapshot_matches_committed_golden_fixture() {
    golden_package();
    let captured = capture_hex();

    let fixture_path = fixture_path();
    let update = std::env::var("RUSTRA_UPDATE_GOLDEN").is_ok_and(|v| v == "1");
    if update {
        // RUSTRA_UPDATE_GOLDEN=1 — 캡처 결과를 fixture 로 다시 쓴다(의도적 갱신).
        std::fs::write(
            &fixture_path,
            format!(
                "# B1 inspector snapshot golden — 실제 rustra_ffi_capture_snapshot 캡처의 hex.\n\
                 # 갱신: RUSTRA_UPDATE_GOLDEN=1 cargo test -p rustra --test inspector_golden\n\
                 # 소비: packages/types/src/inspector.test.ts 가 같은 파일을 읽는다(Rust↔TS 단일 아티팩트).\n\
                 {captured}\n"
            ),
        )
        .expect("write golden fixture");
        return;
    }

    let fixture = std::fs::read_to_string(&fixture_path).expect(
        "golden fixture missing — regenerate with RUSTRA_UPDATE_GOLDEN=1 cargo test -p rustra --test inspector_golden",
    );
    let committed = fixture
        .lines()
        .filter(|line| !line.starts_with('#'))
        .find(|line| !line.trim().is_empty())
        .expect("fixture must contain exactly one hex line");
    assert_eq!(
        captured,
        committed.trim(),
        "snapshot bytes drifted from the committed golden fixture — blob shape changed; regenerate the fixture AND re-verify the TS decoder (see header comment)"
    );
}

/// fixture 의 hex 가 실제로 유효한 스냅샷 JSON인지도 함께 고정 — TS 쪽이
/// 기대하는 필드가 정말 그 바이트 안에 있는지 Rust 측에서 먼저 증명한다.
#[test]
fn golden_fixture_decodes_to_expected_fields() {
    golden_package();
    let mut out_len: usize = 0;
    let ptr = unsafe { rustra::ffi::rustra_ffi_capture_snapshot(&mut out_len) };
    let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) }.to_vec();
    unsafe { rustra::ffi::rustra_ffi_free(ptr, out_len) };

    let v: serde_json::Value = serde_json::from_slice(&bytes).expect("capture is valid JSON");
    assert_eq!(v["packageId"], "inspector.golden");
    assert_eq!(
        v["schemaGeneration"], 0,
        "builder-built package starts at generation 0"
    );
    assert_eq!(v["commands"].as_array().unwrap().len(), 1);
    assert_eq!(v["commands"][0]["id"], 1);
    assert_eq!(v["commands"][0]["name"], "sum");
    assert_eq!(v["commands"][0]["capability"], serde_json::Value::Null);
    assert_eq!(v["limits"]["maxPayloadBytes"], 1048576);
    assert_eq!(v["stats"]["registeredCommands"], 1);
    assert!(!v["contractHash"].as_str().expect("hash present").is_empty());
}

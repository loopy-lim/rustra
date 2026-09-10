// ── 네이티브 dylib 핫스왑 코어 (experimental) ────────────────────────────────
//
// 실험적 표면 — versioning-policy의 experimental 규칙 적용 (계약은 1.0 전 언제든
// 깨질 수 있다). 설계: docs/plans/2026-09-09-native-hot-core-design.md.
//
// 구성은 두 층이다:
// - [`JsonDispatch`] 트레잇 — tauri 비의존. `tauri` feature 만으로도 컴파일되어
//   `tauri_support` 의 디스패치 간접화가 hot-core 없이도 성립하게 한다.
// - `hot-core` feature 본체 — `DylibCore`(libloading), `HotCoreHandle`, 감시
//   스레드. dev 전용이며 릴리스 빌드는 정적 링크 경로를 그대로 간다.
//   파일 분할은 ffi_* 관용을 따른다: 결합(hot_core_dylib)과 감시(hot_core_watch).
//
// 호스트는 `RUSTRA_HOT_CORE` 환경변수로 아티팩트 경로를 전달한다(예제 측 계약 —
// 이 모듈은 환경변수를 읽지 않는다).
//
// 초기화 시퀀스는 Bun 어댑터(packages/bun/src/bun-ffi.ts)와 동일하다:
// dlopen → `rustra_mobile_init()` → 디스패치·컨트랙트 심볼 사용. Bun은 dlopen 시
// 정의 테이블로 심볼을 즉시 바인딩하므로(open 직후 rustra_mobile_init 호출) 여기서도
// 필요한 심볼을 open 시점에 전부 바인딩한다.

use crate::Package;
use serde_json::{Value, json};

/// JSON 왕복 디스패치 추상화 — 성공은 결과 값, 실패는 rustra 에러 와이어
/// (`{code, message}` 객체)를 에러로 돌려준다.
///
/// `tauri` 에 의존하지 않는다 — Tauri 호스트(`tauri_support`)뿐 아니라 Bun 등
/// 다른 호스트가 같은 트레잇으로 정적 패키지와 스왑 가능한 dylib 코어를
/// 동일 취급한다. `Send + Sync` 슈퍼트레잇은 `Arc<dyn JsonDispatch>` 를
/// Tauri managed state 로 보관하기 위한 요구다.
pub trait JsonDispatch: Send + Sync {
    /// 명령 하나를 실행한다. 에러 값은 가능한 한
    /// `{"code": <dot-notation>, "message": <string>}` 모양이다.
    fn invoke_json(
        &self,
        command: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, serde_json::Value>;
}

/// 정적 패키지의 [`JsonDispatch`] 구현 — `tauri_support::rustra_dispatch` 가
/// 오늘 하던 에러 매핑(`serde_json::to_value`)을 그대로 옮긴 것이다. 직렬화가
/// 실패할 수 없는 에러 타입이지만 폴백 형태까지 동일하게 유지한다.
impl JsonDispatch for Package {
    fn invoke_json(&self, command: &str, args: Value) -> Result<Value, Value> {
        Package::invoke_json(self, command, args).map_err(|e| {
            serde_json::to_value(&e)
                .unwrap_or_else(|_| json!({"code": "unknown", "message": "unknown error"}))
        })
    }
}

// dylib 결합과 감시는 책임별 파일로 분리한다(architecture-boundaries
// source-module-size 규칙). 두 파일은 이 파사드의 private 서브모듈이며 공개
// 경로는 아래 re-export 가 `rustra::hot_core::*` 로 고정한다.
#[cfg(feature = "hot-core")]
#[path = "hot_core_dylib.rs"]
mod dylib;

#[cfg(feature = "hot-core")]
#[path = "hot_core_watch.rs"]
mod watch;

/// `hot-core` 본체의 공개 표면 — `rustra::hot_core::*` 로 도달한다.
#[cfg(feature = "hot-core")]
pub use dylib::{DylibCore, DylibCoreError, HotCoreHandle, prepare_swap_copy};

/// 감시 스레드 층의 공개 표면.
#[cfg(feature = "hot-core")]
pub use watch::{DylibWatchConfig, SwapCallback, SwapOutcome, spawn_dylib_watch};

// 테스트는 ffi.rs 의 `#[path]` 관용과 동일하되, dylib 본체가 `hot-core` feature
// 에만 존재하므로 test cfg 와 feature cfg 를 모두 요구한다.
#[cfg(all(test, feature = "hot-core"))]
#[path = "hot_core_tests.rs"]
mod tests;

// 감시 재시도 정책(FailureTracker)은 비공개 구현 세부다 — test cfg 에만 노출해
// 정책 단위 테스트가 가능하게 한다(공개 API 표면에는 영향 없음).
#[cfg(all(test, feature = "hot-core"))]
pub use watch::FailureTracker;

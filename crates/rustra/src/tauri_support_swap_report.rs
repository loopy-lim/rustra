// ── 핫코어 스왑의 웹뷰 보고 (tauri_support 파사드의 private 서브모듈) ────────
//
// [`super::register_dispatch`] 로 등록한 핫 모드에서 감시 스레드의 스왑 결과를
// 웹뷰 이벤트로 push 하는 책임만 담는다. 공개 경로는 파사드의 재수출이
// `rustra::tauri_support::*` 로 고정한다(파일 분할은 architecture-boundaries
// source-module-size 규칙 — hot_core 결합/감시 분할과 같은 관용).
//
// 리포터는 스왑 대상 코어 바깥(호스트 측)에 살아 있으므로 스왑을 생존한다 —
// 코어 내부 상태(채널·이벤트 싱크)를 버리는 상태 소실 정책(design 문서)과
// 충돌하지 않는 이유다.

use super::register_dispatch;
use crate::events::EventSink;
use crate::hot_core::JsonDispatch;
use serde_json::json;
use std::sync::{Arc, Mutex};

/// 스왑 보고 이벤트 이름 — `hot_core` 감시 스레드의 스왑 결과가
/// `event_channel(HOT_SWAP_EVENT)` (`rustra://hot-core/swapped`) 채널로
/// emit 된다.
///
/// 패키지 이벤트 이름공간(`rustra://{name}`)이 아닌 **예약 경로 세그먼트**
/// 관례를 따른다(`rustra://channel/{h}` 와 같은 계열) — 스왑 보고는 스키마가
/// 선언하는 이벤트가 아니라 호스트-웹뷰 프로토콜이기 때문이다. 이름에 Tauri 가
/// 거부하는 문자가 없어(`-`, `/` 모두 허용) 치환 없이 그대로 쓰이며, TS 측
/// `rustraEventChannel` 쌍생 규칙(R02)도 동일 채널로 수렴한다.
pub const HOT_SWAP_EVENT: &str = "hot-core/swapped";

/// 핫코어 스왑을 웹뷰 이벤트로 보고하는 싱크 홀더 — [`JsonDispatch`] 와 마찬가지로
/// `hot-core` 타입에 의존하지 않는다(결과는 문자열 튜플로만 받는다).
///
/// 스왑 콜백(`hot_core::DylibWatchConfig::on_swap`)은 감시 스레드에서, 웹뷰 emit
/// 에 필요한 `AppHandle` 은 Tauri 부팅([`tauri::Builder::run`]) 뒤에야 존재한다.
/// [`register_dispatch_with_swap_events`] 의 플러그인 setup 훅이 `AppHandle` 을
/// 얻어 싱크를 설치하고, 호스트의 스왑 콜백은 설치 여부와 무관하게
/// [`HotSwapReporter::report`] 만 호출한다 — 싱크 미설치(웹뷰 부팅 전·headless)면
/// 보고는 no-op 이고 스왑 자체는 계속된다.
#[derive(Clone, Default)]
pub struct HotSwapReporter {
    sink: Arc<Mutex<Option<EventSink>>>,
}

impl HotSwapReporter {
    /// 싱크 없는 리포터를 만든다 — 플러그인 setup 전까지 보고는 no-op 이다.
    pub fn new() -> Self {
        Self::default()
    }

    /// 스왑 결과를 웹뷰 채널(`rustra://hot-core/swapped`)로 보고한다.
    ///
    /// 페이로드는 JSON 문자열(`emit_str`) — 패키지 이벤트와 같은 단일 직렬화
    /// 계약이라 웹뷰 JS `listen` 은 이미 파싱된 객체를 받는다. 성공은
    /// `{"oldContractHash": …, "newContractHash": …}`, 실패는 `{"error": …}`.
    /// 구·신 컨트랙트 해시를 실으므로 이 이벤트가 JS 캐시 재동기화 신호를
    /// 대행한다(스왑 후 웹뷰는 해시 비교로 재호출 여부를 판단할 수 있다 —
    /// design 문서의 `rustra_ffi_schema_generation` 카운터는 도입하지 않음).
    ///
    /// 싱크 패닉은 잡아 stderr 로그 후 건너뛴다 — 감시 스레드(스왑 루프)를
    /// 죽이지 않는다(`EventState::deliver_via_sink` 와 동일 관용).
    pub fn report(&self, outcome: Result<(String, String), String>) {
        // 포이즈닝 관용 — 싱크 옵션 자체는 구조적으로 유효한다(events_state 와 동일).
        let sink = self
            .sink
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let Some(sink) = sink else {
            return; // 웹뷰 미부팅/headless — 보고할 곳이 없으면 조용히 버린다.
        };
        let payload = match outcome {
            Ok((old_contract_hash, new_contract_hash)) => json!({
                "oldContractHash": old_contract_hash,
                "newContractHash": new_contract_hash,
            }),
            Err(error) => json!({ "error": error }),
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            sink(HOT_SWAP_EVENT, payload.to_string().as_str());
        }));
        if result.is_err() {
            eprintln!("rustra: hot swap report sink panicked — report dropped");
        }
    }

    /// 플러그인 setup 이 `AppHandle` 싱크를 설치하는 경로 — 공개하지 않는다.
    /// 싱크 설치는 [`register_dispatch_with_swap_events`] 의 플러그인으로
    /// 고정한다(호스트 `.setup()` 단일 슬롯을 빼앗지 않기 위함 —
    /// super::register_with_events 와 동일 판단).
    fn install(&self, sink: EventSink) {
        self.sink
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .replace(sink);
    }
}

/// [`super::register_dispatch`] + 웹뷰 스왑 보고 — 핫코어 스왑(성공/실패 모두)이
/// `rustra://hot-core/swapped` 채널로 웹뷰에 푸시된다(design 문서의 "웹뷰 스왑
/// 보고"). 노출 커맨드는 [`super::register_dispatch`] 와 동일하다.
///
/// # 배선 ( [`super::register_with_events`] 와 동일 패턴 )
///
/// 싱크 설치는 Tauri **플러그인**의 setup 훅에서 일어난다 — `tauri::Builder` 의
/// `.setup()` 은 단일 슬롯이라 우리가 등록하면 호스트의 훅을 조용히 덮어쓴다
/// (플러그인 setup 은 호스트 setup 과 독립적으로 항상 실행된다). `AppHandle` 은
/// 부팅 뒤에야 존재하므로 setup 시점에 [`HotSwapReporter`] 에 설치하고, 호스트의
/// `on_swap` 콜백은 보유한 리포터 클론으로 [`HotSwapReporter::report`] 를
/// 호출한다 — 설치 시점과 보고 시점의 분리가 이 API 의 요점이다.
///
/// ```rust,ignore
/// let reporter = tauri_support::HotSwapReporter::new();
/// let mut config = DylibWatchConfig::new(artifact, handle.clone());
/// let sink = reporter.clone();
/// config.on_swap = Arc::new(move |outcome| {
///     eprintln!("rustra hot-core: swap {outcome:?}");
///     sink.report(outcome.map_err(|e| e.to_string()));
/// });
/// hot_core::spawn_dylib_watch(config);
/// tauri_support::register_dispatch_with_swap_events(handle, reporter, builder)
/// ```
///
/// [`super::register_with_events`] 의 패키지 이벤트 푸시와 달리 **패키지 이벤트는
/// 배선되지 않는다** — 스왑이 코어 내부 이벤트 싱크를 버리는 상태 소실 정책은
/// 그대로다. 이 함수가 추가하는 것은 스왑 결과 1종뿐이다.
pub fn register_dispatch_with_swap_events<R: tauri::Runtime>(
    dispatch: Arc<dyn JsonDispatch>,
    reporter: HotSwapReporter,
    builder: tauri::Builder<R>,
) -> tauri::Builder<R> {
    let swap_plugin = tauri::plugin::Builder::<R>::new("rustra-hot-swap")
        .setup(move |app, _api| {
            // `app.clone()` — AppHandle 클론(register_with_events 와 동일).
            // AppHandle::emit 은 스레드 안전이므로 감시 스레드에서의 report 도
            // 안전하다.
            reporter.install(crate::tauri_channels::tauri_event_sink(app.clone()));
            Ok(())
        })
        .build();
    register_dispatch(dispatch, builder).plugin(swap_plugin)
}

#[cfg(test)]
mod hot_swap_tests {
    use super::*;
    use crate::tauri_channels::event_channel;

    type Received = Arc<Mutex<Vec<(String, String)>>>;

    fn reporter_with_sink() -> (HotSwapReporter, Received) {
        let reporter = HotSwapReporter::new();
        let received: Received = Arc::new(Mutex::new(Vec::new()));
        let sink_received = Arc::clone(&received);
        reporter.install(Arc::new(move |name: &str, payload: &str| {
            sink_received
                .lock()
                .unwrap()
                .push((name.to_string(), payload.to_string()));
        }));
        (reporter, received)
    }

    /// 채널 고정 — TS `subscribeHotSwap` 이 기대하는 채널과 문자 단위까지 일치해야
    /// 한다(예약 세그먼트 이름이라 치환이 없음을 게이트).
    #[test]
    fn hot_swap_event_maps_to_reserved_channel() {
        assert_eq!(event_channel(HOT_SWAP_EVENT), "rustra://hot-core/swapped");
    }

    /// 성공 페이로드 — camelCase 구·신 해시 2필드(JS 캐시 재동기화 신호의 근거).
    #[test]
    fn report_success_carries_old_and_new_contract_hashes() {
        let (reporter, received) = reporter_with_sink();
        reporter.report(Ok(("aaaa".into(), "bbbb".into())));
        let events = received.lock().unwrap().clone();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, HOT_SWAP_EVENT);
        let payload: serde_json::Value = serde_json::from_str(&events[0].1).unwrap();
        assert_eq!(payload["oldContractHash"], json!("aaaa"));
        assert_eq!(payload["newContractHash"], json!("bbbb"));
        assert!(
            payload.get("error").is_none(),
            "성공 페이로드는 error 필드가 없다"
        );
    }

    /// 실패 페이로드 — 스왑 실패도 웹뷰에 보고된다(조용한 유실 방지).
    #[test]
    fn report_failure_carries_error_only() {
        let (reporter, received) = reporter_with_sink();
        reporter.report(Err("dylib open failed".into()));
        let events = received.lock().unwrap().clone();
        assert_eq!(events.len(), 1);
        let payload: serde_json::Value = serde_json::from_str(&events[0].1).unwrap();
        assert_eq!(payload["error"], json!("dylib open failed"));
        assert!(payload.get("oldContractHash").is_none());
    }

    /// 싱크 미설치(웹뷰 부팅 전/headless) — no-op 으로 조용히 버려진다(스왑은 계속).
    #[test]
    fn report_without_sink_is_a_noop() {
        let reporter = HotSwapReporter::new();
        reporter.report(Ok(("a".into(), "b".into()))); // 패닉 없음 = 통과
        reporter.report(Err("x".into()));
    }
}

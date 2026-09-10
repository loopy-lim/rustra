use crate::Package;
/// Tauri 2와의 통합을 위한 헬퍼 모듈입니다.
///
/// `tauri` feature가 활성화되어야 사용할 수 있습니다.
///
/// ## 사용법
///
/// ```rust,ignore
/// use rustra::tauri_support;
///
/// fn main() {
///     let package = build_my_package();
///     let builder = tauri_support::register(package, tauri::Builder::default());
///     builder
///         .run(tauri::generate_context!())
///         .expect("failed to run tauri app");
/// }
/// ```
///
/// 이벤트 푸시가 필요하면 [`register_with_events`] 를 대신 사용한다 —
/// `Package::emit` 이 즉시 `app.emit("rustra://{name}", payload)` 로
/// 전달된다(폴링 불필요). dylib 핫스왑 모드는 [`register_dispatch`] 를 쓰고,
/// 스왑 결과의 웹뷰 보고가 필요하면 [`register_dispatch_with_swap_events`] 를
/// 쓴다.
use crate::hot_core::JsonDispatch;
use serde_json::{Value, json};
use std::sync::Arc;
use tauri::State;

/// 채널·이벤트 배선 — [`crate::tauri_channels`] 모듈로 분리된 항목을 기존
/// 공개 경로(`rustra::tauri_support::*`)로 그대로 노출하기 위한 재수출이다.
pub use crate::tauri_channels::{
    CHANNEL_BYTES_EVENT_PREFIX, CHANNEL_EVENT_PREFIX, EVENT_CHANNEL_PREFIX,
    create_bytes_channel_for, create_channel_for, drop_channel_for, event_channel,
    rustra_channel_create, rustra_channel_create_bytes, rustra_channel_drop, tauri_event_sink,
};

/// Tauri의 managed state로 보관되는 rustra 디스패치입니다.
///
/// 정적 모드에서는 `Package` 를 [`JsonDispatch`] 로 감싸고, 핫 모드에서는
/// `hot_core::HotCoreHandle` 을 넣는다 — 커맨드 핸들러는 트레잇 뒤에만 의존하므로
/// 코어 스왑이 공개 커맨드 시그니처(`rustra_dispatch` 등)를 흔들지 않는다.
pub struct RustraState {
    dispatch: Arc<dyn JsonDispatch>,
}

impl RustraState {
    /// 디스패치 구현을 감싼 state를 만든다 — 호스트가 직접 `manage` 할 때 쓴다.
    pub fn new(dispatch: Arc<dyn JsonDispatch>) -> Self {
        Self { dispatch }
    }
}

/// 모든 rustra 커맨드를 디스패치하는 Tauri 커맨드 핸들러입니다.
#[tauri::command]
pub fn rustra_dispatch(
    state: State<'_, RustraState>,
    command: String,
    args: Value,
) -> Result<Value, Value> {
    state.dispatch.invoke_json(&command, args)
}

/// 벤치 전용 profiled dispatch — `rustra_dispatch` 와 동일한 왕복이지만 응답에
/// 네이티브 처리 시간 성분을 실어 WebKit 크로싱/JS 직렬화 비용과 분리한다
/// (측정 전용 뒷문 — 프로덕션 경로 오염 없음, 트랙 E1).
///
/// 성분 계약: `nativeNs` = 진입 직후 → 응답 직전 `Instant::now()` 2회 차분
/// (패키지 invoke + 에러 매핑 포함). JS 는 RTT 에서 이 값을 차감해 크로싱
/// 잔차를 추정한다. 타이머 해상도는 `Instant` (ns 등급) 이다.
#[derive(serde::Serialize)]
pub struct ProfiledResponse {
    /// `rustra_dispatch` 가 반환했을 결과 (성공) 또는 에러 객체.
    pub result: Value,
    /// 성공 여부 — dispatch 결과가 에러여도 프로파일링은 성립한다.
    pub ok: bool,
    /// 네이티브 처리 시간 (ns).
    pub native_ns: u128,
}

/// `rustra_dispatch` 의 벤치 전용 변형 — [`ProfiledResponse`] 를 반환한다.
#[tauri::command]
pub fn rustra_dispatch_profiled(
    state: State<'_, RustraState>,
    command: String,
    args: Value,
) -> ProfiledResponse {
    let started = std::time::Instant::now();
    let (result, ok) = match state.dispatch.invoke_json(&command, args) {
        Ok(value) => (value, true),
        Err(error) => (
            serde_json::to_value(&error)
                .unwrap_or_else(|_| json!({"code": "unknown", "message": "unknown error"})),
            false,
        ),
    };
    ProfiledResponse {
        result,
        ok,
        native_ns: started.elapsed().as_nanos(),
    }
}

/// 와이어 배치 요청/응답 항목 — 기존 JSON 계약(`invoke_json`)을 그대로
/// 재사용한다. 각 항목은 독립적으로 실행되며 개별 실패는 요청별 에러 객체로
/// 응답한다(fail-fast 아님 — 순서는 요청 순서대로 보존).
#[derive(serde::Deserialize)]
pub struct BatchRequest {
    pub command: String,
    #[serde(default)]
    pub args: Value,
}

#[derive(serde::Serialize)]
pub struct BatchResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
}

/// 단일 IPC 횡단으로 N 개 명령을 실행하는 Tauri 커맨드 (트랙 E2).
///
/// 개별 명령 실패는 전체 배치를 중단시키지 않고 해당 항목의 `error` 필드로
/// 반환된다 — RN `invokeTypedBatch` 의 fail-fast(첫 에러 throw)와 의도적으로
/// 다른 계약이며, 배치 소비자는 항목별 `ok` 를 검사해야 한다.
#[tauri::command]
pub fn rustra_dispatch_batch(
    state: State<'_, RustraState>,
    requests: Vec<BatchRequest>,
) -> Vec<BatchResponse> {
    run_batch(state.dispatch.as_ref(), requests)
}

/// 배치 실행 본체 — Tauri `State` 없이 검증 가능한 순수 함수로 추출
/// (코어 단위 테스트 대상).
fn run_batch(dispatch: &dyn JsonDispatch, requests: Vec<BatchRequest>) -> Vec<BatchResponse> {
    requests
        .into_iter()
        .map(
            |request| match dispatch.invoke_json(&request.command, request.args) {
                Ok(result) => BatchResponse {
                    ok: true,
                    result: Some(result),
                    error: None,
                },
                Err(error) => BatchResponse {
                    ok: false,
                    result: None,
                    error: Some(serde_json::to_value(&error).unwrap_or_else(
                        |_| json!({"code": "unknown", "message": "unknown error"}),
                    )),
                },
            },
        )
        .collect()
}

/// rustra 패키지를 Tauri 앱 빌더에 등록합니다.
///
/// 이벤트는 폴링으로만 전달됩니다(기존 동작). 푸시 배선이 필요하면
/// [`register_with_events`]를 사용하세요.
///
/// 노출 커맨드는 프로덕션 경로인 [`rustra_dispatch`]·[`rustra_dispatch_batch`]
/// 뿐이다 — 측정 전용 [`rustra_dispatch_profiled`] 은 기본 노출에서 제외된다
/// (A07). 벤치 호스트는 [`register_profiled`] 을 사용한다.
pub fn register<R: tauri::Runtime>(
    package: Package,
    builder: tauri::Builder<R>,
) -> tauri::Builder<R> {
    finish_registration(package, builder, |state, builder| {
        builder
            .manage(state)
            .invoke_handler(tauri::generate_handler![
                rustra_dispatch,
                rustra_dispatch_batch,
                crate::tauri_channels::rustra_channel_create,
                crate::tauri_channels::rustra_channel_create_bytes,
                crate::tauri_channels::rustra_channel_drop
            ])
    })
}

/// [`register`] 의 벤치 변형 — 프로덕션 커맨드에 측정 전용
/// [`rustra_dispatch_profiled`] 이 추가로 노출된다(A07). 프로덕션 앱은
/// [`register`] 나 [`register_with_events`] 를 쓰고, 벤치 호스트만 이 함수를
/// 쓴다.
///
/// [`rustra_dispatch_profiled`] 심볼 자체는 공용 API 로 유지된다 — 이미 이
/// 커맨드를 소비하는 코드의 컴파일은 깨지지 않으며, 분리는 **노출**에만
/// 적용된다. Tauri invoke 는 handler 목록에 등록된 커맨드에만 도달하므로
/// production 등록에서 빠지면 노출이 꺼진다.
pub fn register_profiled<R: tauri::Runtime>(
    package: Package,
    builder: tauri::Builder<R>,
) -> tauri::Builder<R> {
    finish_registration(package, builder, |state, builder| {
        builder
            .manage(state)
            .invoke_handler(tauri::generate_handler![
                rustra_dispatch,
                rustra_dispatch_profiled,
                rustra_dispatch_batch,
                crate::tauri_channels::rustra_channel_create,
                crate::tauri_channels::rustra_channel_create_bytes,
                crate::tauri_channels::rustra_channel_drop
            ])
    })
}

/// 등록 공통 — `RustraState` 를 만들어 배선 클로저에 넘긴다. `register` 와
/// `register_profiled` 는 노출 커맨드 목록 하나로만 갈라진다. `Package` 는
/// [`JsonDispatch`] 로 감싸 넣는다 — 정적 모드와 핫 모드(`register_dispatch`)가
/// 같은 state 모양을 공유한다.
fn finish_registration<R, F>(
    package: Package,
    builder: tauri::Builder<R>,
    wire: F,
) -> tauri::Builder<R>
where
    R: tauri::Runtime,
    F: FnOnce(RustraState, tauri::Builder<R>) -> tauri::Builder<R>,
{
    wire(
        RustraState {
            dispatch: Arc::new(package),
        },
        builder,
    )
}

/// 핫 모드 등록 — 이미 구성된 [`JsonDispatch`] 구현(예: `hot_core::HotCoreHandle`)
/// 을 그대로 manage 한다. 정적 코어와 dylib 코어의 스왑이 공개 커맨드 시그니처를
/// 바꾸지 않는다.
///
/// 노출 커맨드는 [`register`] 와 동일하다(프로덕션 경로 + 채널 3종).
/// 이벤트 푸시 배선([`register_with_events`] 의 플러그인)은 여기에 없다 —
/// 스왑이 코어 내부 상태(이벤트 싱크 포함)를 버리는 설계라
/// docs/plans/2026-09-09-native-hot-core-design.md 의 상태 소실 정책을 따른다.
/// 스왑 자체의 웹뷰 보고가 필요하면 [`register_dispatch_with_swap_events`] 를
/// 쓴다 — 싱크는 스왑 대상 코어 바깥(호스트 측 리포터)에 살아 스왑을 생존한다.
pub fn register_dispatch<R: tauri::Runtime>(
    dispatch: Arc<dyn JsonDispatch>,
    builder: tauri::Builder<R>,
) -> tauri::Builder<R> {
    builder
        .manage(RustraState { dispatch })
        .invoke_handler(tauri::generate_handler![
            rustra_dispatch,
            rustra_dispatch_batch,
            crate::tauri_channels::rustra_channel_create,
            crate::tauri_channels::rustra_channel_create_bytes,
            crate::tauri_channels::rustra_channel_drop
        ])
}

/// 스왑 보고 책임은 별도 파일로 분리한다(architecture-boundaries
/// source-module-size 규칙 — hot_core 결합/감시 분할과 같은 `#[path]` 관용).
/// 공개 경로는 아래 재수출이 `rustra::tauri_support::*` 로 고정한다.
#[path = "tauri_support_swap_report.rs"]
mod swap_report;

pub use swap_report::{HOT_SWAP_EVENT, HotSwapReporter, register_dispatch_with_swap_events};

/// [`register`] + 이벤트 푸시 배선 — `Package::emit` 이 즉시
/// `app.emit("rustra://{name}", payload_json)` 로 전달된다.
///
/// `register` 의 노출 커맨드 목록을 그대로 따른다 —
/// `rustra_dispatch_profiled` 미포함(A07).
///
/// 싱크 설치는 Tauri **플러그인**의 setup 훅에서 일어난다. `tauri::Builder`
/// 자체의 `.setup()` 은 단일 슬롯이라 우리가 등록하면 호스트가 나중에 자기
/// `.setup()` 을 붙일 때 우리 훅을 조용히 덮어써버린다 — 플러그인 setup 은
/// 호스트 setup 과 독립적으로 항상 실행되므로 이 문제가 없다.
///
/// # 채널 네이밍
///
/// 이벤트별 채널: `rustra://{name}` (예: `rustra://llm.stream-token`).
/// Tauri `listen()` 이 채널 이름으로 필터링하므로 JS 쪽에서 이름 기반
/// 구독이 한 번에 된다(단일 와일드카드 채널 + JS 측 필터보다 낫다).
/// Tauri 는 채널 이름에 영숫자/`-`/`/`/`:`/`_` 만 허용하므로 그 외 문자는
/// `sanitize_event_name` 규칙으로 치환한다(예: `a.b` → `a_b`).
///
/// # 페이로드 형태
///
/// 페이로드는 JSON **문자열** 그대로(`emit_str`) 웹뷰로 전달된다 — rustra
/// 이벤트 페이로드는 이미 JSON 직렬화된 `String` 이므로 이중 직렬화가 없다.
/// Tauri 웹뷰 경로는 문자열을 JS 소스에 원시 splice 하므로 **JS `listen`
/// 콜백은 이미 파싱된 객체를 받는다** — `JSON.parse` 불필요. Rust 쪽
/// `listen` 만 원시 문자열을 본다(헤드리스 테스트가 확인하는 지점).
///
/// # 에러 처리
///
/// `app.emit` 실패는 stderr 에 로그만 남긴다 — 싱크 안에서
/// 패닉하거나 프로세스를 죽이지 않는다(이벤트 1건 유실).
pub fn register_with_events<R: tauri::Runtime>(
    package: Package,
    builder: tauri::Builder<R>,
) -> tauri::Builder<R> {
    // Package 는 Arc 내부 상태라 clone 이 공유된다 — 플러그인 setup 훅에서
    // 싱크를 설치해도 register 가 manage() 하는 패키지와 동일한 인스턴스다.
    let push_package = package.clone();
    let push_plugin = tauri::plugin::Builder::<R>::new("rustra-events")
        .setup(move |app, _api| {
            push_package.set_event_sink(Some(tauri_event_sink(app.clone())));
            Ok(())
        })
        .build();
    register(package, builder).plugin(push_plugin)
}

// 테스트도 `#[path]` 서브모듈로 분리한다(hot_core_tests.rs 와 같은 관용) —
// 본체는 등록·디스패치 배선만 남는다.
#[cfg(test)]
#[path = "tauri_support_tests.rs"]
mod tests;

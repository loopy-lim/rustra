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
/// 전달된다(폴링 불필요).
use crate::Package;
use serde_json::{Value, json};
use std::sync::Arc;
use tauri::{Emitter, State};

/// rustra 이벤트 채널의 접두사. 이벤트 `name` 은 `rustra://{name}` 채널로
/// emit 된다.
pub const EVENT_CHANNEL_PREFIX: &str = "rustra://";

/// Tauri의 managed state로 보관되는 rustra 패키지입니다.
pub struct RustraState {
    /// 등록된 rustra 명령 패키지입니다.
    pub package: Package,
}

/// 모든 rustra 커맨드를 디스패치하는 Tauri 커맨드 핸들러입니다.
#[tauri::command]
pub fn rustra_dispatch(
    state: State<'_, RustraState>,
    command: String,
    args: Value,
) -> Result<Value, Value> {
    state.package.invoke_json(&command, args).map_err(|e| {
        serde_json::to_value(&e)
            .unwrap_or_else(|_| json!({"code": "unknown", "message": "unknown error"}))
    })
}

/// rustra 패키지를 Tauri 앱 빌더에 등록합니다.
///
/// 이벤트는 폴링으로만 전달됩니다(기존 동작). 푸시 배선이 필요하면
/// [`register_with_events`]를 사용하세요.
pub fn register<R: tauri::Runtime>(
    package: Package,
    builder: tauri::Builder<R>,
) -> tauri::Builder<R> {
    builder
        .manage(RustraState { package })
        .invoke_handler(tauri::generate_handler![rustra_dispatch])
}

/// [`register`] + 이벤트 푸시 배선 — `Package::emit` 이 즉시
/// `app.emit("rustra://{name}", payload_json)` 로 전달된다.
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
/// [`sanitize_event_name`] 규칙으로 치환한다(예: `a.b` → `a_b`).
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

/// `AppHandle` 로 이벤트를 emit 하는 [`crate::events::EventSink`] 를 만든다.
///
/// `register_with_events` 가 내부적으로 사용하는 것과 동일한 싱크를, 호스트가
/// 자체 setup 흐름에서 직접 설치할 때 쓸 수 있다(예: 자체 플러그인/명령에서
/// `app.handle().clone()` 을 이미 들고 있는 경우):
///
/// ```rust,ignore
/// use rustra::tauri_support::tauri_event_sink;
///
/// tauri::Builder::default()
///     .setup(|app| {
///         let package = build_my_package();
///         package.set_event_sink(Some(tauri_event_sink(app.handle().clone())));
///         app.manage(RustraState { package });
///         Ok(())
///     })
/// ```
///
/// `AppHandle::emit` 은 내부적으로 스레드 안전이므로 emit 을 호출하는
/// 어떤 스레드에서도 이 싱크를 안전하게 호출할 수 있다.
pub fn tauri_event_sink<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> crate::events::EventSink {
    Arc::new(move |name: &str, payload: &str| {
        let channel = event_channel(name);
        if let Err(error) = app.emit_str(&channel, payload.to_string()) {
            eprintln!("rustra: tauri emit failed on channel '{channel}' (event '{name}'): {error}");
        }
    })
}

/// 이벤트 이름 → Tauri 채널 이름 매핑 (`rustra://{sanitized}`).
///
/// Tauri 가 채널 이름에 허용하는 문자는 영숫자, `-`, `/`, `:`, `_` 뿐이다.
/// 그 외 문자(예: `.`)는 `_` 로 치환한다. 치환 후 충돌 가능성은 문서상
/// 주의로만 다룬다 — 실제 이벤트 이름은 kebab/dot 구분 없이 rustra 관례
/// (`progress.tick`) 를 따르므로, 동일 세트에서 충돌하려면 접두사만 다른
/// 이름(`a.b-c` vs `a.b_c`)을 의도적으로 만들어야 한다.
pub fn event_channel(name: &str) -> String {
    format!("{EVENT_CHANNEL_PREFIX}{}", sanitize_event_name(name))
}

/// Tauri 채널 이름 규칙(영숫자/`-`/`/`/`:`/`_`)으로 이름을 정규화한다.
fn sanitize_event_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '/' | ':' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_channel_uses_per_name_rustra_namespace() {
        assert_eq!(
            event_channel("llm.stream-token"),
            "rustra://llm_stream-token"
        );
        assert_eq!(event_channel("progress.tick"), "rustra://progress_tick");
        assert_eq!(event_channel("plain"), "rustra://plain");
        assert_eq!(event_channel("a:b/c-d_e"), "rustra://a:b/c-d_e");
    }

    #[test]
    fn event_channel_sanitizes_characters_tauri_rejects() {
        // Tauri EventName::new 은 영숫자/-,/, :, _ 외 문자를 가진 이름을
        // 에러로 거부한다 — emit 실패(=이벤트 유실)가 되지 않게 미리 치환.
        // (Tauri 검증이 char::is_alphanumeric() 을 쓰므로 한글 등 비ASCII
        // 영숫자는 그대로 통과한다 — 우리 치환 규칙과 동일 기준.)
        assert_eq!(event_channel("has space"), "rustra://has_space");
        assert_eq!(event_channel("a.b c"), "rustra://a_b_c");
        assert_eq!(event_channel("weird!*()"), "rustra://weird____");
    }
}

//! Tauri 이벤트 채널 배선 — rustra 이벤트와 채널을 Tauri 채널로 내보냅니다.
//!
//! `tauri` feature가 활성화되어야 사용할 수 있습니다.
//! `tauri_support` 가 이 모듈의 공개 항목 전부를 재수출하므로 기존 공개
//! 경로(`rustra::tauri_support::CHANNEL_EVENT_PREFIX` 등)는 변하지 않는다.
//!
//! ## 다루는 배선
//!
//! - 이벤트 푸시: `Package::emit` → `rustra://{name}` 채널 emit
//!   ([`tauri_event_sink`]·[`event_channel`]).
//! - 채널 푸시: JS 어댑터 발급 핸들 → `rustra://channel/{h}` /
//!   `rustra://channel-bytes/{h}` 채널 emit ([`create_channel_for`]·
//!   [`create_bytes_channel_for`]).
use crate::PackageBuilder;
use serde_json::{Value, json};
use std::sync::Arc;
use tauri::Emitter;

/// rustra 이벤트 채널의 접두사. 이벤트 `name` 은 `rustra://{name}` 채널로
/// emit 된다.
pub const EVENT_CHANNEL_PREFIX: &str = "rustra://";

/// 채널 프레임의 예약 이벤트 세그먼트 — 핸들 `h` 는
/// `rustra://channel/{h}` 채널로 emit 된다. 이벤트 이름공간
/// (`rustra://{name}`)과 구조적으로 분리되어, 스키마가 `channel` 이라는
/// 이름의 이벤트를 선언해도 충돌하지 않는다.
pub const CHANNEL_EVENT_PREFIX: &str = "rustra://channel/";

/// 바이너리 채널 프레임의 예약 이벤트 세그먼트 — 핸들 `h` 는
/// `rustra://channel-bytes/{h}` 채널로 emit 된다. JSON 프레임
/// ([`CHANNEL_EVENT_PREFIX`])와 이벤트 채널이 분리되어 있어 한 핸들이 한
/// 경로로만 동작한다(RN `createBytesChannel` 계약과 동일 — Rust 측에서도
/// `ChannelHost` 의 별도 테이블에 등록된다, 동일 핸들 번호 공간).
/// `-` 는 Tauri 채널 이름에 허용되는 문자다.
pub const CHANNEL_BYTES_EVENT_PREFIX: &str = "rustra://channel-bytes/";

/// JS 어댑터 발급 커맨드 — `createChannel(callback)` 이 invoke 한다.
/// Tauri IPC 는 함수 값을 실어 보낼 수 없으므로 콜백은 받지 않는다: 핸들만
/// 발급하고, sender 는 [`create_channel_for`] 가 `rustra://channel/{handle}`
/// emit 으로 고정 배선한다(어댑터가 같은 채널을 listen).
///
/// 반환: `{ "handle": u32 }`. 핸들 공간 소진 시 `handle: 0` — JS 어댑터가
/// loud-fail 한다.
#[tauri::command]
pub fn rustra_channel_create<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Value {
    let handle = create_channel_for(&app);
    json!({ "handle": handle })
}

/// JS 어댑터 발급 커맨드 — `createChannelBytes(callback)` 이 invoke 한다.
/// [`rustra_channel_create`] 의 바이너리 변형: 핸들만 발급하고 sender 는
/// [`create_bytes_channel_for`] 가 `rustra://channel-bytes/{handle}` emit 으로
/// 고정 배선한다(어댑터가 같은 채널을 listen).
///
/// 반환: `{ "handle": u32 }`. 핸들 공간 소진 시 `handle: 0` — JS 어댑터가
/// loud-fail 한다. 해제는 공용 [`rustra_channel_drop`] — `ChannelHost::drop_channel`
/// 이 JSON/바이너리 양쪽 테이블을 해제하므로 별도 drop 커맨드가 필요 없다.
#[tauri::command]
pub fn rustra_channel_create_bytes<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Value {
    let handle = create_bytes_channel_for(&app);
    json!({ "handle": handle })
}

/// JS 어댑터 `close()` 가 invoke 한다 — [`drop_channel_for`] 참고.
#[tauri::command]
pub fn rustra_channel_drop<R: tauri::Runtime>(app: tauri::AppHandle<R>, handle: u32) -> bool {
    drop_channel_for(&app, handle)
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
///         app.manage(RustraState::new(Arc::new(package)));
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

/// 웹뷰(JS) 발급자용 채널을 `ChannelHost` 에 등록하고 핸들을 발급한다.
///
/// sender 는 `AppHandle` 과 핸들을 캡처해 [`CHANNEL_EVENT_PREFIX`]{handle}
/// 채널로 emit 한다 — JS 어댑터(`packages/tauri` createChannel)가 같은 채널을
/// `listen` 하여 콜백으로 변환한다. 핸들 캡처를 위해 reserve→insert 2단계를
/// 쓴다(`ffi_channel.rs` 와 동일 관용).
///
/// 반환 핸들은 1부터 단조 증가하며 0 은 핸들 공간 소진(u32 exhaustion) —
/// 호출자(JS 어댑터)가 loud-fail 한다.
///
/// # 근사 유니캐스트
///
/// 채널 계약([`crate::channels`])은 호출 귀속 유니캐스트지만 Tauri emit 은
/// 브로드캐스트다. `rustra://channel/{handle}` 채널명으로 근사한다 — 같은
/// 프로세스의 다른 웹뷰가 같은 채널명을 listen 하면 프레임을 관측할 수 있다.
/// 정상 흐름(단일 발급자 = 단일 listen)에서는 유니캐스트와 동일하다.
pub fn create_channel_for<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> u32 {
    let handle = crate::channels::host().reserve_handle();
    if handle == 0 {
        return 0;
    }
    let app_for_sender = app.clone();
    crate::channels::host().register_channel_with_handle(
        handle,
        Arc::new(move |payload: &str| {
            let channel = format!("{CHANNEL_EVENT_PREFIX}{handle}");
            if let Err(error) = app_for_sender.emit_str(&channel, payload.to_string()) {
                eprintln!("rustra: tauri channel emit failed (handle {handle}): {error}");
            }
        }),
    );
    handle
}

/// JS 어댑터 `close()` 의 Rust 측 — 채널을 해제한다. 이후 동일 핸들 send 는
/// `false`(stale). 이미 없는 핸들은 `false`(double-drop 무해). JSON 채널과
/// 바이너리 채널 양쪽을 해제한다(`ChannelHost::drop_channel`).
pub fn drop_channel_for<R: tauri::Runtime>(_app: &tauri::AppHandle<R>, handle: u32) -> bool {
    crate::channels::host().drop_channel(handle)
}

/// 웹뷰(JS) 발급자용 **바이너리** 채널을 `ChannelHost` 에 등록하고 핸들을
/// 발급한다 — [`create_channel_for`] 의 바이너리 대응. JSON 경로와 동일한
/// 핸들 번호 공간과 배선 관용을 쓴다(reserve→insert 2단계, sender 가
/// `AppHandle`+핸들을 캡처, send 클로저의 패닉은 `ChannelHost::send_bytes` 가
/// 잡아 무시 — `send` 와 동일 계약). 등록 테이블은 별도
/// (`bytes_channels`)라 한 핸들은 한 경로로만 동작한다.
///
/// 반환 핸들은 JSON 경로와 같은 단조 증가 번호이며 0 은 핸들 공간 소진
/// (u32 exhaustion) — 호출자(JS 어댑터)가 loud-fail 한다.
///
/// # 직렬화 비용 (솔직 고지)
///
/// `Emitter::emit` 의 serde 직렬화가 `Vec<u8>` 를 JSON **숫자 배열**
/// (`[104,101,…]`)로 내보낸다 — 바이트당 평균 약 4 문자(최대 3자리 십진수 +
/// 구분 쉼표)로 와이어가 최대 ~4배 부풀고, 웹뷰 쪽에서 배열 리터럴 평가 +
/// 요소별 Number 박싱 비용이 추가된다. RN 경로(FFI 가 ArrayBuffer 를
/// 무손실 전달)보다 눈에 띄게 비싸다. 기능 우선 패리티를 위해 이 비용을
/// 수용한다 — 향후 Tauri 가 채널 수준 raw-bytes 전송 계층을 안정 노출하면
/// 이 지점만 교체한다(JS 계약 `Uint8Array` 는 변하지 않는다).
///
/// # 근사 유니캐스트
///
/// [`create_channel_for`] 와 동일 — Tauri emit 은 브로드캐스트지만
/// `rustra://channel-bytes/{handle}` 채널명으로 근사한다. 같은 프로세스의
/// 다른 웹뷰가 같은 채널명을 listen 하면 프레임을 관측할 수 있다.
pub fn create_bytes_channel_for<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> u32 {
    let handle = crate::channels::host().reserve_handle();
    if handle == 0 {
        return 0;
    }
    let app_for_sender = app.clone();
    crate::channels::host().register_channel_bytes_with_handle(
        handle,
        Arc::new(move |payload: &[u8]| {
            let channel = format!("{CHANNEL_BYTES_EVENT_PREFIX}{handle}");
            // serde 가 Vec<u8> 를 JSON 숫자 배열로 직렬화한다 — 비용 고지는
            // 위 함수 doc 주석 참고.
            if let Err(error) = app_for_sender.emit(&channel, payload.to_vec()) {
                eprintln!("rustra: tauri bytes channel emit failed (handle {handle}): {error}");
            }
        }),
    );
    handle
}

/// 이벤트 이름 → Tauri 채널 이름 매핑 (`rustra://{sanitized}`).
///
/// Tauri 가 채널 이름에 허용하는 문자는 영숫자, `-`, `/`, `:`, `_` 뿐이다.
/// 그 외 문자(예: `.`)는 `_` 로 치환한다. 영숫자 판정은 Unicode 기준
/// (`char::is_alphanumeric()`) 이라 한글·CJK 등 비 ASCII 이름도 그대로
/// 보존된다(예: `진행.갱신` → `진행_갱신`).
///
/// # 충돌 정책 (R02)
///
/// 서로 다른 이름이 같은 채널로 수렴하면(`a.b` vs `a_b`) 조용한 오배선이므로,
/// **선언된 이벤트**는 `Package::build` 시점에 거부한다 — 정규화 맵 검증은
/// 빌더(`validate_event_channel_uniqueness`)가 담당하고, 선언 없이 emit 만
/// 하는 이름은 등록 대상이 아니므로 검증 대상이 아니다. NFC 정규화는 하지
/// 않는다 — 정규화 후 같아지는 이름(café의 분해형/합성형)도 다른 이름이며,
/// 그런 이름끼리 충돌하면 마찬가지로 빌드가 거부된다. TS 구독 측
/// `rustraEventChannel` 이 동일 알고리즘의 문자 단위 쌍생(twin)이다.
pub fn event_channel(name: &str) -> String {
    format!(
        "{EVENT_CHANNEL_PREFIX}{}",
        PackageBuilder::sanitize_event_name(name)
    )
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

    #[test]
    fn event_channel_preserves_unicode_alphanumerics_by_codepoint() {
        // R02 — 코드포인트 순회 + Unicode 알파벳 보존. TS `rustraEventChannel`
        // 과 공유하는 골든 테이블의 일부(twin: packages/tauri/src/index.test.ts
        // GOLDEN_CASES, integration: examples/tauri-calculator
        // tests/event_name_mapping.rs). 비 BMP 문자가 코드포인트 1개로 쳐지는지
        // (surrogate 2개가 아니라) 함께 고정한다.
        assert_eq!(event_channel("진행.갱신"), "rustra://진행_갱신");
        assert_eq!(event_channel("a.b"), "rustra://a_b");
        assert_eq!(event_channel("cafe\u{0301}"), "rustra://cafe_");
        assert_eq!(event_channel("done\u{1F389}now"), "rustra://done_now");
        assert_eq!(event_channel("n.𝕏"), "rustra://n_𝕏");
    }
}

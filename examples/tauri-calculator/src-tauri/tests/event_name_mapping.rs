//! R02 — 이벤트 채널명 규칙 통일 + 빌드 타임 충돌 거부 검증.
//!
//! 세 가지를 증명한다:
//!
//! 1. **공동 골든 테이블** — Rust `event_channel` 이 TS
//!    `@rustra/tauri` `rustraEventChannel` 과 문자 그대로 동일한 input→output
//!    표를 통과한다(양쪽 drift 검출 — 표는 TS 테스트와 쌍으로 유지).
//! 2. **충돌 거부** — 서로 다른 이벤트 이름이 같은 정규화 채널로 수렴하면
//!    (`a.b` vs `a_b`) `Package::build` 가 패닉한다(조용한 덮어쓰기 금지).
//! 3. **emit/listen 정합** — MockRuntime 에서 한국어 이름 이벤트를 emit 하면
//!    문서화된 채널 리터럴 `rustra://진행_갱신` 을 구독한 리스너가 받는다.
//!    JS 클라이언트가 하는 방식 그대로, `event_channel()` 호출 없이
//!    **문자열 리터럴**로 구독하는 것이 양쪽 알고리즘 일치의 증명 지점이다.

use rustra::Package;
use rustra::prelude::*;
use rustra::tauri_support::{self, event_channel};
use std::sync::{Arc, Mutex};
use tauri::Listener;
use tauri::test::{mock_context, noop_assets};

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    value: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct AlternatePayload {
    ok: bool,
}

/// 공동 골든 테이블 — packages/tauri/src/index.test.ts 의 `GOLDEN_CASES` 와
/// 문자 그대로 동일한 리터럴이다. 규칙을 바꿀 때는 양쪽을 함께 갱신해야 하며,
/// 한쪽만 바꾸면 이 테이블이 drift 를 검출한다. 보장은 "같은 술어, 각자의
/// Unicode 테이블"이다 — 유니코드 버전이 올라가 판정이 바뀌면 각자 갱신하며,
/// 수렴 사례는 빌드 타임 충돌 거부가 잡는다.
///
/// 결합 문자(cafe + U+0301)는 에디터 NFC 정규화에 갈라지지 않게 이스케이프로
/// 적는다. 비 BMP 사례(이모지, U+1D54F 𝕏)는 코드포인트 순회 증명용 — 구 JS
/// 규칙은 surrogate 2개로 갈라 `done__now`/`n__` 를 만들었다.
const GOLDEN_CASES: &[(&str, &str)] = &[
    // 기본 치환 — '.' → '_'.
    ("progress.tick", "rustra://progress_tick"),
    // 한국어(Unicode 알파벳) 보존 — 구 JS 규칙은 전부 '_' 로 깨뜨렸다.
    ("진행.갱신", "rustra://진행_갱신"),
    ("a.b", "rustra://a_b"),
    ("llm.stream-token", "rustra://llm_stream-token"),
    ("a b/c", "rustra://a_b/c"),
    // 결합 문자(U+0301)는 알파벳이 아니므로 '_' — NFC 정규화는 하지 않는다.
    ("cafe\u{0301}", "rustra://cafe_"),
    // 비 BMP 이모지는 코드포인트 1개 — '_' 1개 (surrogate 2개 아님).
    ("done🎉now", "rustra://done_now"),
    // 비 BMP 영숫자(U+1D54F) 보존 — 구 JS 규칙은 surrogate 쌍을 '__' 로.
    ("n.𝕏", "rustra://n_𝕏"),
    // Alphabetic-but-not-L (U+0345, ypogegrammeni) 보존 게이트 — 술어를
    // `\p{L}|\p{N}` 으로 "단순화"하면 이 행이 깨진다. `is_alphanumeric()` =
    // Alphabetic ∪ N 이라는 설계 결정을 산문 대신 게이트로 고정한다.
    ("ypogegrammeni:\u{0345}", "rustra://ypogegrammeni:\u{0345}"),
];

#[test]
fn golden_table_matches_the_shared_channel_rule() {
    for (input, expected) in GOLDEN_CASES {
        assert_eq!(
            event_channel(input),
            *expected,
            "channel mapping drifted for {input:?} — TS/Rust 골든 테이블 동기 필요"
        );
    }
}

#[test]
#[should_panic(expected = "event channel collision: \"a.b\" and \"a_b\" both map to a_b")]
fn build_rejects_distinct_names_converging_to_one_channel() {
    let _ = Package::builder("example.event-collision")
        .event::<ProgressPayload>("a.b")
        .event::<AlternatePayload>("a_b")
        .build();
}

type Received = Arc<Mutex<Vec<String>>>;

#[test]
fn korean_named_event_reaches_the_documented_channel() {
    let pkg = Package::builder("example.event-mapping")
        .event::<ProgressPayload>("진행.갱신")
        .build();
    let emit_pkg = pkg.clone();
    let builder = tauri_support::register_with_events(pkg, tauri::test::mock_builder());
    let app = builder
        .build(mock_context(noop_assets()))
        .expect("mock app builds");

    let received: Received = Arc::new(Mutex::new(Vec::new()));
    let sink_received = Arc::clone(&received);
    // JS 클라이언트 방식 그대로 — 채널을 문자열 리터럴로 구독한다.
    app.listen("rustra://진행_갱신", move |event| {
        sink_received
            .lock()
            .unwrap()
            .push(event.payload().to_string());
    });

    emit_pkg.emit("진행.갱신", serde_json::json!({ "value": 42 }));

    let events = received.lock().unwrap().clone();
    assert_eq!(
        events.len(),
        1,
        "Korean-named event must reach the documented channel"
    );
    let payload: serde_json::Value = serde_json::from_str(&events[0]).unwrap();
    assert_eq!(payload["value"], 42);
}

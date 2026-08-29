//! Rust → JS 이벤트 푸시를 위한 구독 버스 + 푸시 싱크.
//!
//! `Package::emit(event, payload)` 로 발행된 이벤트를 호스트 어댑터가 전달받는
//! 경로는 두 가지다:
//!
//! 1. **폴링** — 이벤트가 [`EventBus`] 큐에 쌓이고, 호스트가
//!    `take_pending_events()` 로 주기적으로 꺼내 자기 플랫폼의 푸시 채널(Tauri
//!    `emit`, RN `DeviceEventEmitter`)로 전달한다.
//! 2. **푸시** — [`Package::set_event_sink`] 로 [`EventSink`] 콜백을 등록하면
//!    `emit` 이 즉시 콜백을 호출한다. 폴링 루프가 없어도 되고 지연도 없다
//!    (LLM 토큰 스트리밍처럼 낮은 지연이 중요한 용도).
//!
//! 두 경로는 **상호 배타적**이다 — 싱크가 설치된 동안 `emit` 은 버스를 건너뛴다
//! (푸시+폴링을 함께 쓰는 호스트에서 같은 이벤트가 두 번 수신되는 것을 방지).
//! `set_event_sink(None)` 으로 해제하면 즉시 폴링 경로로 돌아간다.
//!
//! 설계 제약:
//! - 페이로드는 직렬화된 JSON `String`으로 저장한다 — 코드gen된 각 이벤트 타입과
//!   디커플링되고, 모든 어댑터가 이미 JSON 디코딩 경로를 갖는다.
//! - 큐는 고정 용량(기본 1024). 넘치면 가장 오래된 이벤트를 버리고
//!   `dropped` 카운터를 증가시킨다 — 호스트가 느리면 뒤처지는 것이지
//!   Rust 호출을 블록하지 않는다(backpressure 정책: drop-oldest).
//! - `Mutex` 하나로 보호한다 — 이벤트 빈도는 invoke 보다 훨씬 낮다는 가정.

use std::collections::VecDeque;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

/// 발행된 단일 이벤트.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct RustraEvent {
    /// 이벤트 이름 (예: `"progress.tick"`).
    pub name: String,
    /// JSON 직렬화된 페이로드.
    pub payload: String,
    /// 단조 증가 시퀀스 번호 — 호스트가 순서 검증에 사용.
    pub seq: u64,
}

/// 발행된 단일 이벤트의 푸시 전달 콜백.
///
/// 호스트가 [`Package::set_event_sink`](crate::Package::set_event_sink) 로
/// 등록하면 `emit` 이 버스 적재 대신 이 콜백을 즉시 호출한다. 인자는
/// `(이벤트 이름, JSON 직렬화된 페이로드)`.
///
/// # 계약
///
/// - **스레드 안전**: 콜백은 `emit` 을 호출한 스레드에서 실행된다(어느 스레드에서든
///   호출될 수 있다). Tauri `Emitter::emit` 은 내부적으로 스레드 안전하지만,
///   JSI 처럼 런타임 스레드 친화성이 필요한 호스트는 콜백 안에서 자체
///   마샬링/큐잉을 해야 한다.
/// - **패닉 격리**: 콜백은 호스트 제공 코드다. 패닉하면 stderr 에 로그 남고
///   해당 emit 은 조용히 건너뛴다(패닉이 `emit` 호출자로 전파되지 않고,
///   싱크도 유지된다 — 다음 emit 에서 다시 시도한다).
/// - **전달 순서**: 동일 스레드에서 연속 `emit` 하면 호출 순서가 보장된다.
///   멀티 스레드 emit 의 전역 순서는 보장되지 않는다(폴링 경로의 `seq` 와 동일).
pub type EventSink = Arc<dyn Fn(&str, &str) + Send + Sync>;

include!("events_state.rs");

include!("events_bus.rs");

#[cfg(test)]
#[path = "events_tests.rs"]
mod tests;

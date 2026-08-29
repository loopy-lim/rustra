//! 채널/리소스 — Tauri v2 `ipc::Channel`·`Resource` 모델의 rustra 계약 버전.
//!
//! # 계약 개요
//!
//! JS→Rust 인자에 콜백이나 객체 참조를 실는 대신, wire에는 **정수 핸들**만
//! 실린다. 두 종류의 핸들 있다:
//!
//! - **채널 핸들** (`u32`) — 호스트가 발급. Rust 가 `channel_send(handle,
//!   payload_json)` 로 역방향 데이터를 흘린다. Tauri `ipc::Channel<T>` 와
//!   동일한 방향(네이티브→JS 스트림)이지만 이벤트 싱크와 달리 **호출별
//!   회신 채널**이다 — 커맨드 인자로 전달되어 해당 호출에만 귀속된다.
//! - **리소스 핸들** (`u32`) — Rust 가 발급. `ResourceTable` 이 Rust-소유
//!   객체를 담고 JS 는 정수 id 로만 참조한다. 메서드 호출은 코드젠된
//!   커맨드(`resource_call`)로 라우팅되고, 소유권은 테이블에 있다.
//!   JS-first 객체 브릿지(Nitro HybridObject)가 아니다 — 방향이 반대다.
//!
//! # 왜 이벤트 싱크와 별개인가
//!
//! `Package::emit` + `EventSink` 는 **브로드캐스트**(모든 리스너, 패키지
//! 수명 주기)고, 채널은 **유니캐스트 회신**(단일 호출자, 호출 수명 주기).
//! Tauri 도 `Channel` 을 별개 타입으로 둔다.
//!
//! # 핸들 안전
//!
//! 채널/리소스 핸들 공간은 **호스트별 단일 테이블**에서 관리된다
//! ([`ChannelHost`]). u32 는 단조 증가하며 재사용되지 않는다 — 해제된
//! 핸들로의 send 는 조용한 에러(`channel.closed`)가 아니라 **무시**
//! (`Ok(false)`)가 원칙이다. 호출이 끝난 회신 채널은 드롭되고, 같은 번호의
//! 핸들이 다시 나와도 이미 테이블에서 제거됐으므로 stale send 는 도달할
//! 수 없다.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// 호스트가 구현하는 채널 수신端 — `channel_send` 호출 시 실행된다.
///
/// `payload` 는 JSON 직렬화된 문자열(이벤트 싱크와 동일 인코딩 — rkyv V2
/// 요청/응답 프레임 안에 문자열 필드로 실린다). 패닉은
/// [`ChannelHost::send`] 가 잡아서 무시한다(호출자를 죽이지 않는다).
pub type ChannelSender = Arc<dyn Fn(&str) + Send + Sync>;

include!("channels_host.rs");

include!("channels_handles.rs");

#[cfg(test)]
#[path = "channels_tests.rs"]
mod tests;

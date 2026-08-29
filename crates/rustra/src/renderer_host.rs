//! # RendererHost — renderer-neutral host 추상
//!
//! `RendererHost`는 Rustra core가 *어떤 renderer* 와 대화하는지 모르게 해주는
//! long-lived abstraction 이다 (design §5). 핵심 설계 원칙:
//!
//! - **webview-neutral** — core trait 에 `eval_script` 같은 webview 표현이 없다.
//!   JS/BTS eval 이 정말 필요하면 [`RendererCapabilities::evaluate_script`] 라는
//!   *optional* capability 로 노출된다. core 는 이 플래그만 본다.
//! - **deny-by-default** — [`RendererCapabilities::default()`] 는 모든 optional
//!   capability 를 `false` 로 둔다 (Runtime Authority 의 명령 deny-by-default 와
//!   같은 철학). 각 renderer 가 명시적으로 opt-in 해야 켜진다.
//! - **host-neutral** — surface 연산만 있다. Tauri/Wry/미래 renderer 모두
//!   동일 trait 의 구현체일 뿐이다.
//!
//! ## 현재 상태 (2026-08-20, Lynx 제거 직후)
//!
//! 이 trait 은 **공개 API로 유지된다** — 임베디드 renderer 를 포함하는 호스트
//! 통합 지점(예: 미래의 Tauri 렌더 호스트, 커스텀 네이티브 셸)이 구현할
//! 인터페이스다. 참고: 과거 Lynx 트랙의 구현체가 유일한 소비자였으나 Lynx
//! 지원 제거(PR #16)로 in-repo 구현체가 사라졌고, 현재 `#[cfg(test)]` 의
//! MockHost 가 유일한 구현이다. 새 renderer 표면을 추가할 때 이 trait 을
//! 구현해 prelude 로 재수출된 계약을 그대로 쓰면 된다.
//!
//! 구현체는 각 플랫폼 셸이 제공한다 — 예: 임베디드 renderer C++ host 가 C API 로
//! `create_surface → load → send_message → destroy` 를 수행하고, Rust wrapper 가
//! 같은 trait 을 채운다.

use std::fmt;

use crate::Result;
use crate::error::RustraError;

/// 픽셀 단위 2D 크기.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Size {
    pub width: u32,
    pub height: u32,
}

/// [`RendererHost::create_surface`] 에 전달되는 surface 생성 옵션.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SurfaceOptions {
    /// surface 의 초기 픽셀 크기.
    pub size: Size,
    /// 배경을 투명하게 렌더링할지 여부 (compositor 합성용).
    pub transparent: bool,
    /// 물리 픽셀 / 논리 픽셀 비율 (HiDPI). 1.0 = 일반.
    pub scale: f32,
}

impl Default for SurfaceOptions {
    fn default() -> Self {
        Self {
            size: Size {
                width: 800,
                height: 600,
            },
            transparent: false,
            scale: 1.0,
        }
    }
}

/// Renderer 가 선택적으로 제공하는 능력.
///
/// **deny-by-default:** [`Default`] 구현은 모든 필드를 `false` 로 둔다. webview 가
/// 아닌 present-only renderer (순수 RGBA blit) 는 아무것도 켜지 않은 채로 시작하며,
/// JS eval 이 가능한 renderer 만 `evaluate_script` 를 opt-in 한다.
/// core 는 이 플래그 집합으로만 renderer 의 성격을 판단한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RendererCapabilities {
    /// renderer 의 JS 런타임에 문자열을 eval 할 수 있는지.
    /// JS 런타임을 가진 renderer: `true`.
    /// present-only renderer: `false`.
    pub evaluate_script: bool,
    /// URL navigation 지원 여부 (기본 `false`; present-only renderer 는 navigate 하지 않는다).
    pub navigation: bool,
    /// 쿠키 저장소 접근 여부 (기본 `false`).
    pub cookies: bool,
    /// 브라우저 히스토리 조작 여부 (기본 `false`).
    pub browser_history: bool,
    /// 개발자 도구(inspector) 노출 여부 (기본 `false`).
    pub devtools: bool,
}

/// host → renderer 방향 메시지. invoke 응답 · event push · channel frame 이
/// 동일한 `send_message` 채널을 지난다 (design §5). payload 는 rkyv V2 wire bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostMessage {
    /// 명령 invoke 의 응답을 renderer 로 돌려보낸다.
    InvokeResponse { request_id: u64, payload: Vec<u8> },
    /// host 측에서 발생한 event 를 renderer 로 push 한다.
    Event { name: String, payload: Vec<u8> },
    /// stream channel 의 단일 프레임 (예: 주기적 tick).
    ChannelFrame { stream_id: u64, frame: Vec<u8> },
}

/// host → renderer 이벤트가 의미론적으로 분류되는 채널.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageKind {
    InvokeResponse,
    Event,
    ChannelFrame,
}

impl HostMessage {
    /// 메시지의 의미론적 종류를 반환한다.
    pub fn kind(&self) -> MessageKind {
        match self {
            Self::InvokeResponse { .. } => MessageKind::InvokeResponse,
            Self::Event { .. } => MessageKind::Event,
            Self::ChannelFrame { .. } => MessageKind::ChannelFrame,
        }
    }
}

/// renderer-neutral host 추상 (design §5).
///
/// 각 renderer 는 associated type 으로 자기만의 surface/bundle 타입을 가져온다.
/// 임베디드 renderer host — `Surface = 네이티브 뷰 핸들`, `Bundle = 바이트` (C API).
/// webview host — `Surface = ...`, `Bundle = WebUrl` (back-compat webview 경로).
///
/// core 는 이 trait 의 메서드 시그니처(=`surface 연산`)만 알며, webview 특정
/// 개념(`eval_script` 등)은 [`RendererCapabilities`] 의 optional 플래그로 만난다.
#[doc(hidden)]
#[deprecated(
    note = "RendererHost is retained for Rustra 0.x compatibility; prefer a host-specific adapter boundary"
)]
pub trait RendererHost: Send + 'static {
    /// renderer 가 다루는 surface 핸들 (예: 네이티브 뷰, NSView+layer, webview).
    type Surface;
    /// load 할 수 있는 bundle/자원 (예: 번들 바이트, URL).
    type Bundle;

    /// 주어진 옵션으로 새 surface 를 만든다.
    fn create_surface(&self, options: SurfaceOptions) -> Result<Self::Surface>;
    /// surface 에 bundle 을 load 한다 (렌더링 파이프라인을 시작).
    fn load(&self, surface: &Self::Surface, bundle: Self::Bundle) -> Result<()>;
    /// host → renderer 메시지를 보낸다 (invoke 응답 / event push / channel frame).
    fn send_message(&self, surface: &Self::Surface, message: HostMessage) -> Result<()>;
    /// surface 크기를 변경한다.
    fn resize(&self, surface: &Self::Surface, size: Size) -> Result<()>;
    /// surface 의 가시성을 설정한다.
    fn set_visibility(&self, surface: &Self::Surface, visible: bool) -> Result<()>;
    /// surface 를 파괴하고 자원을 해제한다. 소유권을 가져간다 (consume).
    fn destroy(&self, surface: Self::Surface) -> Result<()>;
    /// 이 renderer 가 지원하는 optional capability 집합을 반환한다.
    fn capabilities(&self) -> RendererCapabilities;
}

/// host 가 JS/BTS eval 기반 초기화/평가를 지원하는지 (capability gating helper).
///
/// `evaluate_script == false` 인 renderer (present-only) 에게는 eval 기반 경로를
/// 시도하지 않아야 한다. 이 함수가 그 결정을 한 곳에서 내린다.
pub fn host_supports_eval(host: &impl RendererHost) -> bool {
    host.capabilities().evaluate_script
}

impl fmt::Display for Size {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}x{}", self.width, self.height)
    }
}

impl fmt::Display for SurfaceOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} @{}", self.size, self.scale)
    }
}

impl fmt::Display for MessageKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvokeResponse => f.write_str("InvokeResponse"),
            Self::Event => f.write_str("Event"),
            Self::ChannelFrame => f.write_str("ChannelFrame"),
        }
    }
}

/// surface 가 이미 destroy 된 뒤의 연산을 시도했을 때의 에러.
///
/// 모든 `RendererHost` 구현체가 동일한 code(`renderer.surface_destroyed`)를 쓰도록
/// 하는 shared helper. 현재는 mock 테스트만 호출하지만, 모든 Rust-native host
/// 구현도 같은 에러를 낸다.
#[allow(dead_code)]
pub(crate) fn surface_destroyed(op: &str) -> RustraError {
    RustraError::custom(
        "renderer.surface_destroyed",
        format!("operation '{op}' on a destroyed surface"),
    )
}

#[cfg(test)]
#[path = "renderer_host_tests.rs"]
mod tests;

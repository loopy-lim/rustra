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

/// 채널/리소스 핸들의 호스트 측 단일 테이블.
///
/// 프로세스에 하나 존재한다([`global_host`]). RN JSI 호스트는 브릿지
/// 셋업 시 [`set_channel_sender`] 로 JS 콜백 배선을, Tauri 호스트는
/// `Channel` 객체의 send 클로저를 등록한다.
pub struct ChannelHost {
    // u32 wire handle의 다음 값을 u64에 보관한다. AtomicU32::fetch_add는
    // u32::MAX 이후 0으로 되감겨 invalid sentinel/stale handle을 재사용한다.
    // u64 카운터는 u32 공간 소진을 별도 상태로 표현해 0을 exhaustion sentinel로
    // 반환할 수 있다.
    next_handle: AtomicU64,
    channels: Mutex<BTreeMap<u32, ChannelSender>>,
    resources: Mutex<BTreeMap<u32, Arc<dyn std::any::Any + Send + Sync>>>,
}

impl Default for ChannelHost {
    fn default() -> Self {
        Self {
            next_handle: AtomicU64::new(1),
            channels: Mutex::new(BTreeMap::new()),
            resources: Mutex::new(BTreeMap::new()),
        }
    }
}

impl ChannelHost {
    /// 호스트가 새 채널을 발급한다 — 반환된 핸들을 커맨드 인자로 넘긴다.
    ///
    /// 핸들은 1부터 단조 증가한다(0 은 invalid sentinel).
    pub fn register_channel(&self, sender: ChannelSender) -> u32 {
        let handle = self.reserve_handle();
        if handle == 0 {
            return 0;
        }
        // 포이즈닝 관용 — 채널 테이블 자체는 구조적으로 유효하다(ffi.rs 와 동일).
        self.channels
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(handle, sender);
        handle
    }

    /// 핸들만 선점한다(번호 소비) — FFI 경로처럼 콜백이 자기 핸들을 캡처해야
    /// 하는 경우 [`register_channel`] 대신 reserve → insert 2단계로 쓴다.
    ///
    /// reserve 후 [`register_channel_with_handle`] 로 마저 등록한다. 등록 전
    /// send 는 테이블에 없으므로 `false`(stale 과 동일 취급).
    pub fn reserve_handle(&self) -> u32 {
        let raw = self.next_handle.fetch_add(1, Ordering::Relaxed);
        u32::try_from(raw).unwrap_or(0)
    }

    /// [`reserve_handle`] 으로 선점한 핸들에 sender 를 등록한다.
    pub fn register_channel_with_handle(&self, handle: u32, sender: ChannelSender) {
        if handle == 0 {
            return;
        }
        self.channels
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(handle, sender);
    }

    /// Rust→JS 로 채널에 데이터를 흘린다. 핸들이 없으면 `false`
    /// (stale/만료 — 호출자가 에러로 취급할지 무시할지 결정한다).
    ///
    /// 호스트 콜백 패닉은 잡아서 무시한다 — `emit` 의 싱크 패닉 격리와
    /// 동일 계약이지만 채널은 호출 귀속이라 "sink stays installed" 대신
    /// 그냥 이번 send 만 건너뛴다.
    pub fn send(&self, handle: u32, payload: &str) -> bool {
        let sender = {
            let channels = self.channels.lock().unwrap_or_else(|p| p.into_inner());
            channels.get(&handle).cloned()
        };
        let Some(sender) = sender else {
            return false;
        };
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sender(payload)));
        true
    }

    /// 채널을 해제한다(호출 완료/취소 시). 이후 동일 핸들 send 는 `false`.
    pub fn drop_channel(&self, handle: u32) -> bool {
        self.channels
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&handle)
            .is_some()
    }

    /// Rust-소유 리소스를 등록하고 핸들을 발급한다.
    pub fn register_resource(&self, resource: Arc<dyn std::any::Any + Send + Sync>) -> u32 {
        let handle = self.reserve_handle();
        if handle == 0 {
            return 0;
        }
        self.resources
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(handle, resource);
        handle
    }

    /// 리소스 핸들로 Rust-소유 객체를 가져온다.
    pub fn resource<T: Send + Sync + 'static>(&self, handle: u32) -> Option<Arc<T>> {
        let guard = self.resources.lock().unwrap_or_else(|p| p.into_inner());
        guard.get(&handle)?.clone().downcast::<T>().ok()
    }

    /// 리소스를 해제한다(Rust 소유권 — JS dispose 커맨드 또는 패키지 드롭).
    /// 해제된 객체의 `Drop` 이 이 시점에 실행된다.
    pub fn drop_resource(&self, handle: u32) -> bool {
        self.resources
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&handle)
            .is_some()
    }

    /// 활성 채널/리소스 수 (진단·테스트용).
    pub fn counts(&self) -> (usize, usize) {
        let channels = self
            .channels
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .len();
        let resources = self
            .resources
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .len();
        (channels, resources)
    }
}

fn global_host() -> &'static ChannelHost {
    static HOST: OnceLock<ChannelHost> = OnceLock::new();
    HOST.get_or_init(ChannelHost::default)
}

/// 전역 채널/리소스 테이블에 접근한다.
pub fn host() -> &'static ChannelHost {
    global_host()
}

/// 커맨드 인자로 받은 채널 핸들 — serde 표면은 plain `u32`다.
///
/// 코드젠은 이 타입을 인식하면 TS 를 `RustraChannel` 마커 타입으로
/// 발행한다(런타임 값은 여전히 number — wire 는 u32 varint).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
pub struct ChannelHandle(pub u32);

impl ChannelHandle {
    /// Rust→JS 로 JSON 페이로드를 흘린다. 핸들 만료(호출 종료 후)면 `false`.
    pub fn send(&self, payload: &str) -> bool {
        host().send(self.0, payload)
    }
}

/// 커맨드 반환값/필드로 받은 리소스 핸들 — serde 표면은 plain `u32`.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
pub struct ResourceHandle(pub u32);

impl ResourceHandle {
    /// 이 핸들이 가리키는 Rust-소유 객체를 가져온다.
    pub fn get<T: Send + Sync + 'static>(&self) -> Option<Arc<T>> {
        host().resource::<T>(self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn channel_roundtrip_and_drop() {
        let h = ChannelHost::default();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits2 = hits.clone();
        let handle = h.register_channel(Arc::new(move |_p| {
            hits2.fetch_add(1, Ordering::Relaxed);
        }));
        assert_eq!(handle, 1);
        assert!(h.send(handle, "{}"));
        assert_eq!(hits.load(Ordering::Relaxed), 1);
        assert!(h.drop_channel(handle));
        // 해제 후 send 는 도달하지 않는다(stale 무시).
        assert!(!h.send(handle, "{}"));
        assert_eq!(hits.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn channel_sender_panic_is_isolated() {
        let h = ChannelHost::default();
        let handle = h.register_channel(Arc::new(|_p| panic!("host callback boom")));
        // 패닉해도 send 는 true(도달함) 를 반환하고 전파되지 않는다.
        assert!(h.send(handle, "x"));
    }

    #[test]
    fn resource_lifecycle_and_type_isolation() {
        let h = ChannelHost::default();
        struct Conn {
            id: u32,
        }
        let handle = h.register_resource(Arc::new(Conn { id: 7 }));
        let conn = h.resource::<Conn>(handle).expect("registered");
        assert_eq!(conn.id, 7);
        // 타입 불일치 다운캐스트는 None — 리소스는 타입 안전하다.
        assert!(h.resource::<String>(handle).is_none());
        assert!(h.drop_resource(handle));
        assert!(h.resource::<Conn>(handle).is_none());
    }

    #[test]
    fn handles_never_reused() {
        let h = ChannelHost::default();
        let a = h.register_channel(Arc::new(|_| {}));
        assert!(h.drop_channel(a));
        let b = h.register_channel(Arc::new(|_| {}));
        assert_ne!(a, b, "핸들은 단조 증가 — 재사용 금지");
    }

    #[test]
    fn exhausted_handle_space_returns_zero_without_reusing_a_live_handle() {
        let h = ChannelHost {
            next_handle: AtomicU64::new(u64::from(u32::MAX)),
            channels: Mutex::new(BTreeMap::new()),
            resources: Mutex::new(BTreeMap::new()),
        };
        let last = h.register_channel(Arc::new(|_| {}));
        assert_eq!(last, u32::MAX);
        assert_eq!(h.register_channel(Arc::new(|_| {})), 0);
        assert_eq!(h.register_resource(Arc::new("not inserted")), 0);
        assert_eq!(h.counts(), (1, 0));
        assert!(h.send(last, "still live"));
    }

    #[test]
    fn serde_surface_is_plain_u32() {
        let ch = ChannelHandle(14);
        assert_eq!(serde_json::to_string(&ch).unwrap(), "14");
        let rh: ResourceHandle = serde_json::from_str("3").unwrap();
        assert_eq!(rh.0, 3);
    }
}

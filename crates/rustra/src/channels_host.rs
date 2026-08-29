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

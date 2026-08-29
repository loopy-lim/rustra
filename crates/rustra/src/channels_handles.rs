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

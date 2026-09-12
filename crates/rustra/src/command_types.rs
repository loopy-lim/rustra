pub(crate) struct Command {
    pub(crate) command_id: u16,
    pub(crate) description: Option<String>,
    pub(crate) input_type: String,
    pub(crate) output_type: String,
    pub(crate) input_schema: Arc<Value>,
    pub(crate) output_schema: Arc<Value>,
    pub(crate) definitions: Arc<Value>,
    pub(crate) invoke: Arc<dyn Fn(Value) -> crate::Result<Value> + Send + Sync>,
    /// Fast binary handler: payload[2..] → postcard deserialize → typed handler → postcard serialize
    pub(crate) frame_handler: Option<BinHandler>,
    /// caller-buffer fast handler: 작은 응답을 호스트 메모리에 직접 직렬화한다.
    pub(crate) frame_into_handler: Option<BinIntoHandler>,
    /// 스칼라 직결 raw 핸들러 — 인자/결과를 u64 슬롯으로 주고받는다.
    /// postcard 왕복이 없다(정의는 `build_command_raw` 참조).
    pub(crate) raw_handler: Option<RawHandler>,
    /// 단일 byte field 입출력 직결 핸들러. 입력은 호출 안에서 소유 Vec로
    /// 복사되고 출력 Vec는 FFI가 소유권을 넘겨받으므로 postcard frame이 없다.
    pub(crate) buffer_handler: Option<BufferHandler>,
    /// raw 직결의 입력 필드 종류 — 호스트가 같은 순서로 비트를 해석한다.
    pub(crate) raw_input_kinds: Vec<crate::frame_codec::RawFieldKind>,
    pub(crate) frame_decode: DecodeFn,
    pub(crate) frame_encode_response: EncodeFn,
    /// true when this command uses Tier 3 (JSON fallback) wire format.
    pub(crate) frame_tier3: bool,
    /// Runtime Authority: 이 명령이 요구하는 capability.
    /// `Some(cap)` 면 `cap` 이 `grant_capability` 로 부여되기 전까지 deny-by-default.
    /// `None` 이면 항상 허용 (기본 명령).
    pub(crate) required_capability: Option<&'static str>,
    /// 플랫폼 특화 명령의 지원 플랫폼 — 빈 벡터는 "전 플랫폼" (기본 명령).
    /// [`crate::PackageBuilder::platform_command`] 참고. command_id·스키마는
    /// 전 플랫폼에서 동일하게 등록되고, 미지원 플랫폼의 핸들러는
    /// `platform.unavailable` 스텁이다.
    pub(crate) platforms: Vec<crate::platform::Platform>,
    /// 이 명령이 반환할 수 있는 도메인 에러 코드 선언 — 빈 벡터는 "선언 없음".
    /// schema.json `errors` 필드와 TS 코드젠(타입 가드)의 원천이며 런타임
    /// 와이어는 무변경이다. 선언 경로는 `command_errors` 참고.
    pub(crate) error_variants: Vec<CommandErrorVariant>,
    /// 이 명령이 전제하는 디바이스 역량 선언 — 빈 벡터는 "선언 없음".
    /// schema.json `devices` 필드의 원천이며 런타임 자동 게이팅은 없다(선언은
    /// 계약 문서). 선언 경로는 `command_devices` 참고.
    pub(crate) device_requirements: Vec<crate::device_capabilities::DeviceCapability>,
}

pub(crate) type BufferHandler = Arc<dyn Fn(&[u8]) -> crate::Result<Vec<u8>> + Send + Sync>;

impl std::fmt::Debug for Command {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Command")
            .field("command_id", &self.command_id)
            .field("input_type", &self.input_type)
            .field("output_type", &self.output_type)
            .finish()
    }
}

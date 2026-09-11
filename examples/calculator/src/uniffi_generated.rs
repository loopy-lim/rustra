// 이 파일은 rustra 코드젠(uniffi_render)이 생성한 UniFFI 미러 계층이다.
// 손으로 수정하지 마세요 — 재생성: RUSTRA_UNIFFI_OUT=src cargo run -p \
//   rustra-calculator-example --bin generate
// 원천: generate_typescript() 의 schema_json — 커맨드/정의 선언 순서가
// 곧 미러 필드 순서다(postcard 와이어와 동일 원천).

pub mod uniffi_api {
    // ── 에러 미러 — rustra RustraError 의 3-필드 실패 모델 ──
    // 필드명 주의: `message` 는 Kotlin 생성 바인딩에서 Throwable.message
    // 오버라이드와 충돌한다(주 생성자 프로퍼티 + body get() 이중 선언) —
    // uniffi 0.32.1 Kotlin 생성기의 알려진 날카로운 모서리. `detail` 로 회피.
    #[derive(Debug, uniffi::Error)]
    pub enum RustraCommandFailure {
        Failure {
            code: String,
            detail: String,
            retryable: bool,
        },
    }

    impl std::fmt::Display for RustraCommandFailure {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                RustraCommandFailure::Failure { code, detail, .. } => {
                    write!(f, "{code}: {detail}")
                }
            }
        }
    }

    impl From<rustra::RustraError> for RustraCommandFailure {
        fn from(error: rustra::RustraError) -> Self {
            Self::Failure {
                code: error.code().to_string(),
                detail: error.message().to_string(),
                retryable: error.is_retryable(),
            }
        }
    }

    // ── 미러 타입 — 정의/커맨드 입출력 순서(스키마 최초 등장 순) ──
    /// `AddNumbersInput` 미러 — 실제 타입 `crate::AddNumbersInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct AddNumbersInput {
        pub a: i64,
        pub b: i64,
    }

    /// `AddNumbersOutput` 미러 — 실제 타입 `crate::AddNumbersOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct AddNumbersOutput {
        pub value: i64,
    }

    /// `BenchAddInput` 미러 — 실제 타입 `crate::BenchAddInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct BenchAddInput {
        pub a: f64,
        pub b: f64,
    }

    /// `BenchAddOutput` 미러 — 실제 타입 `crate::BenchAddOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct BenchAddOutput {
        pub value: f64,
    }

    /// `BenchBytesPayload` 미러 — 실제 타입 `crate::BenchBytesPayload`.
    #[derive(Debug, uniffi::Record)]
    pub struct BenchBytesPayload {
        pub data: Vec<u8>,
    }

    /// `BenchPairPayload` 미러 — 실제 타입 `crate::BenchPairPayload`.
    #[derive(Debug, uniffi::Record)]
    pub struct BenchPairPayload {
        pub name: String,
        pub value: f64,
    }

    /// `BenchStringPayload` 미러 — 실제 타입 `crate::BenchStringPayload`.
    #[derive(Debug, uniffi::Record)]
    pub struct BenchStringPayload {
        pub value: String,
    }

    /// `ChannelDemoInput` 미러 — 실제 타입 `crate::ChannelDemoInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct ChannelDemoInput {
        pub channel: u32,
        pub ticks: i32,
    }

    /// `ChannelDemoOutput` 미러 — 실제 타입 `crate::ChannelDemoOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct ChannelDemoOutput {
        pub sent: i32,
        pub dropped_sends: i32,
    }

    /// `ChannelDemoBytesInput` 미러 — 실제 타입 `crate::ChannelDemoBytesInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct ChannelDemoBytesInput {
        pub channel: u32,
        pub ticks: i32,
    }

    /// `ChannelDemoBytesOutput` 미러 — 실제 타입 `crate::ChannelDemoBytesOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct ChannelDemoBytesOutput {
        pub sent: u32,
        pub dropped_sends: u32,
    }

    /// `ClampInput` 미러 — 실제 타입 `crate::ClampInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct ClampInput {
        pub max: f64,
        pub min: f64,
        pub value: f64,
    }

    /// `ClampOutput` 미러 — 실제 타입 `crate::ClampOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct ClampOutput {
        pub value: f64,
    }

    /// `CreateItemInput` 미러 — 실제 타입 `crate::CreateItemInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct CreateItemInput {
        pub name: String,
        pub value: i64,
    }

    /// `CreateItemOutput` 미러 — 실제 타입 `crate::CreateItemOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct CreateItemOutput {
        pub item: Item,
    }

    /// `Item` 미러 — 실제 타입 `crate::Item`.
    #[derive(Debug, uniffi::Record)]
    pub struct Item {
        pub active: bool,
        pub name: String,
        pub value: i64,
    }

    /// `DeviceDemoOutput` 미러 — 실제 타입 `crate::DeviceDemoOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct DeviceDemoOutput {
        pub os: String,
    }

    /// `DivideInput` 미러 — 실제 타입 `crate::DivideInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct DivideInput {
        pub a: i64,
        pub b: i64,
    }

    /// `DivideOutput` 미러 — 실제 타입 `crate::DivideOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct DivideOutput {
        pub value: i64,
    }

    /// `EchoGroupsInput` 미러 — 실제 타입 `crate::EchoGroupsInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct EchoGroupsInput {
        pub groups: std::collections::HashMap<String, Vec<String>>,
    }

    /// `EchoGroupsOutput` 미러 — 실제 타입 `crate::EchoGroupsOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct EchoGroupsOutput {
        pub groups: std::collections::HashMap<String, Vec<String>>,
    }

    /// `EmitDemoInput` 미러 — 실제 타입 `crate::EmitDemoInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct EmitDemoInput {
        pub ticks: i64,
        pub step_delay_ms: i64,
    }

    /// `EmitDemoOutput` 미러 — 실제 타입 `crate::EmitDemoOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct EmitDemoOutput {
        pub emitted: i64,
    }

    /// `GaugeInput` 미러 — 실제 타입 `crate::GaugeInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct GaugeInput {
        pub limit: u64,
        pub offset: u32,
    }

    /// `GaugeOutput` 미러 — 실제 타입 `crate::GaugeOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct GaugeOutput {
        pub next: u64,
    }

    /// `GreetInput` 미러 — 실제 타입 `crate::GreetInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct GreetInput {
        pub name: String,
    }

    /// `GreetOutput` 미러 — 실제 타입 `crate::GreetOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct GreetOutput {
        pub message: String,
    }

    /// `IsEvenInput` 미러 — 실제 타입 `crate::IsEvenInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct IsEvenInput {
        pub n: i64,
    }

    /// `IsEvenOutput` 미러 — 실제 타입 `crate::IsEvenOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct IsEvenOutput {
        pub result: bool,
    }

    /// `KindEchoInput` 미러 — 실제 타입 `crate::KindEchoInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct KindEchoInput {
        pub kind: OpKind,
    }

    /// `OpKind` 미러 — 실제 타입 `crate::OpKind`(외부 태그 oneOf 스키마).
    #[derive(Debug, uniffi::Enum)]
    pub enum OpKind {
        Clear,
        Set {
            value: i64,
        },
    }

    /// `KindEchoOutput` 미러 — 실제 타입 `crate::KindEchoOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct KindEchoOutput {
        pub echoed: OpKind,
    }

    /// `MultiplyInput` 미러 — 실제 타입 `crate::MultiplyInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct MultiplyInput {
        pub a: f64,
        pub b: f64,
    }

    /// `MultiplyOutput` 미러 — 실제 타입 `crate::MultiplyOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct MultiplyOutput {
        pub value: f64,
    }

    /// `PlatformNativeInfoOutput` 미러 — 실제 타입 `crate::PlatformNativeInfoOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct PlatformNativeInfoOutput {
        pub os: String,
        pub window_kind: String,
    }

    /// `ProcessItemInput` 미러 — 실제 타입 `crate::ProcessItemInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct ProcessItemInput {
        pub item: Item,
    }

    /// `ProcessItemOutput` 미러 — 실제 타입 `crate::ProcessItemOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct ProcessItemOutput {
        pub doubled: bool,
        pub item: Item,
    }

    /// `ResourceCloseInput` 미러 — 실제 타입 `crate::ResourceCloseInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct ResourceCloseInput {
        pub handle: u32,
    }

    /// `ResourceCloseOutput` 미러 — 실제 타입 `crate::ResourceCloseOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct ResourceCloseOutput {
        pub closed: bool,
    }

    /// `ResourceOpenInput` 미러 — 실제 타입 `crate::ResourceOpenInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct ResourceOpenInput {
        pub initial: std::collections::HashMap<String, String>,
    }

    /// `ResourceHandleOutput` 미러 — 실제 타입 `crate::ResourceHandleOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct ResourceHandleOutput {
        pub handle: u32,
    }

    /// `ResourceReadInput` 미러 — 실제 타입 `crate::ResourceReadInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct ResourceReadInput {
        pub handle: u32,
        pub key: String,
    }

    /// `ResourceReadOutput` 미러 — 실제 타입 `crate::ResourceReadOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct ResourceReadOutput {
        pub found: bool,
        pub value: Option<String>,
    }

    /// `ResourceWriteInput` 미러 — 실제 타입 `crate::ResourceWriteInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct ResourceWriteInput {
        pub handle: u32,
        pub key: String,
        pub value: String,
    }

    /// `ResourceWriteOutput` 미러 — 실제 타입 `crate::ResourceWriteOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct ResourceWriteOutput {
        pub entries: u64,
    }

    /// `RegistryDemoInput` 미러 — 실제 타입 `crate::RegistryDemoInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct RegistryDemoInput {
        pub op: String,
    }

    /// `RegistryDemoOutput` 미러 — 실제 타입 `crate::RegistryDemoOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct RegistryDemoOutput {
        pub ok: bool,
        pub frozen: bool,
        pub message: String,
    }

    /// `ScoreTotalInput` 미러 — 실제 타입 `crate::ScoreTotalInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct ScoreTotalInput {
        pub scores: std::collections::HashMap<String, i64>,
    }

    /// `ScoreTotalOutput` 미러 — 실제 타입 `crate::ScoreTotalOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct ScoreTotalOutput {
        pub count: u32,
        pub total: i64,
    }

    /// `SecureComputeInput` 미러 — 실제 타입 `crate::SecureComputeInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct SecureComputeInput {
        pub a: i64,
        pub b: i64,
    }

    /// `SecureComputeOutput` 미러 — 실제 타입 `crate::SecureComputeOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct SecureComputeOutput {
        pub value: i64,
    }

    /// `SizeOfInput` 미러 — 실제 타입 `crate::SizeOfInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct SizeOfInput {
        pub data: Vec<u8>,
    }

    /// `SizeOfOutput` 미러 — 실제 타입 `crate::SizeOfOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct SizeOfOutput {
        pub checksum: u32,
        pub len: u32,
    }

    /// `SpanInput` 미러 — 실제 타입 `crate::SpanInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct SpanInput {
        pub pair: SpanInputPair,
    }

    /// `SpanInputPair` 미러 — 실제 타입 `(String, i64)`.
    #[derive(Debug, uniffi::Record)]
    pub struct SpanInputPair {
        pub v0: String,
        pub v1: i64,
    }

    /// `SpanOutput` 미러 — 실제 타입 `crate::SpanOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct SpanOutput {
        pub first: String,
        pub second: i64,
    }

    /// `SumListInput` 미러 — 실제 타입 `crate::SumListInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct SumListInput {
        pub numbers: Vec<i64>,
    }

    /// `SumListOutput` 미러 — 실제 타입 `crate::SumListOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct SumListOutput {
        pub count: i32,
        pub total: i64,
    }

    /// `TagSetInput` 미러 — 실제 타입 `crate::TagSetInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct TagSetInput {
        pub ids: Vec<i64>,
    }

    /// `TagSetOutput` 미러 — 실제 타입 `crate::TagSetOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct TagSetOutput {
        pub tags: Vec<String>,
    }

    /// `ToUpperInput` 미러 — 실제 타입 `crate::ToUpperInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct ToUpperInput {
        pub s: String,
    }

    /// `ToUpperOutput` 미러 — 실제 타입 `crate::ToUpperOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct ToUpperOutput {
        pub result: String,
    }

    /// `WideAggInput` 미러 — 실제 타입 `crate::WideAggInput`.
    #[derive(Debug, uniffi::Record)]
    pub struct WideAggInput {
        pub samples: Vec<u64>,
        pub offset: Option<i64>,
    }

    /// `WideAggOutput` 미러 — 실제 타입 `crate::WideAggOutput`.
    #[derive(Debug, uniffi::Record)]
    pub struct WideAggOutput {
        pub max: u64,
        pub adjusted: i64,
    }

    // ── 미러 ↔ 실제 양방향 변환 ──
    impl From<AddNumbersInput> for crate::AddNumbersInput {
        fn from(input: AddNumbersInput) -> Self {
            Self {
                a: input.a,
                b: input.b,
            }
        }
    }

    impl From<crate::AddNumbersInput> for AddNumbersInput {
        fn from(input: crate::AddNumbersInput) -> Self {
            Self {
                a: input.a,
                b: input.b,
            }
        }
    }

    impl From<AddNumbersOutput> for crate::AddNumbersOutput {
        fn from(input: AddNumbersOutput) -> Self {
            Self {
                value: input.value,
            }
        }
    }

    impl From<crate::AddNumbersOutput> for AddNumbersOutput {
        fn from(input: crate::AddNumbersOutput) -> Self {
            Self {
                value: input.value,
            }
        }
    }

    impl From<BenchAddInput> for crate::BenchAddInput {
        fn from(input: BenchAddInput) -> Self {
            Self {
                a: input.a,
                b: input.b,
            }
        }
    }

    impl From<crate::BenchAddInput> for BenchAddInput {
        fn from(input: crate::BenchAddInput) -> Self {
            Self {
                a: input.a,
                b: input.b,
            }
        }
    }

    impl From<BenchAddOutput> for crate::BenchAddOutput {
        fn from(input: BenchAddOutput) -> Self {
            Self {
                value: input.value,
            }
        }
    }

    impl From<crate::BenchAddOutput> for BenchAddOutput {
        fn from(input: crate::BenchAddOutput) -> Self {
            Self {
                value: input.value,
            }
        }
    }

    impl From<BenchBytesPayload> for crate::BenchBytesPayload {
        fn from(input: BenchBytesPayload) -> Self {
            Self {
                data: input.data,
            }
        }
    }

    impl From<crate::BenchBytesPayload> for BenchBytesPayload {
        fn from(input: crate::BenchBytesPayload) -> Self {
            Self {
                data: input.data,
            }
        }
    }

    impl From<BenchPairPayload> for crate::BenchPairPayload {
        fn from(input: BenchPairPayload) -> Self {
            Self {
                name: input.name,
                value: input.value,
            }
        }
    }

    impl From<crate::BenchPairPayload> for BenchPairPayload {
        fn from(input: crate::BenchPairPayload) -> Self {
            Self {
                name: input.name,
                value: input.value,
            }
        }
    }

    impl From<BenchStringPayload> for crate::BenchStringPayload {
        fn from(input: BenchStringPayload) -> Self {
            Self {
                value: input.value,
            }
        }
    }

    impl From<crate::BenchStringPayload> for BenchStringPayload {
        fn from(input: crate::BenchStringPayload) -> Self {
            Self {
                value: input.value,
            }
        }
    }

    impl From<ChannelDemoInput> for crate::ChannelDemoInput {
        fn from(input: ChannelDemoInput) -> Self {
            Self {
                channel: rustra::channels::ChannelHandle(input.channel),
                ticks: input.ticks,
            }
        }
    }

    impl From<crate::ChannelDemoInput> for ChannelDemoInput {
        fn from(input: crate::ChannelDemoInput) -> Self {
            Self {
                channel: input.channel.0,
                ticks: input.ticks,
            }
        }
    }

    impl From<ChannelDemoOutput> for crate::ChannelDemoOutput {
        fn from(input: ChannelDemoOutput) -> Self {
            Self {
                sent: input.sent,
                dropped_sends: input.dropped_sends,
            }
        }
    }

    impl From<crate::ChannelDemoOutput> for ChannelDemoOutput {
        fn from(input: crate::ChannelDemoOutput) -> Self {
            Self {
                sent: input.sent,
                dropped_sends: input.dropped_sends,
            }
        }
    }

    impl From<ChannelDemoBytesInput> for crate::ChannelDemoBytesInput {
        fn from(input: ChannelDemoBytesInput) -> Self {
            Self {
                channel: rustra::channels::ChannelHandle(input.channel),
                ticks: input.ticks,
            }
        }
    }

    impl From<crate::ChannelDemoBytesInput> for ChannelDemoBytesInput {
        fn from(input: crate::ChannelDemoBytesInput) -> Self {
            Self {
                channel: input.channel.0,
                ticks: input.ticks,
            }
        }
    }

    impl From<ChannelDemoBytesOutput> for crate::ChannelDemoBytesOutput {
        fn from(input: ChannelDemoBytesOutput) -> Self {
            Self {
                sent: input.sent,
                dropped_sends: input.dropped_sends,
            }
        }
    }

    impl From<crate::ChannelDemoBytesOutput> for ChannelDemoBytesOutput {
        fn from(input: crate::ChannelDemoBytesOutput) -> Self {
            Self {
                sent: input.sent,
                dropped_sends: input.dropped_sends,
            }
        }
    }

    impl From<ClampInput> for crate::ClampInput {
        fn from(input: ClampInput) -> Self {
            Self {
                max: input.max,
                min: input.min,
                value: input.value,
            }
        }
    }

    impl From<crate::ClampInput> for ClampInput {
        fn from(input: crate::ClampInput) -> Self {
            Self {
                max: input.max,
                min: input.min,
                value: input.value,
            }
        }
    }

    impl From<ClampOutput> for crate::ClampOutput {
        fn from(input: ClampOutput) -> Self {
            Self {
                value: input.value,
            }
        }
    }

    impl From<crate::ClampOutput> for ClampOutput {
        fn from(input: crate::ClampOutput) -> Self {
            Self {
                value: input.value,
            }
        }
    }

    impl From<CreateItemInput> for crate::CreateItemInput {
        fn from(input: CreateItemInput) -> Self {
            Self {
                name: input.name,
                value: input.value,
            }
        }
    }

    impl From<crate::CreateItemInput> for CreateItemInput {
        fn from(input: crate::CreateItemInput) -> Self {
            Self {
                name: input.name,
                value: input.value,
            }
        }
    }

    impl From<CreateItemOutput> for crate::CreateItemOutput {
        fn from(input: CreateItemOutput) -> Self {
            Self {
                item: input.item.into(),
            }
        }
    }

    impl From<crate::CreateItemOutput> for CreateItemOutput {
        fn from(input: crate::CreateItemOutput) -> Self {
            Self {
                item: input.item.into(),
            }
        }
    }

    impl From<Item> for crate::Item {
        fn from(input: Item) -> Self {
            Self {
                active: input.active,
                name: input.name,
                value: input.value,
            }
        }
    }

    impl From<crate::Item> for Item {
        fn from(input: crate::Item) -> Self {
            Self {
                active: input.active,
                name: input.name,
                value: input.value,
            }
        }
    }

    impl From<DeviceDemoOutput> for crate::DeviceDemoOutput {
        fn from(input: DeviceDemoOutput) -> Self {
            Self {
                os: input.os,
            }
        }
    }

    impl From<crate::DeviceDemoOutput> for DeviceDemoOutput {
        fn from(input: crate::DeviceDemoOutput) -> Self {
            Self {
                os: input.os,
            }
        }
    }

    impl From<DivideInput> for crate::DivideInput {
        fn from(input: DivideInput) -> Self {
            Self {
                a: input.a,
                b: input.b,
            }
        }
    }

    impl From<crate::DivideInput> for DivideInput {
        fn from(input: crate::DivideInput) -> Self {
            Self {
                a: input.a,
                b: input.b,
            }
        }
    }

    impl From<DivideOutput> for crate::DivideOutput {
        fn from(input: DivideOutput) -> Self {
            Self {
                value: input.value,
            }
        }
    }

    impl From<crate::DivideOutput> for DivideOutput {
        fn from(input: crate::DivideOutput) -> Self {
            Self {
                value: input.value,
            }
        }
    }

    impl From<EchoGroupsInput> for crate::EchoGroupsInput {
        fn from(input: EchoGroupsInput) -> Self {
            Self {
                groups: input.groups.into_iter().collect(),
            }
        }
    }

    impl From<crate::EchoGroupsInput> for EchoGroupsInput {
        fn from(input: crate::EchoGroupsInput) -> Self {
            Self {
                groups: input.groups.into_iter().collect(),
            }
        }
    }

    impl From<EchoGroupsOutput> for crate::EchoGroupsOutput {
        fn from(input: EchoGroupsOutput) -> Self {
            Self {
                groups: input.groups.into_iter().collect(),
            }
        }
    }

    impl From<crate::EchoGroupsOutput> for EchoGroupsOutput {
        fn from(input: crate::EchoGroupsOutput) -> Self {
            Self {
                groups: input.groups.into_iter().collect(),
            }
        }
    }

    impl From<EmitDemoInput> for crate::EmitDemoInput {
        fn from(input: EmitDemoInput) -> Self {
            Self {
                ticks: input.ticks,
                step_delay_ms: input.step_delay_ms,
            }
        }
    }

    impl From<crate::EmitDemoInput> for EmitDemoInput {
        fn from(input: crate::EmitDemoInput) -> Self {
            Self {
                ticks: input.ticks,
                step_delay_ms: input.step_delay_ms,
            }
        }
    }

    impl From<EmitDemoOutput> for crate::EmitDemoOutput {
        fn from(input: EmitDemoOutput) -> Self {
            Self {
                emitted: input.emitted,
            }
        }
    }

    impl From<crate::EmitDemoOutput> for EmitDemoOutput {
        fn from(input: crate::EmitDemoOutput) -> Self {
            Self {
                emitted: input.emitted,
            }
        }
    }

    impl From<GaugeInput> for crate::GaugeInput {
        fn from(input: GaugeInput) -> Self {
            Self {
                limit: input.limit,
                offset: input.offset,
            }
        }
    }

    impl From<crate::GaugeInput> for GaugeInput {
        fn from(input: crate::GaugeInput) -> Self {
            Self {
                limit: input.limit,
                offset: input.offset,
            }
        }
    }

    impl From<GaugeOutput> for crate::GaugeOutput {
        fn from(input: GaugeOutput) -> Self {
            Self {
                next: input.next,
            }
        }
    }

    impl From<crate::GaugeOutput> for GaugeOutput {
        fn from(input: crate::GaugeOutput) -> Self {
            Self {
                next: input.next,
            }
        }
    }

    impl From<GreetInput> for crate::GreetInput {
        fn from(input: GreetInput) -> Self {
            Self {
                name: input.name,
            }
        }
    }

    impl From<crate::GreetInput> for GreetInput {
        fn from(input: crate::GreetInput) -> Self {
            Self {
                name: input.name,
            }
        }
    }

    impl From<GreetOutput> for crate::GreetOutput {
        fn from(input: GreetOutput) -> Self {
            Self {
                message: input.message,
            }
        }
    }

    impl From<crate::GreetOutput> for GreetOutput {
        fn from(input: crate::GreetOutput) -> Self {
            Self {
                message: input.message,
            }
        }
    }

    impl From<IsEvenInput> for crate::IsEvenInput {
        fn from(input: IsEvenInput) -> Self {
            Self {
                n: input.n,
            }
        }
    }

    impl From<crate::IsEvenInput> for IsEvenInput {
        fn from(input: crate::IsEvenInput) -> Self {
            Self {
                n: input.n,
            }
        }
    }

    impl From<IsEvenOutput> for crate::IsEvenOutput {
        fn from(input: IsEvenOutput) -> Self {
            Self {
                result: input.result,
            }
        }
    }

    impl From<crate::IsEvenOutput> for IsEvenOutput {
        fn from(input: crate::IsEvenOutput) -> Self {
            Self {
                result: input.result,
            }
        }
    }

    impl From<KindEchoInput> for crate::KindEchoInput {
        fn from(input: KindEchoInput) -> Self {
            Self {
                kind: input.kind.into(),
            }
        }
    }

    impl From<crate::KindEchoInput> for KindEchoInput {
        fn from(input: crate::KindEchoInput) -> Self {
            Self {
                kind: input.kind.into(),
            }
        }
    }

    impl From<OpKind> for crate::OpKind {
        fn from(input: OpKind) -> Self {
            match input {
                OpKind::Clear => crate::OpKind::Clear,
                OpKind::Set { value } => crate::OpKind::Set { value },
            }
        }
    }

    impl From<crate::OpKind> for OpKind {
        fn from(input: crate::OpKind) -> Self {
            match input {
                crate::OpKind::Clear => OpKind::Clear,
                crate::OpKind::Set { value } => OpKind::Set { value },
            }
        }
    }

    impl From<KindEchoOutput> for crate::KindEchoOutput {
        fn from(input: KindEchoOutput) -> Self {
            Self {
                echoed: input.echoed.into(),
            }
        }
    }

    impl From<crate::KindEchoOutput> for KindEchoOutput {
        fn from(input: crate::KindEchoOutput) -> Self {
            Self {
                echoed: input.echoed.into(),
            }
        }
    }

    impl From<MultiplyInput> for crate::MultiplyInput {
        fn from(input: MultiplyInput) -> Self {
            Self {
                a: input.a,
                b: input.b,
            }
        }
    }

    impl From<crate::MultiplyInput> for MultiplyInput {
        fn from(input: crate::MultiplyInput) -> Self {
            Self {
                a: input.a,
                b: input.b,
            }
        }
    }

    impl From<MultiplyOutput> for crate::MultiplyOutput {
        fn from(input: MultiplyOutput) -> Self {
            Self {
                value: input.value,
            }
        }
    }

    impl From<crate::MultiplyOutput> for MultiplyOutput {
        fn from(input: crate::MultiplyOutput) -> Self {
            Self {
                value: input.value,
            }
        }
    }

    impl From<PlatformNativeInfoOutput> for crate::PlatformNativeInfoOutput {
        fn from(input: PlatformNativeInfoOutput) -> Self {
            Self {
                os: input.os,
                window_kind: input.window_kind,
            }
        }
    }

    impl From<crate::PlatformNativeInfoOutput> for PlatformNativeInfoOutput {
        fn from(input: crate::PlatformNativeInfoOutput) -> Self {
            Self {
                os: input.os,
                window_kind: input.window_kind,
            }
        }
    }

    impl From<ProcessItemInput> for crate::ProcessItemInput {
        fn from(input: ProcessItemInput) -> Self {
            Self {
                item: input.item.into(),
            }
        }
    }

    impl From<crate::ProcessItemInput> for ProcessItemInput {
        fn from(input: crate::ProcessItemInput) -> Self {
            Self {
                item: input.item.into(),
            }
        }
    }

    impl From<ProcessItemOutput> for crate::ProcessItemOutput {
        fn from(input: ProcessItemOutput) -> Self {
            Self {
                doubled: input.doubled,
                item: input.item.into(),
            }
        }
    }

    impl From<crate::ProcessItemOutput> for ProcessItemOutput {
        fn from(input: crate::ProcessItemOutput) -> Self {
            Self {
                doubled: input.doubled,
                item: input.item.into(),
            }
        }
    }

    impl From<ResourceCloseInput> for crate::ResourceCloseInput {
        fn from(input: ResourceCloseInput) -> Self {
            Self {
                handle: rustra::channels::ResourceHandle(input.handle),
            }
        }
    }

    impl From<crate::ResourceCloseInput> for ResourceCloseInput {
        fn from(input: crate::ResourceCloseInput) -> Self {
            Self {
                handle: input.handle.0,
            }
        }
    }

    impl From<ResourceCloseOutput> for crate::ResourceCloseOutput {
        fn from(input: ResourceCloseOutput) -> Self {
            Self {
                closed: input.closed,
            }
        }
    }

    impl From<crate::ResourceCloseOutput> for ResourceCloseOutput {
        fn from(input: crate::ResourceCloseOutput) -> Self {
            Self {
                closed: input.closed,
            }
        }
    }

    impl From<ResourceOpenInput> for crate::ResourceOpenInput {
        fn from(input: ResourceOpenInput) -> Self {
            Self {
                initial: input.initial.into_iter().collect(),
            }
        }
    }

    impl From<crate::ResourceOpenInput> for ResourceOpenInput {
        fn from(input: crate::ResourceOpenInput) -> Self {
            Self {
                initial: input.initial.into_iter().collect(),
            }
        }
    }

    impl From<ResourceHandleOutput> for crate::ResourceHandleOutput {
        fn from(input: ResourceHandleOutput) -> Self {
            Self {
                handle: rustra::channels::ResourceHandle(input.handle),
            }
        }
    }

    impl From<crate::ResourceHandleOutput> for ResourceHandleOutput {
        fn from(input: crate::ResourceHandleOutput) -> Self {
            Self {
                handle: input.handle.0,
            }
        }
    }

    impl From<ResourceReadInput> for crate::ResourceReadInput {
        fn from(input: ResourceReadInput) -> Self {
            Self {
                handle: rustra::channels::ResourceHandle(input.handle),
                key: input.key,
            }
        }
    }

    impl From<crate::ResourceReadInput> for ResourceReadInput {
        fn from(input: crate::ResourceReadInput) -> Self {
            Self {
                handle: input.handle.0,
                key: input.key,
            }
        }
    }

    impl From<ResourceReadOutput> for crate::ResourceReadOutput {
        fn from(input: ResourceReadOutput) -> Self {
            Self {
                found: input.found,
                value: input.value,
            }
        }
    }

    impl From<crate::ResourceReadOutput> for ResourceReadOutput {
        fn from(input: crate::ResourceReadOutput) -> Self {
            Self {
                found: input.found,
                value: input.value,
            }
        }
    }

    impl From<ResourceWriteInput> for crate::ResourceWriteInput {
        fn from(input: ResourceWriteInput) -> Self {
            Self {
                handle: rustra::channels::ResourceHandle(input.handle),
                key: input.key,
                value: input.value,
            }
        }
    }

    impl From<crate::ResourceWriteInput> for ResourceWriteInput {
        fn from(input: crate::ResourceWriteInput) -> Self {
            Self {
                handle: input.handle.0,
                key: input.key,
                value: input.value,
            }
        }
    }

    impl From<ResourceWriteOutput> for crate::ResourceWriteOutput {
        fn from(input: ResourceWriteOutput) -> Self {
            Self {
                entries: input.entries as usize,
            }
        }
    }

    impl From<crate::ResourceWriteOutput> for ResourceWriteOutput {
        fn from(input: crate::ResourceWriteOutput) -> Self {
            Self {
                entries: input.entries as u64,
            }
        }
    }

    impl From<RegistryDemoInput> for crate::RegistryDemoInput {
        fn from(input: RegistryDemoInput) -> Self {
            Self {
                op: input.op,
            }
        }
    }

    impl From<crate::RegistryDemoInput> for RegistryDemoInput {
        fn from(input: crate::RegistryDemoInput) -> Self {
            Self {
                op: input.op,
            }
        }
    }

    impl From<RegistryDemoOutput> for crate::RegistryDemoOutput {
        fn from(input: RegistryDemoOutput) -> Self {
            Self {
                ok: input.ok,
                frozen: input.frozen,
                message: input.message,
            }
        }
    }

    impl From<crate::RegistryDemoOutput> for RegistryDemoOutput {
        fn from(input: crate::RegistryDemoOutput) -> Self {
            Self {
                ok: input.ok,
                frozen: input.frozen,
                message: input.message,
            }
        }
    }

    impl From<ScoreTotalInput> for crate::ScoreTotalInput {
        fn from(input: ScoreTotalInput) -> Self {
            Self {
                scores: input.scores.into_iter().collect(),
            }
        }
    }

    impl From<crate::ScoreTotalInput> for ScoreTotalInput {
        fn from(input: crate::ScoreTotalInput) -> Self {
            Self {
                scores: input.scores.into_iter().collect(),
            }
        }
    }

    impl From<ScoreTotalOutput> for crate::ScoreTotalOutput {
        fn from(input: ScoreTotalOutput) -> Self {
            Self {
                count: input.count,
                total: input.total,
            }
        }
    }

    impl From<crate::ScoreTotalOutput> for ScoreTotalOutput {
        fn from(input: crate::ScoreTotalOutput) -> Self {
            Self {
                count: input.count,
                total: input.total,
            }
        }
    }

    impl From<SecureComputeInput> for crate::SecureComputeInput {
        fn from(input: SecureComputeInput) -> Self {
            Self {
                a: input.a,
                b: input.b,
            }
        }
    }

    impl From<crate::SecureComputeInput> for SecureComputeInput {
        fn from(input: crate::SecureComputeInput) -> Self {
            Self {
                a: input.a,
                b: input.b,
            }
        }
    }

    impl From<SecureComputeOutput> for crate::SecureComputeOutput {
        fn from(input: SecureComputeOutput) -> Self {
            Self {
                value: input.value,
            }
        }
    }

    impl From<crate::SecureComputeOutput> for SecureComputeOutput {
        fn from(input: crate::SecureComputeOutput) -> Self {
            Self {
                value: input.value,
            }
        }
    }

    impl From<SizeOfInput> for crate::SizeOfInput {
        fn from(input: SizeOfInput) -> Self {
            Self {
                data: input.data,
            }
        }
    }

    impl From<crate::SizeOfInput> for SizeOfInput {
        fn from(input: crate::SizeOfInput) -> Self {
            Self {
                data: input.data,
            }
        }
    }

    impl From<SizeOfOutput> for crate::SizeOfOutput {
        fn from(input: SizeOfOutput) -> Self {
            Self {
                checksum: input.checksum,
                len: input.len,
            }
        }
    }

    impl From<crate::SizeOfOutput> for SizeOfOutput {
        fn from(input: crate::SizeOfOutput) -> Self {
            Self {
                checksum: input.checksum,
                len: input.len,
            }
        }
    }

    impl From<SpanInput> for crate::SpanInput {
        fn from(input: SpanInput) -> Self {
            Self {
                pair: input.pair.into(),
            }
        }
    }

    impl From<crate::SpanInput> for SpanInput {
        fn from(input: crate::SpanInput) -> Self {
            Self {
                pair: input.pair.into(),
            }
        }
    }

    impl From<SpanInputPair> for (String, i64) {
        fn from(input: SpanInputPair) -> Self {
            (input.v0, input.v1)
        }
    }

    impl From<(String, i64)> for SpanInputPair {
        fn from(input: (String, i64)) -> Self {
            Self {
                v0: input.0,
                v1: input.1,
            }
        }
    }

    impl From<SpanOutput> for crate::SpanOutput {
        fn from(input: SpanOutput) -> Self {
            Self {
                first: input.first,
                second: input.second,
            }
        }
    }

    impl From<crate::SpanOutput> for SpanOutput {
        fn from(input: crate::SpanOutput) -> Self {
            Self {
                first: input.first,
                second: input.second,
            }
        }
    }

    impl From<SumListInput> for crate::SumListInput {
        fn from(input: SumListInput) -> Self {
            Self {
                numbers: input.numbers,
            }
        }
    }

    impl From<crate::SumListInput> for SumListInput {
        fn from(input: crate::SumListInput) -> Self {
            Self {
                numbers: input.numbers,
            }
        }
    }

    impl From<SumListOutput> for crate::SumListOutput {
        fn from(input: SumListOutput) -> Self {
            Self {
                count: input.count,
                total: input.total,
            }
        }
    }

    impl From<crate::SumListOutput> for SumListOutput {
        fn from(input: crate::SumListOutput) -> Self {
            Self {
                count: input.count,
                total: input.total,
            }
        }
    }

    impl From<TagSetInput> for crate::TagSetInput {
        fn from(input: TagSetInput) -> Self {
            Self {
                ids: input.ids.into_iter().collect(),
            }
        }
    }

    impl From<crate::TagSetInput> for TagSetInput {
        fn from(input: crate::TagSetInput) -> Self {
            Self {
                ids: input.ids.into_iter().collect(),
            }
        }
    }

    impl From<TagSetOutput> for crate::TagSetOutput {
        fn from(input: TagSetOutput) -> Self {
            Self {
                tags: input.tags.into_iter().collect(),
            }
        }
    }

    impl From<crate::TagSetOutput> for TagSetOutput {
        fn from(input: crate::TagSetOutput) -> Self {
            Self {
                tags: input.tags.into_iter().collect(),
            }
        }
    }

    impl From<ToUpperInput> for crate::ToUpperInput {
        fn from(input: ToUpperInput) -> Self {
            Self {
                s: input.s,
            }
        }
    }

    impl From<crate::ToUpperInput> for ToUpperInput {
        fn from(input: crate::ToUpperInput) -> Self {
            Self {
                s: input.s,
            }
        }
    }

    impl From<ToUpperOutput> for crate::ToUpperOutput {
        fn from(input: ToUpperOutput) -> Self {
            Self {
                result: input.result,
            }
        }
    }

    impl From<crate::ToUpperOutput> for ToUpperOutput {
        fn from(input: crate::ToUpperOutput) -> Self {
            Self {
                result: input.result,
            }
        }
    }

    impl From<WideAggInput> for crate::WideAggInput {
        fn from(input: WideAggInput) -> Self {
            Self {
                samples: input.samples,
                offset: input.offset,
            }
        }
    }

    impl From<crate::WideAggInput> for WideAggInput {
        fn from(input: crate::WideAggInput) -> Self {
            Self {
                samples: input.samples,
                offset: input.offset,
            }
        }
    }

    impl From<WideAggOutput> for crate::WideAggOutput {
        fn from(input: WideAggOutput) -> Self {
            Self {
                max: input.max,
                adjusted: input.adjusted,
            }
        }
    }

    impl From<crate::WideAggOutput> for WideAggOutput {
        fn from(input: crate::WideAggOutput) -> Self {
            Self {
                max: input.max,
                adjusted: input.adjusted,
            }
        }
    }

    // ── 패키지 접근 — calculator_package() 가 이미 OnceLock 싱글턴 ──
    fn package() -> rustra::Package {
        crate::calculator_package()
    }

    // ── 커맨드별 타입 래퍼 — 스키마 등록 순서 ──
    /// `addNumbers` — `crate::add_numbers` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn addNumbers(input: AddNumbersInput) -> Result<AddNumbersOutput, RustraCommandFailure> {
        let out: crate::AddNumbersOutput = package()
            .invoke_typed::<crate::AddNumbersInput, crate::AddNumbersOutput>("addNumbers", &input.into())?;
        Ok(out.into())
    }

    /// `benchAdd` — `crate::bench_add` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn benchAdd(input: BenchAddInput) -> Result<BenchAddOutput, RustraCommandFailure> {
        let out: crate::BenchAddOutput = package()
            .invoke_typed::<crate::BenchAddInput, crate::BenchAddOutput>("benchAdd", &input.into())?;
        Ok(out.into())
    }

    /// `benchEchoBytes` — `crate::bench_echo_bytes` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn benchEchoBytes(input: BenchBytesPayload) -> Result<BenchBytesPayload, RustraCommandFailure> {
        let out: crate::BenchBytesPayload = package()
            .invoke_typed::<crate::BenchBytesPayload, crate::BenchBytesPayload>("benchEchoBytes", &input.into())?;
        Ok(out.into())
    }

    /// `benchEchoPair` — `crate::bench_echo_pair` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn benchEchoPair(input: BenchPairPayload) -> Result<BenchPairPayload, RustraCommandFailure> {
        let out: crate::BenchPairPayload = package()
            .invoke_typed::<crate::BenchPairPayload, crate::BenchPairPayload>("benchEchoPair", &input.into())?;
        Ok(out.into())
    }

    /// `benchEchoString` — `crate::bench_echo_string` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn benchEchoString(input: BenchStringPayload) -> Result<BenchStringPayload, RustraCommandFailure> {
        let out: crate::BenchStringPayload = package()
            .invoke_typed::<crate::BenchStringPayload, crate::BenchStringPayload>("benchEchoString", &input.into())?;
        Ok(out.into())
    }

    /// `channelDemo` — `crate::channel_demo` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn channelDemo(input: ChannelDemoInput) -> Result<ChannelDemoOutput, RustraCommandFailure> {
        let out: crate::ChannelDemoOutput = package()
            .invoke_typed::<crate::ChannelDemoInput, crate::ChannelDemoOutput>("channelDemo", &input.into())?;
        Ok(out.into())
    }

    /// `channelDemoBytes` — `crate::channel_demo_bytes` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn channelDemoBytes(input: ChannelDemoBytesInput) -> Result<ChannelDemoBytesOutput, RustraCommandFailure> {
        let out: crate::ChannelDemoBytesOutput = package()
            .invoke_typed::<crate::ChannelDemoBytesInput, crate::ChannelDemoBytesOutput>("channelDemoBytes", &input.into())?;
        Ok(out.into())
    }

    /// `clamp` — `crate::clamp` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn clamp(input: ClampInput) -> Result<ClampOutput, RustraCommandFailure> {
        let out: crate::ClampOutput = package()
            .invoke_typed::<crate::ClampInput, crate::ClampOutput>("clamp", &input.into())?;
        Ok(out.into())
    }

    /// `createItem` — `crate::create_item` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn createItem(input: CreateItemInput) -> Result<CreateItemOutput, RustraCommandFailure> {
        let out: crate::CreateItemOutput = package()
            .invoke_typed::<crate::CreateItemInput, crate::CreateItemOutput>("createItem", &input.into())?;
        Ok(out.into())
    }

    /// `deviceDemo` — `crate::device_demo`(unit 입력)의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn deviceDemo() -> Result<DeviceDemoOutput, RustraCommandFailure> {
        let out: crate::DeviceDemoOutput =
            package().invoke_typed::<(), crate::DeviceDemoOutput>("deviceDemo", &())?;
        Ok(out.into())
    }

    /// `divide` — `crate::divide` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn divide(input: DivideInput) -> Result<DivideOutput, RustraCommandFailure> {
        let out: crate::DivideOutput = package()
            .invoke_typed::<crate::DivideInput, crate::DivideOutput>("divide", &input.into())?;
        Ok(out.into())
    }

    /// `echoGroups` — `crate::echo_groups` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn echoGroups(input: EchoGroupsInput) -> Result<EchoGroupsOutput, RustraCommandFailure> {
        let out: crate::EchoGroupsOutput = package()
            .invoke_typed::<crate::EchoGroupsInput, crate::EchoGroupsOutput>("echoGroups", &input.into())?;
        Ok(out.into())
    }

    /// `emitDemo` — `crate::emit_demo` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn emitDemo(input: EmitDemoInput) -> Result<EmitDemoOutput, RustraCommandFailure> {
        let out: crate::EmitDemoOutput = package()
            .invoke_typed::<crate::EmitDemoInput, crate::EmitDemoOutput>("emitDemo", &input.into())?;
        Ok(out.into())
    }

    /// `gauge` — `crate::gauge` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn gauge(input: GaugeInput) -> Result<GaugeOutput, RustraCommandFailure> {
        let out: crate::GaugeOutput = package()
            .invoke_typed::<crate::GaugeInput, crate::GaugeOutput>("gauge", &input.into())?;
        Ok(out.into())
    }

    /// `greet` — `crate::greet` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn greet(input: GreetInput) -> Result<GreetOutput, RustraCommandFailure> {
        let out: crate::GreetOutput = package()
            .invoke_typed::<crate::GreetInput, crate::GreetOutput>("greet", &input.into())?;
        Ok(out.into())
    }

    /// `isEven` — `crate::is_even` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn isEven(input: IsEvenInput) -> Result<IsEvenOutput, RustraCommandFailure> {
        let out: crate::IsEvenOutput = package()
            .invoke_typed::<crate::IsEvenInput, crate::IsEvenOutput>("isEven", &input.into())?;
        Ok(out.into())
    }

    /// `kindEcho` — `crate::kind_echo` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn kindEcho(input: KindEchoInput) -> Result<KindEchoOutput, RustraCommandFailure> {
        let out: crate::KindEchoOutput = package()
            .invoke_typed::<crate::KindEchoInput, crate::KindEchoOutput>("kindEcho", &input.into())?;
        Ok(out.into())
    }

    /// `multiply` — `crate::multiply` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn multiply(input: MultiplyInput) -> Result<MultiplyOutput, RustraCommandFailure> {
        let out: crate::MultiplyOutput = package()
            .invoke_typed::<crate::MultiplyInput, crate::MultiplyOutput>("multiply", &input.into())?;
        Ok(out.into())
    }

    /// `platformNativeInfo` — `crate::platform_native_info`(unit 입력)의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn platformNativeInfo() -> Result<PlatformNativeInfoOutput, RustraCommandFailure> {
        let out: crate::PlatformNativeInfoOutput =
            package().invoke_typed::<(), crate::PlatformNativeInfoOutput>("platformNativeInfo", &())?;
        Ok(out.into())
    }

    /// `processItem` — `crate::process_item` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn processItem(input: ProcessItemInput) -> Result<ProcessItemOutput, RustraCommandFailure> {
        let out: crate::ProcessItemOutput = package()
            .invoke_typed::<crate::ProcessItemInput, crate::ProcessItemOutput>("processItem", &input.into())?;
        Ok(out.into())
    }

    /// `resourceClose` — `crate::resource_close` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn resourceClose(input: ResourceCloseInput) -> Result<ResourceCloseOutput, RustraCommandFailure> {
        let out: crate::ResourceCloseOutput = package()
            .invoke_typed::<crate::ResourceCloseInput, crate::ResourceCloseOutput>("resourceClose", &input.into())?;
        Ok(out.into())
    }

    /// `resourceOpen` — `crate::resource_open` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn resourceOpen(input: ResourceOpenInput) -> Result<ResourceHandleOutput, RustraCommandFailure> {
        let out: crate::ResourceHandleOutput = package()
            .invoke_typed::<crate::ResourceOpenInput, crate::ResourceHandleOutput>("resourceOpen", &input.into())?;
        Ok(out.into())
    }

    /// `resourceRead` — `crate::resource_read` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn resourceRead(input: ResourceReadInput) -> Result<ResourceReadOutput, RustraCommandFailure> {
        let out: crate::ResourceReadOutput = package()
            .invoke_typed::<crate::ResourceReadInput, crate::ResourceReadOutput>("resourceRead", &input.into())?;
        Ok(out.into())
    }

    /// `resourceWrite` — `crate::resource_write` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn resourceWrite(input: ResourceWriteInput) -> Result<ResourceWriteOutput, RustraCommandFailure> {
        let out: crate::ResourceWriteOutput = package()
            .invoke_typed::<crate::ResourceWriteInput, crate::ResourceWriteOutput>("resourceWrite", &input.into())?;
        Ok(out.into())
    }

    /// `rustraRegistryDemo` — `crate::rustra_registry_demo` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn rustraRegistryDemo(input: RegistryDemoInput) -> Result<RegistryDemoOutput, RustraCommandFailure> {
        let out: crate::RegistryDemoOutput = package()
            .invoke_typed::<crate::RegistryDemoInput, crate::RegistryDemoOutput>("rustraRegistryDemo", &input.into())?;
        Ok(out.into())
    }

    /// `scoreTotal` — `crate::score_total` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn scoreTotal(input: ScoreTotalInput) -> Result<ScoreTotalOutput, RustraCommandFailure> {
        let out: crate::ScoreTotalOutput = package()
            .invoke_typed::<crate::ScoreTotalInput, crate::ScoreTotalOutput>("scoreTotal", &input.into())?;
        Ok(out.into())
    }

    /// `secureCompute` — `crate::secure_compute` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn secureCompute(input: SecureComputeInput) -> Result<SecureComputeOutput, RustraCommandFailure> {
        let out: crate::SecureComputeOutput = package()
            .invoke_typed::<crate::SecureComputeInput, crate::SecureComputeOutput>("secureCompute", &input.into())?;
        Ok(out.into())
    }

    /// `sizeOf` — `crate::size_of` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn sizeOf(input: SizeOfInput) -> Result<SizeOfOutput, RustraCommandFailure> {
        let out: crate::SizeOfOutput = package()
            .invoke_typed::<crate::SizeOfInput, crate::SizeOfOutput>("sizeOf", &input.into())?;
        Ok(out.into())
    }

    /// `span` — `crate::span` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn span(input: SpanInput) -> Result<SpanOutput, RustraCommandFailure> {
        let out: crate::SpanOutput = package()
            .invoke_typed::<crate::SpanInput, crate::SpanOutput>("span", &input.into())?;
        Ok(out.into())
    }

    /// `sumList` — `crate::sum_list` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn sumList(input: SumListInput) -> Result<SumListOutput, RustraCommandFailure> {
        let out: crate::SumListOutput = package()
            .invoke_typed::<crate::SumListInput, crate::SumListOutput>("sumList", &input.into())?;
        Ok(out.into())
    }

    /// `tagSet` — `crate::tag_set` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn tagSet(input: TagSetInput) -> Result<TagSetOutput, RustraCommandFailure> {
        let out: crate::TagSetOutput = package()
            .invoke_typed::<crate::TagSetInput, crate::TagSetOutput>("tagSet", &input.into())?;
        Ok(out.into())
    }

    /// `toUpper` — `crate::to_upper` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn toUpper(input: ToUpperInput) -> Result<ToUpperOutput, RustraCommandFailure> {
        let out: crate::ToUpperOutput = package()
            .invoke_typed::<crate::ToUpperInput, crate::ToUpperOutput>("toUpper", &input.into())?;
        Ok(out.into())
    }

    /// `wideAgg` — `crate::wide_agg` 커맨드의 UniFFI 타입 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn wideAgg(input: WideAggInput) -> Result<WideAggOutput, RustraCommandFailure> {
        let out: crate::WideAggOutput = package()
            .invoke_typed::<crate::WideAggInput, crate::WideAggOutput>("wideAgg", &input.into())?;
        Ok(out.into())
    }

    // ── 제네릭 표면 — JSON 경로/스키마/계약 해시 ──
    /// 이름 기반 JSON 호출 — `Package::invoke_json` 의 문자열 경계 래퍼.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn invokeJson(command: String, args_json: String) -> Result<String, RustraCommandFailure> {
        let args: serde_json::Value = if args_json.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_str(&args_json).map_err(|error| {
                RustraCommandFailure::Failure {
                    code: "uniffi.invalid_json".to_string(),
                    detail: error.to_string(),
                    retryable: false,
                }
            })?
        };
        package()
            .invoke_json(&command, args)
            .map(|value| value.to_string())
            .map_err(RustraCommandFailure::from)
    }

    /// 라이브 스키마 JSON — `Package::live_schema`.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn getSchema() -> String {
        package().live_schema().to_string()
    }

    /// 계약 해시 — FFI `rustra_ffi_contract_hash` 와 동일 단일 소스.
    /// 같은 dylib 안의 심볼을 직접 호출해 로직 복제를 피한다.
    #[uniffi::export]
    #[allow(non_snake_case)]
    pub fn contractHash() -> Result<String, RustraCommandFailure> {
        // FFI 전역 등록 보장(생성자 미탑재 호스트 대비, idempotent).
        let _ = package();
        let mut len: usize = 0;
        let ptr = unsafe { rustra_ffi_contract_hash(&mut len) };
        if ptr.is_null() {
            return Err(RustraCommandFailure::Failure {
                code: "uniffi.contract_hash".to_string(),
                detail: "contract hash unavailable".to_string(),
                retryable: false,
            });
        }
        let bytes = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
        unsafe { rustra_ffi_free(ptr, len) };
        String::from_utf8(bytes).map_err(|error| {
            RustraCommandFailure::Failure {
                code: "uniffi.contract_hash".to_string(),
                detail: error.to_string(),
                retryable: false,
            }
        })
    }

    // `rustra_ffi_*` 는 같은 최종 바이너리(cdylib/rlib)에 링크되는 코어
    // FFI 심볼이다 — 계약 해시의 단일 소스를 그대로 재사용한다.
    unsafe extern "C" {
        fn rustra_ffi_contract_hash(out_len: *mut usize) -> *mut u8;
        fn rustra_ffi_free(ptr: *mut u8, len: usize);
    }
}

uniffi::setup_scaffolding!();

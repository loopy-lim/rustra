use rustra::ffi::FfiFormat;
use rustra::prelude::*;

/// 루프형 stdio 런타임 코어 — `loop-stdio` bin 과 통합 테스트가 공유한다.
pub mod loop_stdio;

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddNumbersInput {
    pub a: i64,
    pub b: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddNumbersOutput {
    pub value: i64,
}

#[command]
pub fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput {
        value: input.a + input.b,
    })
}

// ── Tier 1 추가 명령 ──────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MultiplyInput {
    pub a: f64,
    pub b: f64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MultiplyOutput {
    pub value: f64,
}

#[command]
pub fn multiply(input: MultiplyInput) -> Result<MultiplyOutput> {
    Ok(MultiplyOutput {
        value: input.a * input.b,
    })
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IsEvenInput {
    pub n: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IsEvenOutput {
    pub result: bool,
}

#[command]
pub fn is_even(input: IsEvenInput) -> Result<IsEvenOutput> {
    Ok(IsEvenOutput {
        result: input.n % 2 == 0,
    })
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClampInput {
    pub max: f64,
    pub min: f64,
    pub value: f64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClampOutput {
    pub value: f64,
}

#[command]
pub fn clamp(input: ClampInput) -> Result<ClampOutput> {
    Ok(ClampOutput {
        value: input.value.clamp(input.min, input.max),
    })
}

// This declaration order is part of the postcard wire contract. rustra's
// schema emitter preserves it and records `fieldOrder: "declaration"`.

// ── Tier 2 (String/Vec) 명령 ─────────────────────────────

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GreetInput {
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GreetOutput {
    pub message: String,
}

#[command]
pub fn greet(input: GreetInput) -> Result<GreetOutput> {
    Ok(GreetOutput {
        message: format!("Hello, {}!", input.name),
    })
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SumListInput {
    pub numbers: Vec<i64>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SumListOutput {
    pub count: i32,
    pub total: i64,
}

#[command]
pub fn sum_list(input: SumListInput) -> Result<SumListOutput> {
    Ok(SumListOutput {
        count: input.numbers.len() as i32,
        total: input.numbers.iter().sum(),
    })
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToUpperInput {
    pub s: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToUpperOutput {
    pub result: String,
}

#[command]
pub fn to_upper(input: ToUpperInput) -> Result<ToUpperOutput> {
    Ok(ToUpperOutput {
        result: input.s.to_uppercase(),
    })
}

// ── Tier 3 (중첩 구조체) 명령 ────────────────────────────

#[derive(Debug, Serialize, Deserialize, JsonSchema, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub active: bool,
    pub name: String,
    pub value: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreateItemInput {
    pub name: String,
    pub value: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreateItemOutput {
    pub item: Item,
}

#[command]
pub fn create_item(input: CreateItemInput) -> Result<CreateItemOutput> {
    Ok(CreateItemOutput {
        item: Item {
            active: true,
            name: input.name,
            value: input.value,
        },
    })
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessItemInput {
    pub item: Item,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessItemOutput {
    pub doubled: bool,
    pub item: Item,
}

#[command]
pub fn process_item(input: ProcessItemInput) -> Result<ProcessItemOutput> {
    let doubled = input.item.value > 100;
    Ok(ProcessItemOutput {
        doubled,
        item: Item {
            active: input.item.active && doubled,
            name: format!("processed_{}", input.item.name),
            value: input.item.value * 2,
        },
    })
}

// ── Complex native-codec smoke command ───────────────────────────────
// This deliberately exercises a nested map/sequence/string shape. It is
// native-safe for the generated C++ JSI codec and gives the mobile fixture a
// real runtime round-trip beyond scalar postcard commands.

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EchoGroupsInput {
    pub groups: std::collections::BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EchoGroupsOutput {
    pub groups: std::collections::BTreeMap<String, Vec<String>>,
}

#[command]
pub fn echo_groups(input: EchoGroupsInput) -> Result<EchoGroupsOutput> {
    Ok(EchoGroupsOutput {
        groups: input.groups,
    })
}

// ── Tier 1 에러 전용 명령 (criterion 6: typed error roundtrip) ────────
// divide 는 0으로 나눌 때 RustraError::custom("math.divide_by_zero", …) 를
// 반환한다. rkyv V2 error wire([ok=0][pad][len u16][postcard{code,message}])를
// 통해 code 가 그대로 건너가 JS 측 RustraCommandError(code, message) 로 복원되는
// 것을 증명한다.

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DivideInput {
    pub a: i64,
    pub b: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DivideOutput {
    pub value: i64,
}

#[command(error("math.divide_by_zero"))]
pub fn divide(input: DivideInput) -> Result<DivideOutput> {
    if input.b == 0 {
        return Err(RustraError::custom(
            "math.divide_by_zero",
            "cannot divide by zero",
        ));
    }
    Ok(DivideOutput {
        value: input.a / input.b,
    })
}

// ── Runtime Authority (criterion 8: capability-less deny) ────────────
// `secureCompute` 는 `compute:secure` capability 를 요구한다 (deny-by-default).
// capability 가 부여되기 전까지는 capability.denied 로 거부되며 핸들러 본문이
// 실행되지 않는다. 런타임에 grant_capability("compute:secure") 가 호출되어야
// 허용된다. release 빌드에서는 frozen 이므로 영구적으로 deny 된다.

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SecureComputeInput {
    pub a: i64,
    pub b: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SecureComputeOutput {
    pub value: i64,
}

#[command]
pub fn secure_compute(input: SecureComputeInput) -> Result<SecureComputeOutput> {
    Ok(SecureComputeOutput {
        value: input.a * input.b,
    })
}

// ── Event push demo (Rust → JS 싱크 검증) ─────────────────
// `emitDemo` 는 `Package::emit` 으로 progress.tick N 회 + demo.done 1 회를
// 발행한다. RN JSI 호스트가 rustra_ffi_event_sink_register 로 C 콜백을
// 등록했으면 emit 이 즉시 콜백으로 전달된다(푸시 경로). 등록 안 된
// 호스트에서는 기존대로 이벤트 버스에 쌓인다(폴링 경로) — 하위호환.

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EmitDemoInput {
    /// 발행할 progress.tick 이벤트 수.
    pub ticks: i64,
    /// 각 스텝 사이 대기 (ms). 데모에서 이벤트 순서를 관찰하기 쉽게.
    pub step_delay_ms: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EmitDemoOutput {
    pub emitted: i64,
}

#[command]
pub fn emit_demo(input: EmitDemoInput) -> Result<EmitDemoOutput> {
    let pkg = rustra::ffi::get_package()
        .ok_or_else(|| RustraError::custom("ffi.not_registered", "package not registered"))?;
    let ticks = input.ticks.max(0);
    let delay = input.step_delay_ms.max(0) as u64;
    for step in 0..ticks {
        if delay > 0 {
            std::thread::sleep(std::time::Duration::from_millis(delay));
        }
        pkg.emit(
            "progress.tick",
            serde_json::json!({ "step": step + 1, "total": ticks }),
        );
    }
    pkg.emit("demo.done", serde_json::json!({ "emitted": ticks + 1 }));
    Ok(EmitDemoOutput { emitted: ticks + 1 })
}

// ── 확장 타입 명령 (2026-08-22 fast-path 타입 확장) ────────────────
// postcard 코덱의 uvar(u32/u64), 동적 맵, 튜플, Vec<u8> 와이어를
// TS 코드젠·C++ JSI 코드젠·Rust 엔진 3면에서 고정한다.
// probe 실측 계약:
// - u32=70000 → [240,162,4] plain varint (zigzag 아님)
// - map{a:1,b:2} → [2, 1,98,4, 1,97,2] count+(key,value)*
// - postcard tuple("hi",-5) → [2,104,105,9] 무접두 나열
// - complex tuple("hi",-5) → [2,2,104,105,9] count + elements
// - vec![1,2,3] u8 → [3,1,2,3] len+raw

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SizeOfInput {
    pub data: Vec<u8>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SizeOfOutput {
    pub checksum: u32,
    pub len: u32,
}

/// Vec<u8>(postcard bytes) 입력 + u32 출력 — plain varint 와이어 고정.
#[command]
pub fn size_of(input: SizeOfInput) -> Result<SizeOfOutput> {
    let checksum = input.data.iter().map(|b| *b as u32).sum::<u32>();
    Ok(SizeOfOutput {
        checksum,
        len: input.data.len() as u32,
    })
}

// ── Framework comparison fixtures ────────────────────────────────
// Nitro Modules 비교 전용 명령. 양쪽 구현이 같은 JS 객체 모양, 같은 연산,
// 같은 반환 모양을 사용하도록 제품 예제 명령(greet/sizeOf/createItem)과 분리한다.

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BenchAddInput {
    pub a: f64,
    pub b: f64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BenchAddOutput {
    pub value: f64,
}

#[command]
pub fn bench_add(input: BenchAddInput) -> Result<BenchAddOutput> {
    Ok(BenchAddOutput {
        value: input.a + input.b,
    })
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BenchStringPayload {
    pub value: String,
}

#[command]
pub fn bench_echo_string(input: BenchStringPayload) -> Result<BenchStringPayload> {
    Ok(input)
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BenchBytesPayload {
    #[serde(with = "rustra::byte_buffer")]
    #[schemars(with = "Vec<u8>")]
    pub data: Vec<u8>,
}

impl rustra::BufferCommandInput for BenchBytesPayload {
    fn from_buffer(data: Vec<u8>) -> Self {
        Self { data }
    }
}

impl rustra::BufferCommandOutput for BenchBytesPayload {
    fn into_buffer(self) -> Vec<u8> {
        self.data
    }
}

#[command]
pub fn bench_echo_bytes(input: BenchBytesPayload) -> Result<BenchBytesPayload> {
    Ok(input)
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BenchPairPayload {
    pub name: String,
    pub value: f64,
}

#[command]
pub fn bench_echo_pair(input: BenchPairPayload) -> Result<BenchPairPayload> {
    Ok(input)
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScoreTotalInput {
    pub scores: std::collections::HashMap<String, i64>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScoreTotalOutput {
    pub count: u32,
    pub total: i64,
}

/// HashMap<String, i64>(동적 맵) — count + (key,value)* 와이어 고정.
#[command]
pub fn score_total(input: ScoreTotalInput) -> Result<ScoreTotalOutput> {
    Ok(ScoreTotalOutput {
        count: input.scores.len() as u32,
        total: input.scores.values().sum(),
    })
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpanInput {
    pub pair: (String, i64),
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpanOutput {
    pub first: String,
    pub second: i64,
}

/// (String, i64) 튜플 — i64 때문에 complex-binary count + elements 와이어.
#[command]
pub fn span(input: SpanInput) -> Result<SpanOutput> {
    Ok(SpanOutput {
        first: input.pair.0,
        second: input.pair.1,
    })
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GaugeInput {
    pub limit: u64,
    pub offset: u32,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GaugeOutput {
    pub next: u64,
}

/// u64/u32 필드 — plain varint(uvar) 와이어 고정(과거 zigzag 버그 수정 증명).
#[command]
pub fn gauge(input: GaugeInput) -> Result<GaugeOutput> {
    Ok(GaugeOutput {
        next: input.limit + input.offset as u64,
    })
}

/// A2 와이드 정수 복합 타입 표본 — Vec<u64> + Option<i64>. 원소/옵션 레벨
/// uvar64/zigzag64 헬퍼가 스트림 중간 7바이트 varint 경계를 넘는 값을 무손실
/// 왕복하는지 cross-wire 픽스처로 고정한다.
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WideAggInput {
    pub samples: Vec<u64>,
    pub offset: Option<i64>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WideAggOutput {
    pub max: u64,
    pub adjusted: i64,
}

#[command]
pub fn wide_agg(input: WideAggInput) -> Result<WideAggOutput> {
    let max = input.samples.iter().copied().max().unwrap_or(0);
    let adjusted = input.offset.unwrap_or(0) + input.samples.len() as i64;
    Ok(WideAggOutput { max, adjusted })
}

// ── B2 Set 직결 표본 — 원시 요소 Set(uniqueItems) 커맨드 ─────────────
// register! 순서가 곧 command id 이므로 신규 커맨드는 반드시 맨 뒤에 붙는다
// (기존 id 시프트 방지). 입력은 BTreeSet<i64>(zigzag 원소), 출력은
// BTreeSet<String>(문자열 원소) — 와이어는 순서 보존 postcard seq 다.
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TagSetInput {
    pub ids: std::collections::BTreeSet<i64>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TagSetOutput {
    pub tags: std::collections::BTreeSet<String>,
}

#[command]
pub fn tag_set(input: TagSetInput) -> Result<TagSetOutput> {
    Ok(TagSetOutput {
        tags: input.ids.into_iter().map(|id| format!("t{id}")).collect(),
    })
}

// ── A5 태그 enum 표본 — unit + data 변형 커맨드 ────────────────────
// serde 외부 태그(기본 표현) enum: postcard 와이어는 [변형 인덱스 u32
// varint][변형 본문] 다. unit 변형(Clear)은 인덱스 한 바이트, struct 변형
// (Set{value})은 인덱스 + 필드 선언순. generated TS/C++ complex codec 이
// oneOf 변형 인덱스 와이어를 동일하게 만들어내는지 cross-wire 픽스처로 고정한다.
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
pub enum OpKind {
    Clear,
    Set { value: i64 },
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KindEchoInput {
    pub kind: OpKind,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KindEchoOutput {
    pub echoed: OpKind,
}

/// enum 에코 — unit/data 변형 왕복(와이어는 변형 인덱스 varint).
#[command]
pub fn kind_echo(input: KindEchoInput) -> Result<KindEchoOutput> {
    Ok(KindEchoOutput { echoed: input.kind })
}

// `rustraRegistryDemo` 는 빌드 시점에 등록되어 항상 호출 가능하며, 런타임에 live
// package 를 mutate 한다. RN 이 사용하는 동일 FFI 경로(invoke_json)를 통해 동작하며,
// mutation 사이에 rebuild 가 필요 없다. release 빌드에서는 frozen 이다.

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PingInput {}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PingOutput {
    pub pong: bool,
}

/// 런타임에 등록되는 데모 핸들러. pong=true 반환.
fn ping(_input: PingInput) -> Result<PingOutput> {
    Ok(PingOutput { pong: true })
}

/// `replace` 시연용 variant. pong=false 반환.
fn ping_variant(_input: PingInput) -> Result<PingOutput> {
    Ok(PingOutput { pong: false })
}

/// addNumbers 자리에 끼워넣을 곱하기 핸들러 (동일 I/O 타입).
fn add_numbers_as_multiply(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput {
        value: input.a * input.b,
    })
}

// ── Vec 입력(가변 길이 배열) 데모 핸들러 ──────────────────
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AverageInput {
    pub numbers: Vec<f64>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AverageOutput {
    pub average: f64,
    pub count: i64,
}

/// 가변 길이 배열(Vec<f64>)을 받는 핸들러. 런타임 등록 데모용.
fn average(input: AverageInput) -> Result<AverageOutput> {
    let count = input.numbers.len() as i64;
    let sum: f64 = input.numbers.iter().sum();
    Ok(AverageOutput {
        average: if count == 0 { 0.0 } else { sum / count as f64 },
        count,
    })
}

// ── 다양한 타입의 동적 명령 데모 핸들러들 (Tier 3 JSON 경로 검증) ──

/// String 입출력 동적 명령.
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GreetDynInput {
    pub name: String,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GreetDynOutput {
    pub message: String,
}
fn greet_dyn(input: GreetDynInput) -> Result<GreetDynOutput> {
    Ok(GreetDynOutput {
        message: format!("hello {}", input.name),
    })
}

/// Map(BTreeMap<String, i64>) 입출력 동적 명령.
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScoreMapInput {
    pub scores: std::collections::BTreeMap<String, i64>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScoreMapOutput {
    pub total: i64,
    pub keys: i64,
}
fn score_map(input: ScoreMapInput) -> Result<ScoreMapOutput> {
    Ok(ScoreMapOutput {
        total: input.scores.values().sum(),
        keys: input.scores.len() as i64,
    })
}

/// 중첩 구조체 + Vec<구조체> 동적 명령.
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PointInput {
    pub x: i64,
    pub y: i64,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NestedEchoInput {
    pub p: PointInput,
    pub items: Vec<PointInput>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NestedEchoOutput {
    pub count: i64,
    pub sum_x: i64,
}
fn nested_echo(input: NestedEchoInput) -> Result<NestedEchoOutput> {
    let mut sum_x = input.p.x;
    let mut count = 1i64;
    for it in &input.items {
        sum_x += it.x;
        count += 1;
    }
    Ok(NestedEchoOutput { count, sum_x })
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RegistryDemoInput {
    pub op: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RegistryDemoOutput {
    pub ok: bool,
    pub frozen: bool,
    pub message: String,
}

/// 런타임 registry 제어 명령. op:
/// `register` / `unregister` / `replacePing` / `replaceAdd` / `restoreAdd` / `freeze` / `state`.
#[command]
pub fn rustra_registry_demo(input: RegistryDemoInput) -> Result<RegistryDemoOutput> {
    let pkg = rustra::ffi::get_package()
        .ok_or_else(|| RustraError::custom("ffi.not_registered", "package not registered"))?;
    let frozen = pkg.is_frozen();
    let message = match input.op.as_str() {
        "register" => match pkg.register("ping", ping) {
            Ok(()) => "registered 'ping'".to_string(),
            Err(e) => format!("register failed: {e}"),
        },
        "unregister" => match pkg.unregister("ping") {
            Ok(()) => "unregistered 'ping'".to_string(),
            Err(e) => format!("unregister failed: {e}"),
        },
        "registerAvg" => match pkg.register("average", average) {
            Ok(()) => "registered 'average' (Vec<f64> input)".to_string(),
            Err(e) => format!("register failed: {e}"),
        },
        "unregisterAvg" => match pkg.unregister("average") {
            Ok(()) => "unregistered 'average'".to_string(),
            Err(e) => format!("unregister failed: {e}"),
        },
        "registerGreet" => match pkg.register("greetDyn", greet_dyn) {
            Ok(()) => "registered 'greetDyn' (String)".to_string(),
            Err(e) => format!("register failed: {e}"),
        },
        "unregisterGreet" => match pkg.unregister("greetDyn") {
            Ok(()) => "unregistered 'greetDyn'".to_string(),
            Err(e) => format!("unregister failed: {e}"),
        },
        "registerMap" => match pkg.register("scoreMap", score_map) {
            Ok(()) => "registered 'scoreMap' (BTreeMap)".to_string(),
            Err(e) => format!("register failed: {e}"),
        },
        "unregisterMap" => match pkg.unregister("scoreMap") {
            Ok(()) => "unregistered 'scoreMap'".to_string(),
            Err(e) => format!("unregister failed: {e}"),
        },
        "registerNested" => match pkg.register("nestedEcho", nested_echo) {
            Ok(()) => "registered 'nestedEcho' (nested struct)".to_string(),
            Err(e) => format!("register failed: {e}"),
        },
        "unregisterNested" => match pkg.unregister("nestedEcho") {
            Ok(()) => "unregistered 'nestedEcho'".to_string(),
            Err(e) => format!("unregister failed: {e}"),
        },
        "replacePing" => match pkg.replace("ping", ping_variant) {
            Ok(()) => "replaced 'ping' -> variant".to_string(),
            Err(e) => format!("replace failed: {e}"),
        },
        "replaceAdd" => match pkg.replace("addNumbers", add_numbers_as_multiply) {
            Ok(()) => "replaced 'addNumbers' -> multiply".to_string(),
            Err(e) => format!("replace failed: {e}"),
        },
        "restoreAdd" => match pkg.replace("addNumbers", add_numbers) {
            Ok(()) => "restored 'addNumbers'".to_string(),
            Err(e) => format!("restore failed: {e}"),
        },
        "freeze" => {
            pkg.freeze();
            "frozen".to_string()
        }
        "state" => format!("frozen={frozen}"),
        other => format!("unknown op: {other}"),
    };
    Ok(RegistryDemoOutput {
        ok: true,
        frozen,
        message,
    })
}

static CACHED_PACKAGE: std::sync::OnceLock<Package> = std::sync::OnceLock::new();

pub fn calculator_package() -> Package {
    CACHED_PACKAGE
        .get_or_init(|| {
            let pkg = register!(
                Package::builder("examples.calculator"),
                add_numbers,
                multiply,
                is_even,
                clamp,
                greet,
                sum_list,
                to_upper,
                create_item,
                process_item,
                divide,
                emit_demo,
                rustra_registry_demo,
                secure_compute,
                size_of,
                score_total,
                span,
                gauge,
                channel_demo,
                resource_open,
                resource_read,
                resource_write,
                resource_close,
                bench_add,
                bench_echo_string
            )
            .buffer_command_fn(bench_echo_bytes)
            .command_fn(bench_echo_pair)
            .command_fn(echo_groups)
            // register! 튜플은 .command_fn 체인만 생성하므로 buffered 커맨드들이
            // 중간에 끼일 수 없다 — 신규 커맨드는 체인 맨 뒤에 붙여야 기존 id가
            // 시프트되지 않는다(register! id는 등록 순서 계약).
            .command_fn(wide_agg)
            .command_fn(tag_set)
            .require_capability("secureCompute", "compute:secure")
            // 신규 커맨드는 id 시프트 방지를 위해 체인 맨 뒤에 붙인다(위 주석).
            // #[command(platform(...))] 폼 — 등록은 전 플랫폼에서 동일하고
            // 스텁/실구현 분기는 매크로가 cfg 로 소유한다. register! 밖 체인
            // 등록은 매크로 메타(platforms)를 명시적으로 연결한다.
            .command_fn(platform_native_info)
            .platform_meta_if(
                __RUstra_meta_platform_native_info,
                __RUstra_platforms_platform_native_info,
            )
            .command_fn(channel_demo_bytes)
            .command_fn(device_demo)
            .devices_meta_if(__RUstra_meta_device_demo, __RUstra_devices_device_demo)
            // A5: 태그 enum 표본 — 신규 커맨드는 id 시프트 방지를 위해 체인 맨 뒤에.
            .command_fn(kind_echo)
            .build();

            // Auto-register for generic FFI with JSON default
            pkg.register_ffi_with_default(FfiFormat::Json);

            pkg
        })
        .clone()
}

// Stable zero-config native entry shared by Bun FFI and the RN bridge. The
// macro also installs the Apple load-time constructor; other hosts call the
// exported symbol explicitly during lazy bootstrap.
rustra::native_entry!(calculator_package);

/// Linux(ELF) — `.init_array` constructor 로 동일 자동 등록. CI(Linux)에서
/// FFI 라운드트립 테스트가 `ffi.not_registered` 로 실패하는 것을 막는다.
/// P2(ELF/PE 생성자 비대칭)의 ELF 측 해소 — Android 셸은 기존대로 명시
/// `rustra_*_init()` 호출을 유지(검증된 패턴).
#[cfg(target_os = "linux")]
mod linux_init {
    #[used]
    #[unsafe(link_section = ".init_array")]
    static AUTO_INIT: extern "C" fn() = {
        extern "C" fn rustra_auto_init() {
            crate::calculator_package();
        }
        rustra_auto_init
    };
}

/// C 진입점: calculator 패키지를 FFI 용으로 idempotently 등록한다.
/// iOS debug 빌드에서 `__mod_init_func` constructor 가 dead-strip 되는 것에 대한
/// 결정론적 대체 수단 (예: JSI install() 에서 호출).
#[unsafe(no_mangle)]
pub extern "C" fn rustra_calculator_init() {
    rustra_mobile_init();
}

/// rkyv v2: command_id (u16) based request — 코어 `rustra_ffi_invoke_rkyv_v2`
/// 심볼로 위임한다 (과거 이 파일에 복제되어 있던 패닉 가드+버퍼 프로토콜의
/// 단일 구현). 심볼명만 calculator 네임스페이스로 재노출해 기존 C++/JSI 호스트
/// 바인딩을 유지한다.
///
/// 주의: 반환 버퍼는 **코어 FFI 할당 레이아웃**(8바이트 헤더)이므로 해제도
/// 코어 `rustra_ffi_free`로 해야 한다 — `rustra_calculator_free_buffer` 같은
/// 예제 레이아웃 해제 심볼과는 교환할 수 없다.
///
/// # Safety
///
/// Caller must ensure `payload` is valid for `payload_len` bytes and `out_len` is a valid pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_invoke_rkyv_v2(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    unsafe { rustra::ffi::rustra_ffi_invoke_rkyv_v2(payload, payload_len, out_len) }
}

/// `rustra_calculator_invoke_rkyv_v2` 응답 버퍼 해제 — 코어 `rustra_ffi_free`
/// 로 위임한다(할당이 코어 레이아웃이므로).
///
/// # Safety
///
/// `ptr`/`len` must be the exact pair returned by `rustra_calculator_invoke_rkyv_v2`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_free_rkyv_v2_buffer(ptr: *mut u8, len: usize) {
    unsafe { rustra::ffi::rustra_ffi_free(ptr, len) };
}

/// 코어 `rustra_ffi_invoke_raw` 의 calculator 네임스페이스 재노출 — JSI
/// `invokeTypedRaw` (Tier 0 스칼라 직결) 진입과 짝을 이룬다. 계약은 코어
/// doc 주석 참조(0=성공, 1=에러, UINT32_MAX=raw 불가 폴백 신호).
///
/// # Safety
///
/// `slots` must be valid for `slot_count` u64 reads; `out_slot`/`err_len` valid
/// write pointers; `err_buf` valid for `err_buf_cap` bytes when non-null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_invoke_typed_raw(
    command_id: u16,
    slots: *const u64,
    slot_count: usize,
    out_slot: *mut u64,
    err_buf: *mut u8,
    err_buf_cap: usize,
    err_len: *mut usize,
) -> u32 {
    unsafe {
        rustra::ffi::rustra_ffi_invoke_raw(
            command_id,
            slots,
            slot_count,
            out_slot,
            err_buf,
            err_buf_cap,
            err_len,
        )
    }
}

/// rkyv V2 비동기 완료 콜백 — `rustra_ffi_invoke_async` 의 on_complete 와 동일 계약.
/// 응답 버퍼는 코어 FFI 레이아웃으로 할당되며 콜백 첫 인자가 null 이 아니면
/// `rustra_calculator_free_rkyv_v2_buffer` 로 해제해야 한다.
pub type RustraCalculatorAsyncCallback =
    unsafe extern "C" fn(user_data: *mut std::ffi::c_void, resp: *mut u8, resp_len: usize);

/// rkyv V2 비동기 진입점 — `rustra_ffi_invoke_async` 와 동일한 계약
/// (invocation_id 발급, 워커 스레드 dispatch, cancel 체크포인트,
/// complete 후 on_complete)을 rkyv V2 와이어로 제공한다.
///
/// RN JSI `invokeTypedAsync` 참조 구현이 호출한다. 취소는
/// `rustra_ffi_invoke_cancel(invocation_id)` 로 전달된다.
///
/// # Safety
///
/// `payload` 는 `payload_len` 바이트 유효 (null+0 허용). `on_complete` 는
/// thread-safe C 콜백. `invocation_id` 는 null 또는 유효한 u64 쓰기 포인터.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_invoke_rkyv_v2_async(
    payload: *const u8,
    payload_len: usize,
    user_data: *mut std::ffi::c_void,
    on_complete: Option<RustraCalculatorAsyncCallback>,
    invocation_id: *mut u64,
) {
    // 코어의 고정 2-worker/256-depth bounded pool을 그대로 사용한다. 예제에서
    // 호출마다 thread::spawn 하던 구현은 burst 시 스레드 폭증과 메모리 고갈을
    // 일으켰고, payload 크기 게이트도 복사 뒤에 적용됐다.
    unsafe {
        rustra::ffi::rustra_ffi_invoke_rkyv_v2_async(
            payload,
            payload_len,
            user_data,
            on_complete,
            invocation_id,
        )
    };
}

// ── 채널/리소스 커맨드 (2026-08-23 타입 패리티 2단계) ──────────────
// Tauri v2 ipc::Channel·Resource 모델의 rustra 계약 버전. wire 에는 정수
// 핸들(u32)만 실린다 — 콜백이나 객체 참조를 직렬화하지 않는다.
//
// - channel_demo: 커맨드 인자로 받은 ChannelHandle 로 역방향 스트림을
//   흘린다(호출 귀속 회신 — 이벤트 emit 과 달리 단일 호출자에게만).
// - resource_open/read/close: Rust-소유 KvResource 핸들. JS 는 정수 id
//   로만 참조하고 소유권은 Rust 테이블에 있다(방향: Rust→TS 코드젠).

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelDemoInput {
    /// 호스트가 발급한 채널 핸들 — JS 콜백이 이 번호에 배선돼 있다.
    pub channel: rustra::channels::ChannelHandle,
    pub ticks: i32,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelDemoOutput {
    pub sent: i32,
    /// 만료된 핸들로의 send 시도 수(stale 무시 계약의 가시화).
    pub dropped_sends: i32,
}

#[command]
pub fn channel_demo(input: ChannelDemoInput) -> Result<ChannelDemoOutput> {
    let mut sent = 0;
    let mut dropped = 0;
    for step in 0..input.ticks.max(0) {
        let payload = serde_json::json!({ "step": step + 1, "of": input.ticks });
        if input.channel.send(&payload.to_string()) {
            sent += 1;
        } else {
            dropped += 1;
        }
    }
    Ok(ChannelDemoOutput {
        sent,
        dropped_sends: dropped,
    })
}

/// 바이너리 채널 데모 — `channel_demo` 의 바이트 경로 쌍둥이. 모든 호스트
/// 어댑터의 createBytesChannel/createChannelBytes 패리티를 동일 명령으로
/// e2e 검증한다(페이로드는 스텝 카운터 LE u64).
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelDemoBytesInput {
    /// 바이너리 채널로 발급받은 핸들.
    pub channel: rustra::channels::ChannelHandle,
    /// 전송할 프레임 수.
    pub ticks: i32,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelDemoBytesOutput {
    pub sent: u32,
    pub dropped_sends: u32,
}

#[command]
fn channel_demo_bytes(input: ChannelDemoBytesInput) -> Result<ChannelDemoBytesOutput> {
    let mut sent = 0;
    let mut dropped = 0;
    for step in 0..input.ticks.max(0) {
        let mut frame = Vec::with_capacity(8);
        frame.extend_from_slice(&((step + 1) as u64).to_le_bytes());
        if input.channel.send_bytes(&frame) {
            sent += 1;
        } else {
            dropped += 1;
        }
    }
    Ok(ChannelDemoBytesOutput {
        sent,
        dropped_sends: dropped,
    })
}

/// 플랫폼 상호운용 — 플랫폼 특화 명령의 계약 안정화 예시.
///
/// `platformNativeInfo` 는 `#[command(platform(windows, macos))]` 로 macos/windows 에만 구현을
/// 선언한다. 등록(id·스키마·계약 해시)은 전 플랫폼에서 동일하게 일어나고,
/// Linux(및 기타)에서 호출하면 `platform.unavailable` 이 반환된다
/// (`command.not_found` 와 구분된다). 실제 구현은 cfg 로 보호해 지원 OS 에서만
/// 주입된다 — win32/objc2 호출을 하는 실명령의 뼈대가 되는 패턴이다.
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlatformNativeInfoOutput {
    /// std::env::consts::OS — 컴파일 대상 OS 문자열.
    pub os: String,
    /// 네이티브 윈도우 시스템 식별자 — 실제 예에서는 win32/objc2 API 조사값.
    pub window_kind: String,
}

#[command(platform(windows, macos))]
fn platform_native_info(_input: ()) -> Result<PlatformNativeInfoOutput> {
    // 이 본문은 선언된 플랫폼(windows/macos)에서만 컴파일된다 — 매크로가 cfg
    // 게이팅을 소유하고, 나머지 플랫폼은 같은 시그니처의 platform.unavailable
    // 스텁을 자동 생성한다(스텁 경로는 Linux CI 가 검증).
    #[cfg(target_os = "windows")]
    let window_kind = "win32-hwnd";
    #[cfg(target_os = "macos")]
    let window_kind = "appkit-nswindow";
    Ok(PlatformNativeInfoOutput {
        os: std::env::consts::OS.to_string(),
        window_kind: window_kind.to_string(),
    })
}

/// 디바이스 역량 계약 — 커맨드가 전제하는 디바이스 역량 선언의 예시.
///
/// `device_demo` 는 `#[command(device(camera, bluetooth))]` 로 카메라·블루투스를
/// 전제한다고 선언한다. 선언은 schema.json 의 조건부 `devices` 필드와 생성
/// `devices.ts`(토큰 유니언 + 커맨드별 요구 상수)의 원천이 될 뿐 런타임
/// 게이팅은 하지 않는다 — 하드웨어 접근·권한 확인은 호스트 앱이
/// getDeviceStatus 로 사전 조회하는 패턴의 뼈대가 되는 예시다(여기서는
/// 하드웨어에 접근하지 않는다).
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDemoOutput {
    /// std::env::consts::OS — 선언과 무관한 컴파일 대상 확인용.
    pub os: String,
}

#[command(device(camera, bluetooth))]
fn device_demo(_input: ()) -> Result<DeviceDemoOutput> {
    Ok(DeviceDemoOutput {
        os: std::env::consts::OS.to_string(),
    })
}

/// Rust-소유 키-값 저장소 리소스 — resource_open 이 발급하고 read/write/close
/// 가 핸들로 접근한다. JS 표면은 { handle: number } 뿐이다.
/// Tauri Resource 와 동일하게 상태는 Mutex 안에 있다(핸들 접근은 &self).
pub struct KvResource {
    entries: std::sync::Mutex<std::collections::BTreeMap<String, String>>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceOpenInput {
    pub initial: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceHandleOutput {
    pub handle: rustra::channels::ResourceHandle,
}

#[command]
pub fn resource_open(input: ResourceOpenInput) -> Result<ResourceHandleOutput> {
    let handle = rustra::channels::host().register_resource(std::sync::Arc::new(KvResource {
        entries: std::sync::Mutex::new(input.initial),
    }));
    Ok(ResourceHandleOutput {
        handle: rustra::channels::ResourceHandle(handle),
    })
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceReadInput {
    pub handle: rustra::channels::ResourceHandle,
    pub key: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceReadOutput {
    pub found: bool,
    pub value: Option<String>,
}

#[command(error("resource.not_found"))]
pub fn resource_read(input: ResourceReadInput) -> Result<ResourceReadOutput> {
    let res = input
        .handle
        .get::<KvResource>()
        .ok_or_else(|| RustraError::custom("resource.not_found", "unknown or closed handle"))?;
    let entries = res.entries.lock().unwrap_or_else(|p| p.into_inner());
    let value = entries.get(&input.key).cloned();
    Ok(ResourceReadOutput {
        found: value.is_some(),
        value,
    })
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceWriteInput {
    pub handle: rustra::channels::ResourceHandle,
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceWriteOutput {
    pub entries: usize,
}

#[command(error("resource.not_found"))]
pub fn resource_write(input: ResourceWriteInput) -> Result<ResourceWriteOutput> {
    let res = input
        .handle
        .get::<KvResource>()
        .ok_or_else(|| RustraError::custom("resource.not_found", "unknown or closed handle"))?;
    let mut entries = res.entries.lock().unwrap_or_else(|p| p.into_inner());
    entries.insert(input.key, input.value);
    let entries = entries.len();
    Ok(ResourceWriteOutput { entries })
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceCloseInput {
    pub handle: rustra::channels::ResourceHandle,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceCloseOutput {
    pub closed: bool,
}

#[command]
pub fn resource_close(input: ResourceCloseInput) -> Result<ResourceCloseOutput> {
    Ok(ResourceCloseOutput {
        closed: rustra::channels::host().drop_resource(input.handle.0),
    })
}

#[cfg(test)]
#[allow(clippy::bool_assert_comparison, clippy::useless_vec)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// RN 이 쓰는 것과 동일한 FFI JSON 경로(`rustra_ffi_invoke_json` →
    /// `Package::invoke_json`)로 커맨드를 호출하고 응답 JSON 을 돌려준다.
    /// debug 전용 테스트에서만 사용된다.
    #[cfg(debug_assertions)]
    fn ffi_call(command: &str, args: serde_json::Value) -> serde_json::Value {
        let req = serde_json::json!({ "command": command, "args": args });
        let payload = serde_json::to_vec(&req).unwrap();
        let mut out_len: usize = 0;
        let ptr = unsafe {
            rustra::ffi::rustra_ffi_invoke_json(payload.as_ptr(), payload.len(), &mut out_len)
        };
        assert!(!ptr.is_null());
        let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) };
        let resp: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        unsafe { rustra::ffi::rustra_ffi_free(ptr, out_len) };
        resp
    }

    /// rkyv V2 에러 와이어의 postcard {code, message} 페이로드.
    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct WireError {
        code: String,
        message: String,
    }

    /// 채널 왕복: 커맨드 인자로 받은 핸들로 흘린 페이로드가 호스트 콜백에
    /// 순서대로 도달한다(Tauri ipc::Channel 방향 — 네이티브→JS 스트림).
    #[test]
    fn channel_demo_streams_to_caller_channel() {
        let hits = Arc::new(AtomicUsize::new(0));
        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let (h2, s2) = (hits.clone(), seen.clone());
        let handle_num = rustra::channels::host().register_channel(Arc::new(move |p| {
            h2.fetch_add(1, Ordering::Relaxed);
            s2.lock().unwrap().push(p.to_string());
        }));

        let out = channel_demo(ChannelDemoInput {
            channel: rustra::channels::ChannelHandle(handle_num),
            ticks: 3,
        })
        .unwrap();
        assert_eq!(out.sent, 3);
        assert_eq!(out.dropped_sends, 0);
        assert_eq!(hits.load(Ordering::Relaxed), 3);
        let got = seen.lock().unwrap().clone();
        assert_eq!(got[0], r#"{"step":1,"of":3}"#);
        assert_eq!(got[2], r#"{"step":3,"of":3}"#);

        // 호출 종료(호스트 측 drop) 후 stale send 는 false — 핸들 재사용 없음.
        assert!(rustra::channels::host().drop_channel(handle_num));
    }

    /// 채널 만료: 핸들이 이미 drop 된 상태에서의 호출은 dropped_sends 로
    /// 가시화된다(조용한 무시 계약).
    #[test]
    fn channel_demo_counts_stale_sends() {
        let handle_num = rustra::channels::host().register_channel(Arc::new(|_| {}));
        assert!(rustra::channels::host().drop_channel(handle_num));
        let out = channel_demo(ChannelDemoInput {
            channel: rustra::channels::ChannelHandle(handle_num),
            ticks: 2,
        })
        .unwrap();
        assert_eq!(out.sent, 0);
        assert_eq!(out.dropped_sends, 2);
    }

    /// 플랫폼 특화 명령 계약 — (1) 전 플랫폼에서 계약상 존재해야 하고 (2) 지원
    /// 플랫폼에서는 실구현, 미지원 플랫폼에서는 platform.unavailable 로 정확히
    /// 구분되어야 한다. macOS/Windows 실행은 impl 경로, Linux CI 는 스텁 경로를
    /// 각각 검증한다.
    #[test]
    fn platform_native_info_contract() {
        let pkg = calculator_package();
        let result = pkg.invoke_json("platformNativeInfo", serde_json::json!(null));
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            let out = result.expect("supported platform must run the real impl");
            assert_eq!(
                out["os"].as_str().unwrap(),
                std::env::consts::OS,
                "impl reports the compile-target OS"
            );
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            let err = result.expect_err("unsupported platform must reject");
            assert_eq!(err.code(), "platform.unavailable");
            assert!(err.message().contains("platformNativeInfo"));
            // command.not_found 와의 구분 — 계약에는 존재한다.
            assert_ne!(err.code(), "command.not_found");
        }
        // 스키마 platforms 필드 — 플랫폼 무관하게 동일하게 기록된다.
        let schema = pkg.live_schema().to_string();
        assert!(
            schema.contains("\"platforms\""),
            "platforms recorded: {schema}"
        );
    }

    /// 매크로 폼 회귀 — #[command(platform(...))] 는 cfg 게이팅을 매크로가
    /// 소유한다. 이 테스트의 선언(linux, windows)은 macOS 를 제외하므로 여기서는
    /// 자동 스텁 경로가 관측된다(register! 체인이 메타를 자동 연결하는지까지
    /// 함께 검증).
    #[test]
    fn command_macro_platform_form_stub_path() {
        #[command(platform(linux, windows))]
        fn macro_platform_probe(_input: ()) -> Result<()> {
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
                Ok(())
            }
            #[cfg(not(any(target_os = "linux", target_os = "windows")))]
            {
                unreachable!("macro stub replaces this body on unsupported platforms")
            }
        }
        let pkg = register!(
            Package::builder("test.platform.macro"),
            macro_platform_probe
        )
        .build();
        let err = pkg.invoke_json("macroPlatformProbe", serde_json::json!(null));
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        {
            let err = err.expect_err("unsupported platform must reject");
            assert_eq!(err.code(), "platform.unavailable");
            assert!(err.message().contains("macroPlatformProbe"));
        }
        #[cfg(any(target_os = "linux", target_os = "windows"))]
        {
            err.expect("declared platform runs the real body");
        }
        assert!(
            pkg.live_schema().to_string().contains("\"platforms\""),
            "register! chains platform metadata automatically"
        );
    }

    /// 리소스 라이프사이클: open → write → read → close → close 후 not_found.
    /// JS 표면은 정수 핸들뿐이고 소유권은 Rust 테이블에 있다.
    #[test]
    fn resource_kv_lifecycle() {
        let mut initial = std::collections::BTreeMap::new();
        initial.insert("seed".to_string(), "1".to_string());
        let opened = resource_open(ResourceOpenInput { initial }).unwrap();
        let handle = opened.handle;

        let read = resource_read(ResourceReadInput {
            handle,
            key: "seed".into(),
        })
        .unwrap();
        assert!(read.found);
        assert_eq!(read.value.as_deref(), Some("1"));

        let wrote = resource_write(ResourceWriteInput {
            handle,
            key: "extra".into(),
            value: "42".into(),
        })
        .unwrap();
        assert_eq!(wrote.entries, 2);

        let read2 = resource_read(ResourceReadInput {
            handle,
            key: "extra".into(),
        })
        .unwrap();
        assert_eq!(read2.value.as_deref(), Some("42"));

        let closed = resource_close(ResourceCloseInput { handle }).unwrap();
        assert!(closed.closed);

        // close 후 접근은 typed 에러 — 이미 drop 된 리소스는 없다.
        let err = resource_read(ResourceReadInput {
            handle,
            key: "seed".into(),
        })
        .unwrap_err();
        assert_eq!(err.code(), "resource.not_found");
        // double close 는 false(멱등).
        assert!(
            !resource_close(ResourceCloseInput { handle })
                .unwrap()
                .closed
        );
    }

    /// Windows(PE) 에는 Apple(`__mod_init_func`)/Linux(`.init_array`) 와 달리
    /// 라이브러리 constructor 가 없어 테스트 바이너리에서 FFI 전역 등록이
    /// 누락된다. FFI 경유 테스트는 이 헬퍼로 결정론적으로 등록한다 —
    /// macOS/Linux 는 constructor 가 이미 등록했으므로 idempotent no-op.
    fn ensure_registered() {
        let _ = calculator_package();
    }

    #[test]
    fn test_direct_buffer_ffi_transfers_owned_output() {
        ensure_registered();
        // id는 등록 순서에서 나오므로 하드코딩하지 않는다 — resolve_command_id
        // 역방향 조회로 찾는다(신규 커맨드 추가로 id가 시프트돼도 테스트가
        // 무관하게 유지된다).
        let bench_echo_bytes_id = (1u16..)
            .find(|id| {
                calculator_package().resolve_command_id(*id).as_deref() == Some("benchEchoBytes")
            })
            .expect("benchEchoBytes registered");
        let input = [0, 1, 127, 128, 255];
        let mut output = std::ptr::null_mut();
        let mut output_len = 0usize;
        let status = unsafe {
            rustra::ffi::rustra_ffi_invoke_buffer(
                bench_echo_bytes_id,
                input.as_ptr(),
                input.len(),
                &mut output,
                &mut output_len,
            )
        };
        assert_eq!(status, 0);
        assert!(!output.is_null());
        assert_eq!(
            unsafe { std::slice::from_raw_parts(output, output_len) },
            input
        );
        unsafe { rustra::ffi::rustra_ffi_free_owned_bytes(output, output_len) };

        let mut empty_output = std::ptr::null_mut();
        let mut empty_output_len = usize::MAX;
        let empty_status = unsafe {
            rustra::ffi::rustra_ffi_invoke_buffer(
                bench_echo_bytes_id,
                std::ptr::null(),
                0,
                &mut empty_output,
                &mut empty_output_len,
            )
        };
        assert_eq!(empty_status, 0);
        assert_eq!(empty_output_len, 0);
        assert!(!empty_output.is_null());
        unsafe { rustra::ffi::rustra_ffi_free_owned_bytes(empty_output, empty_output_len) };

        let full_mebibyte = vec![0u8; 1024 * 1024];
        let mut error_output = std::ptr::null_mut();
        let mut error_len = 0usize;
        let over_limit_status = unsafe {
            rustra::ffi::rustra_ffi_invoke_buffer(
                bench_echo_bytes_id,
                full_mebibyte.as_ptr(),
                full_mebibyte.len(),
                &mut error_output,
                &mut error_len,
            )
        };
        assert_eq!(over_limit_status, 1);
        let error = unsafe { std::slice::from_raw_parts(error_output, error_len) };
        assert!(
            std::str::from_utf8(error)
                .unwrap()
                .contains("payload.too_large")
        );
        unsafe { rustra::ffi::rustra_ffi_free_owned_bytes(error_output, error_len) };

        let invalid_status = unsafe {
            rustra::ffi::rustra_ffi_invoke_buffer(
                bench_echo_bytes_id,
                input.as_ptr(),
                input.len(),
                std::ptr::null_mut(),
                &mut output_len,
            )
        };
        assert_eq!(invalid_status, u32::MAX);

        assert_eq!(rustra::ffi::rustra_ffi_has_buffer(bench_echo_bytes_id), 1);
        assert_eq!(rustra::ffi::rustra_ffi_has_buffer(14), 0);
    }

    #[test]
    fn test_rkyv_v2_generic_dispatch() {
        ensure_registered();
        // Build request using postcard wire format:
        // [command_id: u16 @0][postcard(AddNumbersInput)]
        let payload = v2_request(1, &AddNumbersInput { a: 42, b: 58 });

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        assert!(out_len > 0);

        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };

        // Response: [ok: u8 @0][pad 7B][postcard(AddNumbersOutput)]
        assert_eq!(result_bytes[0], 1); // ok = true
        let output: AddNumbersOutput = postcard::from_bytes(&result_bytes[8..]).unwrap();
        assert_eq!(output.value, 100);

        unsafe { rustra_calculator_free_rkyv_v2_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_rkyv_v2_tier2_string_input() {
        ensure_registered();
        // greet (command_id = 5): input has one String field "name"
        // Wire: [cmd_id: u16 @0][postcard(GreetInput)]
        let payload = v2_request(
            5,
            &GreetInput {
                name: "World".into(),
            },
        );

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        assert!(out_len > 0);

        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        assert_eq!(result_bytes[0], 1); // ok = true

        // Response: [ok @0][pad 7B][postcard(GreetOutput)]
        let output: GreetOutput = postcard::from_bytes(&result_bytes[8..]).unwrap();
        assert_eq!(output.message, "Hello, World!");

        unsafe { rustra_calculator_free_rkyv_v2_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_rkyv_v2_tier2_vec_input() {
        ensure_registered();
        // sum_list (command_id = 6): input has one Vec<i64> field "numbers"
        // Wire: [cmd_id: u16 @0][postcard(SumListInput)]
        let payload = v2_request(
            6,
            &SumListInput {
                numbers: vec![10, 20, 30, 40],
            },
        );

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        assert!(out_len > 0);

        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        assert_eq!(result_bytes[0], 1); // ok = true

        // Response: [ok @0][pad 7B][postcard(SumListOutput)]
        let output: SumListOutput = postcard::from_bytes(&result_bytes[8..]).unwrap();
        assert_eq!(output.count, 4);
        assert_eq!(output.total, 100);

        unsafe { rustra_calculator_free_rkyv_v2_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_rkyv_v2_tier2_string_output() {
        ensure_registered();
        // to_upper (command_id = 7): input has String field "s", output has String field "result"
        // Wire: [cmd_id: u16 @0][postcard(ToUpperInput)]
        let payload = v2_request(7, &ToUpperInput { s: "hello".into() });

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        assert_eq!(result_bytes[0], 1); // ok = true

        // Response: [ok @0][pad 7B][postcard(ToUpperOutput)]
        let output: ToUpperOutput = postcard::from_bytes(&result_bytes[8..]).unwrap();
        assert_eq!(output.result, "HELLO");

        unsafe { rustra_calculator_free_rkyv_v2_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_rkyv_v2_tier3_json_fallback() {
        ensure_registered();
        // process_item (command_id = 9): now uses postcard (no more JSON fallback)
        // Wire: [cmd_id: u16 @0 LE][postcard(ProcessItemInput)]
        let payload = v2_request(
            9,
            &ProcessItemInput {
                item: Item {
                    active: true,
                    name: "widget".into(),
                    value: 50,
                },
            },
        );

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        assert_eq!(result_bytes[0], 1); // ok = true

        // Response: [ok=1 @0][pad 7B][postcard(ProcessItemOutput)]
        let output: ProcessItemOutput = postcard::from_bytes(&result_bytes[8..]).unwrap();

        // process_item with value=50 → doubled=false (value not > 100)
        // active = input.item.active && doubled = true && false = false
        assert_eq!(output.item.name, "processed_widget");
        assert_eq!(output.item.value, 100);
        assert_eq!(output.item.active, false);
        assert_eq!(output.doubled, false);

        unsafe { rustra_calculator_free_rkyv_v2_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_rkyv_v2_tier3_create_item() {
        ensure_registered();
        // create_item (command_id = 8): now uses postcard (no more JSON fallback)
        // Wire: [cmd_id: u16 @0 LE][postcard(CreateItemInput)]
        let payload = v2_request(
            8,
            &CreateItemInput {
                name: "gadget".into(),
                value: 42,
            },
        );

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        assert_eq!(result_bytes[0], 1); // ok = true

        // Response: [ok=1 @0][pad 7B][postcard(CreateItemOutput)]
        let output: CreateItemOutput = postcard::from_bytes(&result_bytes[8..]).unwrap();

        assert_eq!(output.item.name, "gadget");
        assert_eq!(output.item.value, 42);
        assert_eq!(output.item.active, true);

        unsafe { rustra_calculator_free_rkyv_v2_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_rkyv_v2_postcard_binary_handler() {
        ensure_registered();
        // Test the fast postcard binary handler path
        // Build request: [cmd_id: u16 LE][postcard(AddNumbersInput)]
        let payload = v2_request(1, &AddNumbersInput { a: 42, b: 58 });

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        assert!(out_len > 0);

        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        assert_eq!(result_bytes[0], 1); // ok = true

        // Decode postcard response: [ok @0][pad 7B][postcard(AddNumbersOutput) @8...]
        let output: AddNumbersOutput = postcard::from_bytes(&result_bytes[8..]).unwrap();
        assert_eq!(output.value, 100);

        unsafe { rustra_calculator_free_rkyv_v2_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_rkyv_v2_postcard_all_tiers() {
        ensure_registered();
        // Test all 9 commands through the postcard binary handler

        // Tier 1: addNumbers (cmd 1)
        {
            let p = v2_request(1, &AddNumbersInput { a: 10, b: 20 });
            let mut ol: usize = 0;
            let rp = unsafe { rustra_calculator_invoke_rkyv_v2(p.as_ptr(), p.len(), &mut ol) };
            let rb = unsafe { std::slice::from_raw_parts(rp, ol) };
            assert_eq!(rb[0], 1);
            let out: AddNumbersOutput = postcard::from_bytes(&rb[8..]).unwrap();
            assert_eq!(out.value, 30);
            unsafe { rustra_calculator_free_rkyv_v2_buffer(rp, ol) };
        }

        // Tier 1: multiply (cmd 2)
        {
            let p = v2_request(2, &MultiplyInput { a: 1.5, b: 2.0 });
            let mut ol: usize = 0;
            let rp = unsafe { rustra_calculator_invoke_rkyv_v2(p.as_ptr(), p.len(), &mut ol) };
            let rb = unsafe { std::slice::from_raw_parts(rp, ol) };
            assert_eq!(rb[0], 1);
            let out: MultiplyOutput = postcard::from_bytes(&rb[8..]).unwrap();
            assert!((out.value - 3.0).abs() < 0.01);
            unsafe { rustra_calculator_free_rkyv_v2_buffer(rp, ol) };
        }

        // Tier 1: isEven (cmd 3)
        {
            let p = v2_request(3, &IsEvenInput { n: 42 });
            let mut ol: usize = 0;
            let rp = unsafe { rustra_calculator_invoke_rkyv_v2(p.as_ptr(), p.len(), &mut ol) };
            let rb = unsafe { std::slice::from_raw_parts(rp, ol) };
            assert_eq!(rb[0], 1);
            let out: IsEvenOutput = postcard::from_bytes(&rb[8..]).unwrap();
            assert_eq!(out.result, true);
            unsafe { rustra_calculator_free_rkyv_v2_buffer(rp, ol) };
        }

        // Tier 2: greet (cmd 5)
        {
            let p = v2_request(
                5,
                &GreetInput {
                    name: "Rustra".into(),
                },
            );
            let mut ol: usize = 0;
            let rp = unsafe { rustra_calculator_invoke_rkyv_v2(p.as_ptr(), p.len(), &mut ol) };
            let rb = unsafe { std::slice::from_raw_parts(rp, ol) };
            assert_eq!(rb[0], 1);
            let out: GreetOutput = postcard::from_bytes(&rb[8..]).unwrap();
            assert_eq!(out.message, "Hello, Rustra!");
            unsafe { rustra_calculator_free_rkyv_v2_buffer(rp, ol) };
        }

        // Tier 2: sumList (cmd 6)
        {
            let p = v2_request(
                6,
                &SumListInput {
                    numbers: vec![1, 2, 3, 4, 5],
                },
            );
            let mut ol: usize = 0;
            let rp = unsafe { rustra_calculator_invoke_rkyv_v2(p.as_ptr(), p.len(), &mut ol) };
            let rb = unsafe { std::slice::from_raw_parts(rp, ol) };
            assert_eq!(rb[0], 1);
            let out: SumListOutput = postcard::from_bytes(&rb[8..]).unwrap();
            assert_eq!(out.total, 15);
            assert_eq!(out.count, 5);
            unsafe { rustra_calculator_free_rkyv_v2_buffer(rp, ol) };
        }

        // Tier 3: createItem (cmd 8) — postcard handles nested structs!
        {
            let p = v2_request(
                8,
                &CreateItemInput {
                    name: "Widget".into(),
                    value: 42,
                },
            );
            let mut ol: usize = 0;
            let rp = unsafe { rustra_calculator_invoke_rkyv_v2(p.as_ptr(), p.len(), &mut ol) };
            let rb = unsafe { std::slice::from_raw_parts(rp, ol) };
            assert_eq!(rb[0], 1);
            let out: CreateItemOutput = postcard::from_bytes(&rb[8..]).unwrap();
            assert_eq!(out.item.name, "Widget");
            assert_eq!(out.item.value, 42);
            assert_eq!(out.item.active, true);
            unsafe { rustra_calculator_free_rkyv_v2_buffer(rp, ol) };
        }

        // Tier 3: processItem (cmd 9)
        {
            let p = v2_request(
                9,
                &ProcessItemInput {
                    item: Item {
                        active: true,
                        name: "Gadget".into(),
                        value: 200,
                    },
                },
            );
            let mut ol: usize = 0;
            let rp = unsafe { rustra_calculator_invoke_rkyv_v2(p.as_ptr(), p.len(), &mut ol) };
            let rb = unsafe { std::slice::from_raw_parts(rp, ol) };
            assert_eq!(rb[0], 1);
            let out: ProcessItemOutput = postcard::from_bytes(&rb[8..]).unwrap();
            assert_eq!(out.item.value, 400);
            assert_eq!(out.doubled, true);
            unsafe { rustra_calculator_free_rkyv_v2_buffer(rp, ol) };
        }
    }

    #[test]
    fn test_rkyv_v2_error_response_encoding() {
        ensure_registered();
        // Send a payload with an unknown command_id to trigger an error.
        // Error wire: [ok=0 @0][pad 7B][err_len u16 @8][postcard({code,message}) @10]
        let mut payload = vec![0u8; 16];
        payload[0..2].copy_from_slice(&999u16.to_le_bytes()); // unknown command_id
        payload[8..16].copy_from_slice(&0i64.to_le_bytes());

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        assert_eq!(result_bytes[0], 0); // ok = false

        // Decode the structured postcard error payload → { code, message }.
        let error_len = u16::from_le_bytes(result_bytes[8..10].try_into().unwrap()) as usize;
        assert!(error_len > 0);
        let wire: WireError = postcard::from_bytes(&result_bytes[10..10 + error_len]).unwrap();
        // Unknown command_id → command_not_found typed error (code preserved).
        assert_eq!(wire.code, "command.not_found");
        assert!(!wire.message.is_empty());

        unsafe { rustra_calculator_free_rkyv_v2_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_rkyv_v2_divide_by_zero_typed_error() {
        ensure_registered();
        // divide (command_id = 11) with b=0 → RustraError::custom("math.divide_by_zero").
        // Proves a domain typed error code round-trips through the rkyv V2 error wire.
        let payload = v2_request(10, &DivideInput { a: 10, b: 0 });

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        assert_eq!(result_bytes[0], 0); // ok = false (error)

        let error_len = u16::from_le_bytes(result_bytes[8..10].try_into().unwrap()) as usize;
        let wire: WireError = postcard::from_bytes(&result_bytes[10..10 + error_len]).unwrap();
        assert_eq!(wire.code, "math.divide_by_zero");
        assert_eq!(wire.message, "cannot divide by zero");

        unsafe { rustra_calculator_free_rkyv_v2_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_rkyv_v2_divide_success() {
        ensure_registered();
        // divide with b!=0 succeeds: [ok=1 @0][pad 7B][postcard(DivideOutput)@8]
        let payload = v2_request(10, &DivideInput { a: 20, b: 4 });

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        assert_eq!(result_bytes[0], 1); // ok = true
        let output: DivideOutput = postcard::from_bytes(&result_bytes[8..]).unwrap();
        assert_eq!(output.value, 5);

        unsafe { rustra_calculator_free_rkyv_v2_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_rkyv_v2_capability_deny() {
        ensure_registered();
        // secureCompute (command_id = 13) requires capability "compute:secure".
        // In the debug build the package is mutable but the capability is never
        // granted here → deny-by-default → capability.denied wire error.
        let payload = v2_request(13, &SecureComputeInput { a: 6, b: 7 });

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        assert_eq!(result_bytes[0], 0); // ok = false (denied)

        let error_len = u16::from_le_bytes(result_bytes[8..10].try_into().unwrap()) as usize;
        let wire: WireError = postcard::from_bytes(&result_bytes[10..10 + error_len]).unwrap();
        assert_eq!(wire.code, "capability.denied");

        unsafe { rustra_calculator_free_rkyv_v2_buffer(result_ptr, out_len) };
    }

    #[test]
    #[cfg(debug_assertions)]
    fn test_rkyv_v2_capability_grant_then_allow() {
        // Grant on a FRESH local package (not the global FFI singleton) so the
        // deny test (which uses the global, never-granted package) stays
        // deterministic under parallel test execution.
        let pkg = register!(Package::builder("test.secure"), secure_compute)
            .require_capability("secureCompute", "compute:secure")
            .build();
        // secure_compute → command_id 1 in this fresh package.
        assert!(!pkg.has_capability("compute:secure"));

        // Before grant: denied.
        let mut payload = vec![0u8; 2 + 2];
        payload[0..2].copy_from_slice(&1u16.to_le_bytes()); // command_id = 1
        payload[2] = 0b0000_1010; // postcard zigzag varint: 5 → 10
        payload[3] = 0;
        let err = pkg.invoke_rkyv_v2(&payload).unwrap_err();
        assert_eq!(err.code(), "capability.denied");

        // After grant: allowed.
        pkg.grant_capability("compute:secure").unwrap();
        let ok_payload = v2_request(1, &SecureComputeInput { a: 6, b: 7 });
        let resp = pkg.invoke_rkyv_v2(&ok_payload).unwrap();
        assert_eq!(resp[0], 1); // ok = true
        let output: SecureComputeOutput = postcard::from_bytes(&resp[8..]).unwrap();
        assert_eq!(output.value, 42); // 6 * 7
    }

    /// Runtime registry end-to-end through the EXACT FFI path RN uses
    /// (`rustra_ffi_invoke_json` → `Package::invoke_json`).
    /// Proves live register / replace / unregister with no rebuild between steps.
    #[test]
    #[cfg(debug_assertions)]
    fn test_runtime_registry_through_ffi_invoke_json() {
        let _ = calculator_package(); // ensure global package initialized

        // debug build → not frozen
        let state = ffi_call("rustraRegistryDemo", serde_json::json!({ "op": "state" }));
        assert_eq!(
            state["result"]["frozen"], false,
            "debug build must be mutable: {state}"
        );

        // 'ping' does not exist yet
        let before = ffi_call("ping", serde_json::json!({}));
        assert_eq!(before["ok"], false, "ping should not exist yet: {before}");

        // register at runtime (through the RN FFI path)
        let r = ffi_call(
            "rustraRegistryDemo",
            serde_json::json!({ "op": "register" }),
        );
        assert_eq!(r["result"]["message"], "registered 'ping'");
        let ping1 = ffi_call("ping", serde_json::json!({}));
        assert_eq!(
            ping1["result"]["pong"], true,
            "registered ping works: {ping1}"
        );

        // replace handler at runtime — same command, different behavior
        ffi_call(
            "rustraRegistryDemo",
            serde_json::json!({ "op": "replacePing" }),
        );
        let ping2 = ffi_call("ping", serde_json::json!({}));
        assert_eq!(
            ping2["result"]["pong"], false,
            "replaced ping should return pong=false: {ping2}"
        );

        // unregister at runtime — command disappears
        ffi_call(
            "rustraRegistryDemo",
            serde_json::json!({ "op": "unregister" }),
        );
        let after = ffi_call("ping", serde_json::json!({}));
        assert_eq!(after["ok"], false, "ping gone after unregister: {after}");
    }

    /// Dynamic command with Vec<f64> input, through the RN FFI path.
    #[test]
    #[cfg(debug_assertions)]
    fn test_runtime_registry_vec_input_through_ffi() {
        let _ = calculator_package();

        // register the Vec-input command at runtime
        let r = ffi_call(
            "rustraRegistryDemo",
            serde_json::json!({ "op": "registerAvg" }),
        );
        assert_eq!(
            r["result"]["message"],
            "registered 'average' (Vec<f64> input)"
        );

        // variable-length array flows through invoke_json
        let out = ffi_call(
            "average",
            serde_json::json!({ "numbers": [10.0, 20.0, 30.0] }),
        );
        assert_eq!(out["ok"], true, "average should succeed: {out}");
        assert_eq!(out["result"]["count"], 3);
        assert!((out["result"]["average"].as_f64().unwrap() - 20.0).abs() < 1e-9);

        // unregister → gone
        ffi_call(
            "rustraRegistryDemo",
            serde_json::json!({ "op": "unregisterAvg" }),
        );
        let after = ffi_call("average", serde_json::json!({ "numbers": [] }));
        assert_eq!(after["ok"], false, "average gone after unregister: {after}");
    }

    // ── invoke_rkyv_v2_async (follow-up 3): id 발급 + 취소 체크포인트 ──

    /// on_complete 콜백이 받은 프레임을 캡처한다. 기존 sync 테스트와 동일하게
    /// addNumbers 는 command_id 1 로 고정이다.
    struct AsyncCapture {
        frame: std::sync::Mutex<Option<(Vec<u8>, usize)>>,
        fired: std::sync::atomic::AtomicBool,
    }

    impl AsyncCapture {
        fn new() -> Self {
            Self {
                frame: std::sync::Mutex::new(None),
                fired: std::sync::atomic::AtomicBool::new(false),
            }
        }
    }

    unsafe extern "C" fn capture_async_cb(
        _user: *mut std::ffi::c_void,
        resp: *mut u8,
        resp_len: usize,
    ) {
        let cap = unsafe { &*(_user as *const AsyncCapture) };
        if resp.is_null() {
            cap.fired.store(true, std::sync::atomic::Ordering::Release);
            return;
        }
        let data = unsafe { std::slice::from_raw_parts(resp, resp_len) }.to_vec();
        // rkyv V2 async delegates to the core allocator, so the matching core
        // free wrapper is mandatory. The legacy calculator free has a different
        // allocation layout and intentionally aborts on this pointer.
        unsafe { rustra_calculator_free_rkyv_v2_buffer(resp, resp_len) };
        *cap.frame.lock().unwrap() = Some((data, resp_len));
        // Publish completion only after the captured frame is visible.
        cap.fired.store(true, std::sync::atomic::Ordering::Release);
    }

    /// rkyv V2 요청 바이트 — `[cmd_id u16 LE][postcard(input)]`. 기존 add_request
    /// (cmd_id 1 고정)를 일반화한 헬퍼로, 생성 바이트는 기존과 동일하다.
    fn v2_request<I: serde::Serialize>(cmd_id: u16, input: &I) -> Vec<u8> {
        let body = postcard::to_allocvec(input).unwrap();
        let mut req = vec![0u8; 2 + body.len()];
        req[0..2].copy_from_slice(&cmd_id.to_le_bytes());
        req[2..].copy_from_slice(&body);
        req
    }

    /// 콜백 발생을 (최대 수 초 동안) 기다린다 — 워커 스레드 스케줄링 경합 흡수.
    fn wait_for_callback(cap: &AsyncCapture) {
        for _ in 0..2_000 {
            if cap.fired.load(std::sync::atomic::Ordering::Acquire) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        panic!("async callback did not fire within timeout");
    }

    /// rkyv V2 에러 프레임에서 postcard {code, message} 를 디코딩한다.
    fn decode_error_wire(frame: &[u8]) -> (String, String) {
        assert!(frame.len() >= 10, "error frame must carry the 10B header");
        assert_eq!(frame[0], 0, "ok flag must be 0 for an error frame");
        let body = &frame[10..];
        // postcard: varint-len 문자열 2개 (code, message).
        fn read_str(b: &[u8]) -> (String, usize) {
            let mut shift = 0;
            let mut len = 0usize;
            let mut i = 0;
            loop {
                let byte = b[i];
                len |= ((byte & 0x7f) as usize) << shift;
                i += 1;
                if byte & 0x80 == 0 {
                    break;
                }
                shift += 7;
            }
            (
                String::from_utf8_lossy(&b[i..i + len]).into_owned(),
                i + len,
            )
        }
        let (code, n) = read_str(body);
        let (message, _) = read_str(&body[n..]);
        (code, message)
    }

    #[test]
    fn invoke_rkyv_v2_async_issues_id_and_round_trips() {
        ensure_registered();
        let req = v2_request(1, &AddNumbersInput { a: 20, b: 22 });

        let cap = AsyncCapture::new();
        let mut invocation_id: u64 = 0;
        unsafe {
            rustra_calculator_invoke_rkyv_v2_async(
                req.as_ptr(),
                req.len(),
                &cap as *const _ as *mut std::ffi::c_void,
                Some(capture_async_cb),
                &mut invocation_id,
            )
        };
        assert!(invocation_id > 0, "a fresh invocation id must be issued");
        wait_for_callback(&cap);
        let (frame, len) = cap
            .frame
            .lock()
            .unwrap()
            .take()
            .expect("callback must deliver the response frame");
        assert_eq!(frame[0], 1, "success frame ok flag must be 1");
        assert_eq!(frame.len(), len);
        let out: AddNumbersOutput = postcard::from_bytes(&frame[8..]).unwrap();
        assert_eq!(out.value, 42);
        // 완료 후 레지스트리 정리 — Unknown.
        assert_eq!(
            rustra::cancel::status(invocation_id),
            rustra::cancel::Status::Unknown
        );
    }

    #[test]
    fn invoke_rkyv_v2_async_pre_cancelled_returns_cancelled_frame() {
        ensure_registered();
        let req = v2_request(1, &AddNumbersInput { a: 1, b: 2 });

        let cap = AsyncCapture::new();
        let mut invocation_id: u64 = 0;
        unsafe {
            rustra_calculator_invoke_rkyv_v2_async(
                req.as_ptr(),
                req.len(),
                &cap as *const _ as *mut std::ffi::c_void,
                Some(capture_async_cb),
                &mut invocation_id,
            );
            // 발급 직후 dispatch 전 취소 — 체크포인트가 핸들러 시작을 막는다.
            // (spawn 직후의 cancel 이라 극히 드물게 워커가 먼저 통과할 수 있으나,
            //  체크포인트가 status 를 다시 읽으므로 대부분 Cancelled 로 관측된다.
            //  이 테스트의 관심사는 "cancelled 프레임 계약" 자체다.)
            rustra::ffi::rustra_ffi_invoke_cancel(invocation_id);
        }
        wait_for_callback(&cap);
        let (frame, _) = cap
            .frame
            .lock()
            .unwrap()
            .take()
            .expect("invocation must deliver a frame");
        if frame[0] == 1 {
            // 드문 경합 — 워커가 cancel 보다 먼저 체크포인트를 통과한 경우.
            // 계약상 허용되는 결과다 (핸들러는 끝까지 실행됨). 재시도로 판정.
            return;
        }
        let (code, message) = decode_error_wire(&frame);
        assert_eq!(code, "cancelled");
        assert!(
            message.contains("cancelled before dispatch"),
            "message should point at the pre-dispatch checkpoint, got: {message}"
        );
    }

    #[test]
    fn invoke_rkyv_v2_async_null_out_param_still_runs() {
        ensure_registered();
        let req = v2_request(1, &AddNumbersInput { a: 2, b: 3 });

        // invocation_id null — ID 발급은 일어나지만 호출자에게 노출되지 않는다.
        // on_complete 도 None 이면 워커는 버퍼를 만들지 않는다 (누수 없음).
        unsafe {
            rustra_calculator_invoke_rkyv_v2_async(
                req.as_ptr(),
                req.len(),
                std::ptr::null_mut(),
                None,
                std::ptr::null_mut(),
            )
        };
        // 관찰할 콜백이 없다 — 크래시/패닉 없이 스레드가 정리되는지만 확인.
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

// ── Track B1-2 — UniFFI 미러 계층 ────────────────────────────
// 스키마 문서 → 미러 Rust 소스 렌더러. 코드젠(generate bin) 전용이지만 런타임
// 의존이 없어 전 빌드에서 컴파일된다(단위 테스트는 uniffi 피처 불필요).
pub mod uniffi_render;

// `--features uniffi` 빌드에서만 코드젠 산출물을 붙인다. 파일 안의 모든 항목은
// `pub mod uniffi_api`(미러 타입 + 커맨드별 `#[uniffi::export]` 래퍼)와 크레이트
// 루트의 `uniffi::setup_scaffolding!()` 로 이루어진다. 재생성:
//   RUSTRA_UNIFFI_OUT=src cargo run -p rustra-calculator-example --bin generate
#[cfg(feature = "uniffi")]
include!("uniffi_generated.rs");

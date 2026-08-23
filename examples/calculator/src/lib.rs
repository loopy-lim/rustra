use rustra::ffi::FfiFormat;
use rustra::prelude::*;
use serde_json::{Value, json};
use std::ffi::{CStr, CString, c_char};

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

#[command]
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
// - tuple("hi",-5) → [2,104,105,9] 무접두 나열
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
    pub data: Vec<u8>,
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

/// (String, i64) 튜플 — 무접두 나열 와이어 고정.
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
                bench_echo_string,
                bench_echo_bytes,
                bench_echo_pair
            )
            .require_capability("secureCompute", "compute:secure")
            .build();

            // Auto-register for generic FFI with JSON default
            pkg.register_ffi_with_default(FfiFormat::Json);

            pkg
        })
        .clone()
}

// ── Library constructor: auto-register on load ──────────────
// This ensures calculator_package() is called when the static library
// is loaded, so generic FFI functions (rustra_ffi_invoke, etc.) work
// without requiring a legacy calculator-specific call first.

#[cfg(target_vendor = "apple")]
mod apple_init {
    extern "C" fn rustra_auto_init() {
        super::calculator_package();
    }

    #[used]
    #[cfg_attr(
        target_vendor = "apple",
        unsafe(link_section = "__DATA,__mod_init_func")
    )]
    static AUTO_INIT: extern "C" fn() = rustra_auto_init;
}

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
    let _ = calculator_package();
}

/// 벤치마크용 최소 C ABI lower bound. 브리지/직렬화 비용은 포함하지 않으며
/// `addNumbers`의 산술 연산과 동일한 값만 계산한다.
#[unsafe(no_mangle)]
pub extern "C" fn rustra_calculator_add_direct(a: i64, b: i64) -> i64 {
    a + b
}

/// # Safety
///
/// `payload` must be a valid pointer to a null-terminated C string containing UTF-8 JSON.
/// The caller must free the returned pointer with `rustra_calculator_free_string`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_invoke(payload: *const c_char) -> *mut c_char {
    if payload.is_null() {
        return json_string(json!({ "ok": false, "error": "payload was null" }));
    }

    let payload = match unsafe { CStr::from_ptr(payload) }.to_str() {
        Ok(payload) => payload,
        Err(error) => {
            return json_string(
                json!({ "ok": false, "error": format!("payload was not UTF-8: {error}") }),
            );
        }
    };

    // 네이티브 동적 한도와 정렬(구현 완료) — 복제 상수 대신 공개 판독기를 읽는다.
    // 에러 코드는 `payload.too_large` 로 통일 (JS 사전 검사와 동일 코드).
    if payload.len() > rustra::ffi::max_payload_bytes() {
        let e = RustraError::payload_too_large(payload.len(), rustra::ffi::max_payload_bytes());
        return json_string(json!({ "ok": false, "error": e.to_string() }));
    }

    let request = match serde_json::from_str::<Value>(payload) {
        Ok(request) => request,
        Err(error) => {
            return json_string(json!({ "ok": false, "error": format!("invalid json: {error}") }));
        }
    };

    let Some(command) = request.get("command").and_then(Value::as_str) else {
        return json_string(json!({ "ok": false, "error": "missing command" }));
    };

    let args = request.get("args").cloned().unwrap_or_else(|| json!({}));

    match rustra::ffi::get_package()
        .ok_or_else(|| RustraError::custom("ffi.not_registered", "package not registered"))
        .and_then(|pkg| pkg.invoke_json(command, args))
    {
        Ok(result) => json_string(json!({ "ok": true, "result": result })),
        Err(error) => json_string(json!({ "ok": false, "error": error.to_string() })),
    }
}

/// # Safety
///
/// `ptr` must be a pointer previously returned by `rustra_calculator_invoke`,
/// or null. Must not be called more than once for the same pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        let _ = unsafe { CString::from_raw(ptr) };
    }
}

fn json_string(value: Value) -> *mut c_char {
    let text = serde_json::to_string(&value)
        .unwrap_or_else(|error| format!(r#"{{"ok":false,"error":"json encode failed: {error}"}}"#));

    CString::new(text)
        .expect("JSON response should not contain interior null bytes")
        .into_raw()
}

/// # Safety
///
/// Caller must ensure `payload` is valid for `payload_len` bytes and `out_len` is a valid pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_invoke_bytes(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if payload.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }

    if payload_len > rustra::ffi::max_payload_bytes() {
        let e = RustraError::payload_too_large(payload_len, rustra::ffi::max_payload_bytes());
        let error = format!(r#"{{"ok":false,"error":"{e}"}}"#);
        return alloc_response(error.into_bytes(), out_len);
    }

    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };

    let payload_str = match std::str::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => {
            let error = format!(r#"{{"ok":false,"error":"payload was not UTF-8: {e}"}}"#);
            return alloc_response(error.into_bytes(), out_len);
        }
    };

    let c_payload = match CString::new(payload_str) {
        Ok(c) => c,
        Err(_) => {
            let error = r#"{"ok":false,"error":"payload contained null byte"}"#;
            return alloc_response(error.as_bytes().to_vec(), out_len);
        }
    };

    let result_ptr = unsafe { rustra_calculator_invoke(c_payload.as_ptr()) };
    let result_cstr = unsafe { std::ffi::CStr::from_ptr(result_ptr) };
    let result_bytes = result_cstr.to_bytes().to_vec();
    unsafe { rustra_calculator_free_string(result_ptr) };

    alloc_response(result_bytes, out_len)
}

/// # Safety
///
/// Caller must ensure `ptr` was previously returned by an invoke function and `len` matches the
/// original output length. Must not be called more than once for the same pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_free_buffer(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        unsafe {
            let slice = std::slice::from_raw_parts_mut(ptr, len);
            let _ = Box::from_raw(slice as *mut [u8]);
        }
    }
}

fn alloc_response(data: Vec<u8>, out_len: *mut usize) -> *mut u8 {
    unsafe { *out_len = data.len() };
    let boxed: Box<[u8]> = data.into_boxed_slice();
    Box::into_raw(boxed) as *mut u8
}

/// Binary protocol:
///   Request:  [cmd_id: u16 LE] [args...]
///     cmd_id 1 = addNumbers => [a: f64 LE] [b: f64 LE]
///   Response: [ok: u8] [payload...]
///     ok=1 success => [value: f64 LE]
///     ok=0 error   => [err_len: u16 LE] [err bytes...]
///
/// # Safety
///
/// Caller must ensure `payload` is valid for `payload_len` bytes and `out_len` is a valid pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_invoke_raw(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if payload.is_null() || payload_len < 2 || out_len.is_null() {
        let err = b"\x00\x03\x00err";
        return alloc_response(err.to_vec(), out_len);
    }

    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };
    let cmd_id = u16::from_le_bytes([bytes[0], bytes[1]]);

    match cmd_id {
        1 => {
            // addNumbers: expects 2 + 8 + 8 = 18 bytes
            if bytes.len() < 18 {
                let err = b"\x00\x10\x00insufficient args";
                return alloc_response(err.to_vec(), out_len);
            }
            let a = f64::from_le_bytes([
                bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9],
            ]);
            let b = f64::from_le_bytes([
                bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15], bytes[16],
                bytes[17],
            ]);
            let result = (a as i64) + (b as i64);
            let mut resp = vec![0x01u8];
            resp.extend_from_slice(&(result as f64).to_le_bytes());
            alloc_response(resp, out_len)
        }
        _ => {
            let msg = format!("unknown cmd_id: {cmd_id}");
            let mut resp = vec![0x00u8];
            let msg_bytes = msg.as_bytes();
            resp.extend_from_slice(&(msg_bytes.len() as u16).to_le_bytes());
            resp.extend_from_slice(msg_bytes);
            alloc_response(resp, out_len)
        }
    }
}

/// MessagePack-encoded FFI: same request/response structure as JSON, but msgpack.
/// Request:  msgpack({ command: String, args: Value })
/// Response: msgpack({ ok: bool, result: Option<Value>, error: Option<String> })
///
/// # Safety
///
/// Caller must ensure `payload` is valid for `payload_len` bytes and `out_len` is a valid pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_invoke_msgpack(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if payload.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }

    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };

    let request: serde_json::Value = match rmp_serde::from_slice(bytes) {
        Ok(req) => req,
        Err(e) => {
            let resp =
                serde_json::json!({"ok": false, "error": format!("msgpack decode failed: {e}")});
            let resp_bytes = rmp_serde::to_vec(&resp).unwrap_or_default();
            return alloc_response(resp_bytes, out_len);
        }
    };

    let Some(command) = request.get("command").and_then(|v| v.as_str()) else {
        let resp = serde_json::json!({"ok": false, "error": "missing command"});
        let resp_bytes = rmp_serde::to_vec(&resp).unwrap_or_default();
        return alloc_response(resp_bytes, out_len);
    };

    let args = request
        .get("args")
        .cloned()
        .unwrap_or(serde_json::json!({}));

    let result = match rustra::ffi::get_package()
        .ok_or_else(|| RustraError::custom("ffi.not_registered", "package not registered"))
        .and_then(|pkg| pkg.invoke_json(command, args))
    {
        Ok(result) => serde_json::json!({"ok": true, "result": result}),
        Err(error) => serde_json::json!({"ok": false, "error": error.to_string()}),
    };

    let resp_bytes = rmp_serde::to_vec(&result).unwrap_or_default();
    alloc_response(resp_bytes, out_len)
}

/// Bincode v2 `standard()` 호환 FFI using typed structs.
///
/// `bincode` crate 자체는 더 이상 유지보수되지 않으므로, 이 벤치마크 경로가 실제로
/// 사용하는 String/i64/bool/Option<String> 와이어만 작고 명시적인 코덱으로 유지한다.
/// JS 어댑터와 기존 바이트 계약은 그대로이며 중단된 런타임 의존성은 제거된다.
#[derive(Serialize, Deserialize)]
struct BincodeRequest {
    command: String,
    a: i64,
    b: i64,
}

#[derive(Serialize, Deserialize)]
struct BincodeResponse {
    ok: bool,
    value: i64,
    error: Option<String>,
}

fn bincode_v2_encode_varint(value: u64, output: &mut Vec<u8>) {
    if value < 251 {
        output.push(value as u8);
    } else if u16::try_from(value).is_ok() {
        output.push(251);
        output.extend_from_slice(&(value as u16).to_le_bytes());
    } else if u32::try_from(value).is_ok() {
        output.push(252);
        output.extend_from_slice(&(value as u32).to_le_bytes());
    } else {
        output.push(253);
        output.extend_from_slice(&value.to_le_bytes());
    }
}

fn bincode_v2_decode_varint(bytes: &[u8], offset: &mut usize) -> std::result::Result<u64, String> {
    let marker = *bytes
        .get(*offset)
        .ok_or_else(|| "truncated varint".to_string())?;
    *offset += 1;

    let width = match marker {
        0..=250 => return Ok(u64::from(marker)),
        251 => 2,
        252 => 4,
        253 => 8,
        _ => return Err(format!("unsupported integer marker {marker}")),
    };
    let end = offset
        .checked_add(width)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| "truncated integer".to_string())?;
    let mut raw = [0u8; 8];
    raw[..width].copy_from_slice(&bytes[*offset..end]);
    *offset = end;
    Ok(u64::from_le_bytes(raw))
}

fn bincode_v2_encode_i64(value: i64, output: &mut Vec<u8>) {
    let zigzag = ((value as u64) << 1) ^ ((value >> 63) as u64);
    bincode_v2_encode_varint(zigzag, output);
}

fn bincode_v2_decode_i64(bytes: &[u8], offset: &mut usize) -> std::result::Result<i64, String> {
    let zigzag = bincode_v2_decode_varint(bytes, offset)?;
    Ok(((zigzag >> 1) as i64) ^ -((zigzag & 1) as i64))
}

fn bincode_v2_encode_string(value: &str, output: &mut Vec<u8>) {
    bincode_v2_encode_varint(value.len() as u64, output);
    output.extend_from_slice(value.as_bytes());
}

fn bincode_v2_decode_string(
    bytes: &[u8],
    offset: &mut usize,
) -> std::result::Result<String, String> {
    let length = usize::try_from(bincode_v2_decode_varint(bytes, offset)?)
        .map_err(|_| "string length exceeds this platform".to_string())?;
    let end = offset
        .checked_add(length)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| "truncated string".to_string())?;
    let value = std::str::from_utf8(&bytes[*offset..end])
        .map_err(|error| format!("invalid UTF-8 string: {error}"))?
        .to_owned();
    *offset = end;
    Ok(value)
}

#[cfg(test)]
fn bincode_v2_encode_request(request: &BincodeRequest) -> Vec<u8> {
    let mut output = Vec::with_capacity(request.command.len() + 18);
    bincode_v2_encode_string(&request.command, &mut output);
    bincode_v2_encode_i64(request.a, &mut output);
    bincode_v2_encode_i64(request.b, &mut output);
    output
}

fn bincode_v2_decode_request(bytes: &[u8]) -> std::result::Result<BincodeRequest, String> {
    let mut offset = 0;
    Ok(BincodeRequest {
        command: bincode_v2_decode_string(bytes, &mut offset)?,
        a: bincode_v2_decode_i64(bytes, &mut offset)?,
        b: bincode_v2_decode_i64(bytes, &mut offset)?,
    })
}

fn bincode_v2_encode_response(response: &BincodeResponse) -> Vec<u8> {
    let mut output = Vec::with_capacity(response.error.as_ref().map_or(3, |error| error.len() + 5));
    output.push(u8::from(response.ok));
    bincode_v2_encode_i64(response.value, &mut output);
    match &response.error {
        Some(error) => {
            output.push(1);
            bincode_v2_encode_string(error, &mut output);
        }
        None => output.push(0),
    }
    output
}

#[cfg(test)]
fn bincode_v2_decode_response(bytes: &[u8]) -> std::result::Result<BincodeResponse, String> {
    let mut offset = 0;
    let ok = match bytes.get(offset).copied() {
        Some(0) => false,
        Some(1) => true,
        Some(value) => return Err(format!("invalid bool marker {value}")),
        None => return Err("truncated bool".to_string()),
    };
    offset += 1;
    let value = bincode_v2_decode_i64(bytes, &mut offset)?;
    let error = match bytes.get(offset).copied() {
        Some(0) => None,
        Some(1) => {
            offset += 1;
            Some(bincode_v2_decode_string(bytes, &mut offset)?)
        }
        Some(value) => return Err(format!("invalid option marker {value}")),
        None => return Err("truncated option".to_string()),
    };
    Ok(BincodeResponse { ok, value, error })
}

/// # Safety
///
/// Caller must ensure `payload` is valid for `payload_len` bytes and `out_len` is a valid pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_invoke_bincode(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if payload.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }

    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };

    let request = match bincode_v2_decode_request(bytes) {
        Ok(request) => request,
        Err(error) => {
            let resp = BincodeResponse {
                ok: false,
                value: 0,
                error: Some(format!("bincode v2 decode failed: {error}")),
            };
            let resp_bytes = bincode_v2_encode_response(&resp);
            return alloc_response(resp_bytes, out_len);
        }
    };

    let result = match rustra::ffi::get_package()
        .ok_or_else(|| RustraError::custom("ffi.not_registered", "package not registered"))
        .and_then(|pkg| {
            pkg.invoke_json(
                &request.command,
                serde_json::json!({"a": request.a, "b": request.b}),
            )
        }) {
        Ok(result) => {
            let value = result.get("value").and_then(|v| v.as_i64()).unwrap_or(0);
            BincodeResponse {
                ok: true,
                value,
                error: None,
            }
        }
        Err(error) => BincodeResponse {
            ok: false,
            value: 0,
            error: Some(error.to_string()),
        },
    };

    let resp_bytes = bincode_v2_encode_response(&result);
    alloc_response(resp_bytes, out_len)
}

/// Postcard-encoded FFI (serde-compatible, actively maintained bincode alternative).
///
/// # Safety
///
/// Caller must ensure `payload` is valid for `payload_len` bytes and `out_len` is a valid pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_invoke_postcard(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if payload.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }

    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };

    let request: BincodeRequest = match postcard::from_bytes(bytes) {
        Ok(req) => req,
        Err(e) => {
            let resp = BincodeResponse {
                ok: false,
                value: 0,
                error: Some(format!("postcard decode failed: {e}")),
            };
            let resp_bytes = postcard::to_allocvec(&resp).unwrap_or_default();
            return alloc_response(resp_bytes, out_len);
        }
    };

    let result = match rustra::ffi::get_package()
        .ok_or_else(|| RustraError::custom("ffi.not_registered", "package not registered"))
        .and_then(|pkg| {
            pkg.invoke_json(
                &request.command,
                serde_json::json!({"a": request.a, "b": request.b}),
            )
        }) {
        Ok(result) => {
            let value = result.get("value").and_then(|v| v.as_i64()).unwrap_or(0);
            BincodeResponse {
                ok: true,
                value,
                error: None,
            }
        }
        Err(error) => BincodeResponse {
            ok: false,
            value: 0,
            error: Some(error.to_string()),
        },
    };

    let resp_bytes = postcard::to_allocvec(&result).unwrap_or_default();
    alloc_response(resp_bytes, out_len)
}

/// rkyv-encoded FFI (zero-copy deserialization).
#[derive(rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
struct RkyvRequest {
    command: String,
    a: i64,
    b: i64,
}

#[derive(rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
struct RkyvResponse {
    ok: bool,
    value: i64,
    error: Option<String>,
}

/// # Safety
///
/// Caller must ensure `payload` is valid for `payload_len` bytes and `out_len` is a valid pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_invoke_rkyv(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if payload.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }

    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };

    let archived = match rkyv::access::<ArchivedRkyvRequest, rkyv::rancor::Error>(bytes) {
        Ok(a) => a,
        Err(_) => {
            let resp = RkyvResponse {
                ok: false,
                value: 0,
                error: Some("rkyv access failed".into()),
            };
            let resp_bytes = rkyv::to_bytes::<rkyv::rancor::Error>(&resp).unwrap_or_default();
            return alloc_response(resp_bytes.to_vec(), out_len);
        }
    };

    let command = archived.command.to_string();
    let a: i64 = archived.a.into();
    let b: i64 = archived.b.into();

    let result = match rustra::ffi::get_package()
        .ok_or_else(|| RustraError::custom("ffi.not_registered", "package not registered"))
        .and_then(|pkg| pkg.invoke_json(&command, serde_json::json!({"a": a, "b": b})))
    {
        Ok(result) => {
            let value = result.get("value").and_then(|v| v.as_i64()).unwrap_or(0);
            RkyvResponse {
                ok: true,
                value,
                error: None,
            }
        }
        Err(error) => RkyvResponse {
            ok: false,
            value: 0,
            error: Some(error.to_string()),
        },
    };

    let resp_bytes = rkyv::to_bytes::<rkyv::rancor::Error>(&result).unwrap_or_default();
    alloc_response(resp_bytes.to_vec(), out_len)
}

/// Hybrid FFI: postcard-encoded request, rkyv-encoded response.
/// Best of both worlds — simple TS-side encoding (LEB128), fast Rust-side response (zero-copy rkyv).
///
/// # Safety
///
/// Caller must ensure `payload` is valid for `payload_len` bytes and `out_len` is a valid pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_invoke_hybrid(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if payload.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }

    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };

    let request: BincodeRequest = match postcard::from_bytes(bytes) {
        Ok(req) => req,
        Err(e) => {
            let resp = RkyvResponse {
                ok: false,
                value: 0,
                error: Some(format!("hybrid decode failed: {e}")),
            };
            let resp_bytes = rkyv::to_bytes::<rkyv::rancor::Error>(&resp).unwrap_or_default();
            return alloc_response(resp_bytes.to_vec(), out_len);
        }
    };

    let result = match rustra::ffi::get_package()
        .ok_or_else(|| RustraError::custom("ffi.not_registered", "package not registered"))
        .and_then(|pkg| {
            pkg.invoke_json(
                &request.command,
                serde_json::json!({"a": request.a, "b": request.b}),
            )
        }) {
        Ok(result) => {
            let value = result.get("value").and_then(|v| v.as_i64()).unwrap_or(0);
            RkyvResponse {
                ok: true,
                value,
                error: None,
            }
        }
        Err(error) => RkyvResponse {
            ok: false,
            value: 0,
            error: Some(error.to_string()),
        },
    };

    let resp_bytes = rkyv::to_bytes::<rkyv::rancor::Error>(&result).unwrap_or_default();
    alloc_response(resp_bytes.to_vec(), out_len)
}

/// rkyv v2: command_id (u16) based request — 코어 `rustra_ffi_invoke_rkyv_v2`
/// 심볼로 위임한다 (과거 이 파일에 복제되어 있던 패닉 가드+버퍼 프로토콜의
/// 단일 구현). 심볼명만 calculator 네임스페이스로 재노출해 기존 C++/JSI 호스트
/// 바인딩을 유지한다.
///
/// 주의: 이 경로의 반환 버퍼는 **코어 FFI 할당 레이아웃**(8바이트 헤더)을
/// 따르므로 해제도 코어 `rustra_ffi_free`로 해야 한다. 기존 JSON/바이너리
/// 경로(`rustra_calculator_invoke_bytes` 등)의 버퍼는 예제 자체
/// `alloc_response` 레이아웃이라 `rustra_calculator_free_buffer` 를 쓴다 —
/// 두 해제 심볼은 서로 교환할 수 없다.
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
/// 로 위임한다(할당이 코어 레이아웃이므로). JSI 호스트가 기존
/// `rustra_calculator_free_buffer` 이름으로 바인딩하고 있어 재노출 심볼만
/// 제공한다.
///
/// # Safety
///
/// `ptr`/`len` must be the exact pair returned by `rustra_calculator_invoke_rkyv_v2`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_free_rkyv_v2_buffer(ptr: *mut u8, len: usize) {
    unsafe { rustra::ffi::rustra_ffi_free(ptr, len) };
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

#[command]
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

#[command]
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
    fn test_invoke_bytes_round_trip() {
        ensure_registered();
        let input = r#"{"command":"addNumbers","args":{"a":42,"b":58}}"#;
        let payload = input.as_bytes();
        let mut out_len: usize = 0;

        let result_ptr = unsafe {
            rustra_calculator_invoke_bytes(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        assert!(out_len > 0);

        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        let result_str = std::str::from_utf8(result_bytes).unwrap();
        let result: serde_json::Value = serde_json::from_str(result_str).unwrap();

        assert_eq!(result["ok"], true);
        assert_eq!(result["result"]["value"], 100);

        unsafe { rustra_calculator_free_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_invoke_bytes_null_payload() {
        let mut out_len: usize = 0;
        let result = unsafe { rustra_calculator_invoke_bytes(std::ptr::null(), 0, &mut out_len) };
        assert!(result.is_null());
    }

    #[test]
    fn test_invoke_bytes_bad_json() {
        let payload = b"not json";
        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_bytes(payload.as_ptr(), payload.len(), &mut out_len)
        };
        assert!(!result_ptr.is_null());
        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        let result_str = std::str::from_utf8(result_bytes).unwrap();
        assert!(result_str.contains(r#""ok":false"#));
        unsafe { rustra_calculator_free_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_invoke_raw_add_numbers() {
        let mut payload = vec![0u8; 18]; // need Vec for .as_ptr() + dynamic len
        payload[0] = 0x01; // cmd_id = 1 (addNumbers)
        payload[1] = 0x00;
        payload[2..10].copy_from_slice(&42f64.to_le_bytes());
        payload[10..18].copy_from_slice(&58f64.to_le_bytes());

        let mut out_len: usize = 0;
        let result_ptr =
            unsafe { rustra_calculator_invoke_raw(payload.as_ptr(), payload.len(), &mut out_len) };

        assert!(!result_ptr.is_null());
        assert_eq!(out_len, 9); // ok(1) + f64(8)

        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        assert_eq!(result_bytes[0], 0x01); // ok
        let value = f64::from_le_bytes(result_bytes[1..9].try_into().unwrap());
        assert_eq!(value as i64, 100);

        unsafe { rustra_calculator_free_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_invoke_bincode_round_trip() {
        ensure_registered();
        let request = BincodeRequest {
            command: "addNumbers".to_string(),
            a: 42,
            b: 58,
        };
        let payload = bincode_v2_encode_request(&request);

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_bincode(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        assert!(out_len > 0);

        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        let result = bincode_v2_decode_response(result_bytes).unwrap();

        assert_eq!(result.ok, true);
        assert_eq!(result.value, 100);

        unsafe { rustra_calculator_free_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_bincode_wire_bytes() {
        let request = BincodeRequest {
            command: "addNumbers".to_string(),
            a: 42,
            b: 58,
        };
        let req_bytes = bincode_v2_encode_request(&request);
        assert_eq!(
            req_bytes,
            [
                &[10],
                b"addNumbers".as_slice(),
                &[84, 116], // zigzag(42), zigzag(58)
            ]
            .concat()
        );
        let decoded = bincode_v2_decode_request(&req_bytes).unwrap();
        assert_eq!(decoded.command, "addNumbers");
        assert_eq!((decoded.a, decoded.b), (42, 58));

        let response = BincodeResponse {
            ok: true,
            value: 100,
            error: None,
        };
        let resp_bytes = bincode_v2_encode_response(&response);
        assert_eq!(resp_bytes, [1, 200, 0]);
        let decoded = bincode_v2_decode_response(&resp_bytes).unwrap();
        assert!(decoded.ok);
        assert_eq!(decoded.value, 100);
        assert_eq!(decoded.error, None);

        let err_response = BincodeResponse {
            ok: false,
            value: 0,
            error: Some("test error".to_string()),
        };
        let err_bytes = bincode_v2_encode_response(&err_response);
        assert_eq!(
            err_bytes,
            [&[0, 0, 1, 10], b"test error".as_slice()].concat()
        );
        assert!(bincode_v2_decode_request(&req_bytes[..req_bytes.len() - 1]).is_err());
    }

    #[test]
    fn test_invoke_msgpack_round_trip() {
        ensure_registered();
        let request = serde_json::json!({"command": "addNumbers", "args": {"a": 42, "b": 58}});
        let payload = rmp_serde::to_vec(&request).unwrap();

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_msgpack(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        assert!(out_len > 0);

        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        let result: serde_json::Value = rmp_serde::from_slice(result_bytes).unwrap();

        assert_eq!(result["ok"], true);
        assert_eq!(result["result"]["value"], 100);

        unsafe { rustra_calculator_free_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_postcard_wire_format() {
        let request = BincodeRequest {
            command: "addNumbers".to_string(),
            a: 42,
            b: 58,
        };
        let req_bytes = postcard::to_allocvec(&request).unwrap();
        println!(
            "postcard request hex: {}",
            req_bytes
                .iter()
                .map(|x| format!("{:02x}", x))
                .collect::<Vec<_>>()
                .join(" ")
        );

        let response = BincodeResponse {
            ok: true,
            value: 100,
            error: None,
        };
        let resp_bytes = postcard::to_allocvec(&response).unwrap();
        println!(
            "postcard response hex: {}",
            resp_bytes
                .iter()
                .map(|x| format!("{:02x}", x))
                .collect::<Vec<_>>()
                .join(" ")
        );

        let err_resp = BincodeResponse {
            ok: false,
            value: 0,
            error: Some("test error".to_string()),
        };
        let err_bytes = postcard::to_allocvec(&err_resp).unwrap();
        println!(
            "postcard err resp hex: {}",
            err_bytes
                .iter()
                .map(|x| format!("{:02x}", x))
                .collect::<Vec<_>>()
                .join(" ")
        );

        // Field-by-field
        for v in [0i64, 42, 58, 100, 127, 128, 256] {
            let b = postcard::to_allocvec(&v).unwrap();
            println!(
                "postcard i64({:>4}) → {} bytes: {}",
                v,
                b.len(),
                b.iter()
                    .map(|x| format!("{:02x}", x))
                    .collect::<Vec<_>>()
                    .join(" ")
            );
        }
        let opt_none: Option<String> = None;
        let b = postcard::to_allocvec(&opt_none).unwrap();
        println!(
            "postcard Opt None → {}",
            b.iter()
                .map(|x| format!("{:02x}", x))
                .collect::<Vec<_>>()
                .join(" ")
        );

        // Round-trip
        let decoded: BincodeRequest = postcard::from_bytes(&req_bytes).unwrap();
        assert_eq!(decoded.command, "addNumbers");
        assert_eq!(decoded.a, 42);
        assert_eq!(decoded.b, 58);
    }

    #[test]
    fn test_rkyv_wire_format() {
        let request = RkyvRequest {
            command: "addNumbers".to_string(),
            a: 42,
            b: 58,
        };
        let req_bytes = rkyv::to_bytes::<rkyv::rancor::Error>(&request).unwrap();
        println!(
            "rkyv request hex: {}",
            req_bytes
                .iter()
                .map(|x| format!("{:02x}", x))
                .collect::<Vec<_>>()
                .join(" ")
        );
        println!("rkyv request len: {}", req_bytes.len());

        let response = RkyvResponse {
            ok: true,
            value: 100,
            error: None,
        };
        let resp_bytes = rkyv::to_bytes::<rkyv::rancor::Error>(&response).unwrap();
        println!(
            "rkyv response hex: {}",
            resp_bytes
                .iter()
                .map(|x| format!("{:02x}", x))
                .collect::<Vec<_>>()
                .join(" ")
        );
        println!("rkyv response len: {}", resp_bytes.len());

        // Zero-copy access
        let archived =
            rkyv::access::<ArchivedRkyvRequest, rkyv::rancor::Error>(&req_bytes).unwrap();
        assert_eq!(archived.command.as_str(), "addNumbers");
        assert_eq!(i64::from(archived.a), 42);
        assert_eq!(i64::from(archived.b), 58);
    }

    #[test]
    fn test_invoke_postcard_round_trip() {
        ensure_registered();
        let request = BincodeRequest {
            command: "addNumbers".to_string(),
            a: 42,
            b: 58,
        };
        let payload = postcard::to_allocvec(&request).unwrap();

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_postcard(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        assert!(out_len > 0);

        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        let result: BincodeResponse = postcard::from_bytes(result_bytes).unwrap();

        assert_eq!(result.ok, true);
        assert_eq!(result.value, 100);

        unsafe { rustra_calculator_free_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_invoke_rkyv_round_trip() {
        ensure_registered();
        let request = RkyvRequest {
            command: "addNumbers".to_string(),
            a: 42,
            b: 58,
        };
        let payload = rkyv::to_bytes::<rkyv::rancor::Error>(&request).unwrap();

        let mut out_len: usize = 0;
        let result_ptr =
            unsafe { rustra_calculator_invoke_rkyv(payload.as_ptr(), payload.len(), &mut out_len) };

        assert!(!result_ptr.is_null());
        assert!(out_len > 0);

        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        let archived =
            rkyv::access::<ArchivedRkyvResponse, rkyv::rancor::Error>(result_bytes).unwrap();
        assert_eq!(archived.ok, true);
        assert_eq!(i64::from(archived.value), 100);

        unsafe { rustra_calculator_free_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_invoke_hybrid_round_trip() {
        ensure_registered();
        let request = BincodeRequest {
            command: "addNumbers".to_string(),
            a: 42,
            b: 58,
        };
        let payload = postcard::to_allocvec(&request).unwrap();

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_hybrid(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        assert!(out_len > 0);

        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        let archived =
            rkyv::access::<ArchivedRkyvResponse, rkyv::rancor::Error>(result_bytes).unwrap();
        assert_eq!(archived.ok, true);
        assert_eq!(i64::from(archived.value), 100);

        unsafe { rustra_calculator_free_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_rkyv_v2_generic_dispatch() {
        ensure_registered();
        // Build request using postcard wire format:
        // [command_id: u16 @0][postcard(AddNumbersInput)]
        let input = AddNumbersInput { a: 42, b: 58 };
        let input_bytes = postcard::to_allocvec(&input).unwrap();
        let mut payload = vec![0u8; 2 + input_bytes.len()];
        payload[0..2].copy_from_slice(&1u16.to_le_bytes()); // command_id = 1 (addNumbers)
        payload[2..2 + input_bytes.len()].copy_from_slice(&input_bytes);

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
        let input = GreetInput {
            name: "World".into(),
        };
        let input_bytes = postcard::to_allocvec(&input).unwrap();
        let mut payload = vec![0u8; 2 + input_bytes.len()];
        payload[0..2].copy_from_slice(&5u16.to_le_bytes()); // command_id = 5 (greet)
        payload[2..2 + input_bytes.len()].copy_from_slice(&input_bytes);

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
        let input = SumListInput {
            numbers: vec![10, 20, 30, 40],
        };
        let input_bytes = postcard::to_allocvec(&input).unwrap();
        let mut payload = vec![0u8; 2 + input_bytes.len()];
        payload[0..2].copy_from_slice(&6u16.to_le_bytes()); // command_id = 6 (sumList)
        payload[2..2 + input_bytes.len()].copy_from_slice(&input_bytes);

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
        let input = ToUpperInput { s: "hello".into() };
        let input_bytes = postcard::to_allocvec(&input).unwrap();
        let mut payload = vec![0u8; 2 + input_bytes.len()];
        payload[0..2].copy_from_slice(&7u16.to_le_bytes()); // command_id = 7 (toUpper)
        payload[2..2 + input_bytes.len()].copy_from_slice(&input_bytes);

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
        let input = ProcessItemInput {
            item: Item {
                active: true,
                name: "widget".into(),
                value: 50,
            },
        };
        let input_bytes = postcard::to_allocvec(&input).unwrap();
        let mut payload = vec![0u8; 2 + input_bytes.len()];
        payload[0..2].copy_from_slice(&9u16.to_le_bytes()); // command_id = 9 (processItem)
        payload[2..2 + input_bytes.len()].copy_from_slice(&input_bytes);

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
        let input = CreateItemInput {
            name: "gadget".into(),
            value: 42,
        };
        let input_bytes = postcard::to_allocvec(&input).unwrap();
        let mut payload = vec![0u8; 2 + input_bytes.len()];
        payload[0..2].copy_from_slice(&8u16.to_le_bytes()); // command_id = 8 (createItem)
        payload[2..2 + input_bytes.len()].copy_from_slice(&input_bytes);

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
        let input = AddNumbersInput { a: 42, b: 58 };
        let input_bytes = postcard::to_allocvec(&input).unwrap();
        let mut payload = vec![0u8; 2 + input_bytes.len()];
        payload[0..2].copy_from_slice(&1u16.to_le_bytes()); // command_id = 1
        payload[2..2 + input_bytes.len()].copy_from_slice(&input_bytes);

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
            let input = AddNumbersInput { a: 10, b: 20 };
            let ib = postcard::to_allocvec(&input).unwrap();
            let mut p = vec![0u8; 2 + ib.len()];
            p[0..2].copy_from_slice(&1u16.to_le_bytes());
            p[2..].copy_from_slice(&ib);
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
            let input = MultiplyInput { a: 1.5, b: 2.0 };
            let ib = postcard::to_allocvec(&input).unwrap();
            let mut p = vec![0u8; 2 + ib.len()];
            p[0..2].copy_from_slice(&2u16.to_le_bytes());
            p[2..].copy_from_slice(&ib);
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
            let input = IsEvenInput { n: 42 };
            let ib = postcard::to_allocvec(&input).unwrap();
            let mut p = vec![0u8; 2 + ib.len()];
            p[0..2].copy_from_slice(&3u16.to_le_bytes());
            p[2..].copy_from_slice(&ib);
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
            let input = GreetInput {
                name: "Rustra".into(),
            };
            let ib = postcard::to_allocvec(&input).unwrap();
            let mut p = vec![0u8; 2 + ib.len()];
            p[0..2].copy_from_slice(&5u16.to_le_bytes());
            p[2..].copy_from_slice(&ib);
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
            let input = SumListInput {
                numbers: vec![1, 2, 3, 4, 5],
            };
            let ib = postcard::to_allocvec(&input).unwrap();
            let mut p = vec![0u8; 2 + ib.len()];
            p[0..2].copy_from_slice(&6u16.to_le_bytes());
            p[2..].copy_from_slice(&ib);
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
            let input = CreateItemInput {
                name: "Widget".into(),
                value: 42,
            };
            let ib = postcard::to_allocvec(&input).unwrap();
            let mut p = vec![0u8; 2 + ib.len()];
            p[0..2].copy_from_slice(&8u16.to_le_bytes());
            p[2..].copy_from_slice(&ib);
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
            let input = ProcessItemInput {
                item: Item {
                    active: true,
                    name: "Gadget".into(),
                    value: 200,
                },
            };
            let ib = postcard::to_allocvec(&input).unwrap();
            let mut p = vec![0u8; 2 + ib.len()];
            p[0..2].copy_from_slice(&9u16.to_le_bytes());
            p[2..].copy_from_slice(&ib);
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
        #[derive(serde::Deserialize)]
        #[allow(dead_code)]
        struct WireError {
            code: String,
            message: String,
        }
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
        let input = DivideInput { a: 10, b: 0 };
        let input_bytes = postcard::to_allocvec(&input).unwrap();
        let mut payload = vec![0u8; 2 + input_bytes.len()];
        payload[0..2].copy_from_slice(&10u16.to_le_bytes()); // command_id = 10 (divide)
        payload[2..2 + input_bytes.len()].copy_from_slice(&input_bytes);

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        assert_eq!(result_bytes[0], 0); // ok = false (error)

        let error_len = u16::from_le_bytes(result_bytes[8..10].try_into().unwrap()) as usize;
        #[derive(serde::Deserialize)]
        #[allow(dead_code)]
        struct WireError {
            code: String,
            message: String,
        }
        let wire: WireError = postcard::from_bytes(&result_bytes[10..10 + error_len]).unwrap();
        assert_eq!(wire.code, "math.divide_by_zero");
        assert_eq!(wire.message, "cannot divide by zero");

        unsafe { rustra_calculator_free_rkyv_v2_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_rkyv_v2_divide_success() {
        ensure_registered();
        // divide with b!=0 succeeds: [ok=1 @0][pad 7B][postcard(DivideOutput)@8]
        let input = DivideInput { a: 20, b: 4 };
        let input_bytes = postcard::to_allocvec(&input).unwrap();
        let mut payload = vec![0u8; 2 + input_bytes.len()];
        payload[0..2].copy_from_slice(&10u16.to_le_bytes()); // command_id = 10 (divide)
        payload[2..2 + input_bytes.len()].copy_from_slice(&input_bytes);

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
        let input = SecureComputeInput { a: 6, b: 7 };
        let input_bytes = postcard::to_allocvec(&input).unwrap();
        let mut payload = vec![0u8; 2 + input_bytes.len()];
        payload[0..2].copy_from_slice(&13u16.to_le_bytes()); // command_id = 13 (secureCompute)
        payload[2..2 + input_bytes.len()].copy_from_slice(&input_bytes);

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        assert_eq!(result_bytes[0], 0); // ok = false (denied)

        let error_len = u16::from_le_bytes(result_bytes[8..10].try_into().unwrap()) as usize;
        #[derive(serde::Deserialize)]
        #[allow(dead_code)]
        struct WireError {
            code: String,
            message: String,
        }
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
        let input = SecureComputeInput { a: 6, b: 7 };
        let input_bytes = postcard::to_allocvec(&input).unwrap();
        let mut ok_payload = vec![0u8; 2 + input_bytes.len()];
        ok_payload[0..2].copy_from_slice(&1u16.to_le_bytes());
        ok_payload[2..2 + input_bytes.len()].copy_from_slice(&input_bytes);
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

        let call = |command: &str, args: serde_json::Value| -> serde_json::Value {
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
        };

        // debug build → not frozen
        let state = call("rustraRegistryDemo", serde_json::json!({ "op": "state" }));
        assert_eq!(
            state["result"]["frozen"], false,
            "debug build must be mutable: {state}"
        );

        // 'ping' does not exist yet
        let before = call("ping", serde_json::json!({}));
        assert_eq!(before["ok"], false, "ping should not exist yet: {before}");

        // register at runtime (through the RN FFI path)
        let r = call(
            "rustraRegistryDemo",
            serde_json::json!({ "op": "register" }),
        );
        assert_eq!(r["result"]["message"], "registered 'ping'");
        let ping1 = call("ping", serde_json::json!({}));
        assert_eq!(
            ping1["result"]["pong"], true,
            "registered ping works: {ping1}"
        );

        // replace handler at runtime — same command, different behavior
        call(
            "rustraRegistryDemo",
            serde_json::json!({ "op": "replacePing" }),
        );
        let ping2 = call("ping", serde_json::json!({}));
        assert_eq!(
            ping2["result"]["pong"], false,
            "replaced ping should return pong=false: {ping2}"
        );

        // unregister at runtime — command disappears
        call(
            "rustraRegistryDemo",
            serde_json::json!({ "op": "unregister" }),
        );
        let after = call("ping", serde_json::json!({}));
        assert_eq!(after["ok"], false, "ping gone after unregister: {after}");
    }

    /// Dynamic command with Vec<f64> input, through the RN FFI path.
    #[test]
    #[cfg(debug_assertions)]
    fn test_runtime_registry_vec_input_through_ffi() {
        let _ = calculator_package();

        let call = |command: &str, args: serde_json::Value| -> serde_json::Value {
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
        };

        // register the Vec-input command at runtime
        let r = call(
            "rustraRegistryDemo",
            serde_json::json!({ "op": "registerAvg" }),
        );
        assert_eq!(
            r["result"]["message"],
            "registered 'average' (Vec<f64> input)"
        );

        // variable-length array flows through invoke_json
        let out = call(
            "average",
            serde_json::json!({ "numbers": [10.0, 20.0, 30.0] }),
        );
        assert_eq!(out["ok"], true, "average should succeed: {out}");
        assert_eq!(out["result"]["count"], 3);
        assert!((out["result"]["average"].as_f64().unwrap() - 20.0).abs() < 1e-9);

        // unregister → gone
        call(
            "rustraRegistryDemo",
            serde_json::json!({ "op": "unregisterAvg" }),
        );
        let after = call("average", serde_json::json!({ "numbers": [] }));
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

    /// addNumbers rkyv V2 요청 바이트를 만든다 (command_id 1 고정 — sync 테스트와 동일).
    fn add_request(a: i64, b: i64) -> Vec<u8> {
        let input = postcard::to_allocvec(&AddNumbersInput { a, b }).unwrap();
        let mut req = vec![0u8; 2 + input.len()];
        req[0..2].copy_from_slice(&1u16.to_le_bytes());
        req[2..].copy_from_slice(&input);
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
        let req = add_request(20, 22);

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
        let req = add_request(1, 2);

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
        let req = add_request(2, 3);

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

//! # rustra — Rust → TypeScript bridge framework
//!
//! Rust에서 명령을 한 번 정의하면, Node / Bun / Tauri / React Native 어디서든
//! 동작하는 TypeScript 클라이언트를 자동 생성하는 브릿지 프레임워크입니다.
//!
//! ## 작동 방식
//!
//! ```text
//! Rust #[command] 정의 → TypeScript 클라이언트 자동 생성 → 각 플랫폼 어댑터로 실행
//! ```
//!
//! ## 빠른 예제
//!
//! ```rust
//! use rustra::prelude::*;
//! use serde::{Serialize, Deserialize};
//! use schemars::JsonSchema;
//!
//! #[derive(Debug, Serialize, Deserialize, JsonSchema)]
//! #[serde(rename_all = "camelCase")]
//! struct AddNumbersInput { a: i64, b: i64 }
//!
//! #[derive(Debug, Serialize, Deserialize, JsonSchema)]
//! #[serde(rename_all = "camelCase")]
//! struct AddNumbersOutput { value: i64 }
//!
//! #[command]
//! fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
//!     Ok(AddNumbersOutput { value: input.a + input.b })
//! }
//!
//! fn main() -> Result<()> {
//!     let pkg = Package::builder("example.calculator")
//!         .command_fn(add_numbers)
//!         .build();
//!
//!     let generated = pkg.generate_typescript()?;
//!     println!("{}", generated.types_ts);
//!     Ok(())
//! }
//! ```

/// Rust 구조체/열거형에 rustra 브릿지에 필요한 derive 및 serde 설정을 자동 추가합니다.
///
/// ```rust
/// use rustra::prelude::*;
///
/// #[bridge_type]
/// pub struct MyInput {
///     pub value: i64,
/// }
/// ```
pub use rustra_macros::bridge_type;

/// `#[command]` 함수들을 간결하게 패키지로 빌드하는 매크로입니다.
///
/// ```rust
/// use rustra::prelude::*;
///
/// #[bridge_type]
/// pub struct AddInput { pub a: i64, pub b: i64 }
/// #[bridge_type]
/// pub struct AddOutput { pub value: i64 }
///
/// #[command]
/// fn add(input: AddInput) -> Result<AddOutput> {
///     Ok(AddOutput { value: input.a + input.b })
/// }
///
/// let pkg = rustra::build!("example.calc", add).done();
/// assert_eq!(pkg.id(), "example.calc");
/// ```
pub use rustra_macros::build;

/// 함수를 rustra 명령으로 등록하는 매크로입니다.
///
/// ```rust
/// use rustra::prelude::*;
///
/// #[bridge_type]
/// pub struct GreetInput { pub name: String }
/// #[bridge_type]
/// pub struct GreetOutput { pub message: String }
///
/// #[command]
/// fn greet(input: GreetInput) -> Result<GreetOutput> {
///     Ok(GreetOutput { message: format!("Hello, {}!", input.name) })
/// }
/// ```
pub use rustra_macros::command;

/// 패키지 빌더에 `#[command]` 함수들을 등록하는 매크로입니다.
///
/// ```rust
/// use rustra::prelude::*;
///
/// #[bridge_type]
/// pub struct PingInput { pub msg: String }
/// #[bridge_type]
/// pub struct PingOutput { pub reply: String }
///
/// #[command]
/// fn ping(input: PingInput) -> Result<PingOutput> {
///     Ok(PingOutput { reply: input.msg })
/// }
///
/// let pkg = rustra::register!(Package::builder("example.ping"), ping).build();
/// assert_eq!(pkg.id(), "example.ping");
/// ```
pub use rustra_macros::register;

pub use rkyv_codec::encode_rkyv_v2_error;

pub mod cancel;
pub mod channels;
mod codegen;
mod error;
pub mod events;
mod executor;
pub mod ffi;
pub mod renderer_host;
mod rkyv_codec;
mod schema;
pub mod state;

use schemars::JsonSchema;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

use rkyv_codec::{
    BinHandler, DecodeFn, EncodeFn, Tier, build_rkyv_v2_decoder, build_rkyv_v2_response_encoder,
    build_tier3_json_decoder, is_output_tier3, js_postcard_codec_supported_with_defs,
};

pub use error::{Result, RustraError};
pub use state::{State, get_state, with_state_context};

use codegen::{command_function_name, contract_hash, ts_type_from_schema};
use schema::{command_name_from_handler, schema_value, short_type_name};

/// 자주 사용하는 타입과 매크로를 한 번에 가져올 수 있는 prelude 모듈입니다.
///
/// ```rust
/// use rustra::prelude::*;
/// ```
pub mod prelude {
    pub use crate::{
        GeneratedPackage, Package, PackageBuilder, Result, RustraError, State, bridge_type, build,
        command,
        events::EventSink,
        ffi::FfiFormat,
        register,
        renderer_host::{
            HostMessage, MessageKind, RendererCapabilities, RendererHost, Size, SurfaceOptions,
            host_supports_eval,
        },
        rkyv_codec::encode_rkyv_v2_error,
    };
    pub use schemars::JsonSchema;
    pub use serde::{Deserialize, Serialize};
}

/// `#[command]` 매크로 내부에서 사용하는 비공개 trait 경계입니다.
///
/// 커맨드 핸들러의 입력 타입이 [`DeserializeOwned`] + [`JsonSchema`]를,
/// 출력 타입이 [`Serialize`] + [`JsonSchema`]를 충족하는지
/// 컴파일 타임에 검증하기 위해 사용합니다.
pub mod __private {
    use schemars::JsonSchema;
    use serde::{Serialize, de::DeserializeOwned};

    pub use crate::executor::block_on;

    pub trait CommandInput: DeserializeOwned + JsonSchema + 'static {}
    impl<T: DeserializeOwned + JsonSchema + 'static> CommandInput for T {}

    pub trait CommandOutput: Serialize + JsonSchema + 'static {}
    impl<T: Serialize + JsonSchema + 'static> CommandOutput for T {}
}

/// Tauri 2와의 통합을 위한 헬퍼 모듈입니다.
///
/// `tauri` feature가 활성화되어야 사용할 수 있습니다.
///
/// ## 사용법
///
/// ```rust,ignore
/// use rustra::tauri_support;
///
/// fn main() {
///     let package = build_my_package();
///     let builder = tauri_support::register(package, tauri::Builder::default());
///     builder
///         .run(tauri::generate_context!())
///         .expect("failed to run tauri app");
/// }
/// ```
///
/// 이벤트 푸시가 필요하면 [`register_with_events`] 를 대신 사용한다 —
/// `Package::emit` 이 즉시 `app.emit("rustra://{name}", payload)` 로
/// 전달된다(폴링 불필요).
#[cfg(feature = "tauri")]
pub mod tauri_support {
    use crate::Package;
    use serde_json::{Value, json};
    use std::sync::Arc;
    use tauri::{Emitter, State};

    /// rustra 이벤트 채널의 접두사. 이벤트 `name` 은 `rustra://{name}` 채널로
    /// emit 된다.
    pub const EVENT_CHANNEL_PREFIX: &str = "rustra://";

    /// Tauri의 managed state로 보관되는 rustra 패키지입니다.
    pub struct RustraState {
        /// 등록된 rustra 명령 패키지입니다.
        pub package: Package,
    }

    /// 모든 rustra 커맨드를 디스패치하는 Tauri 커맨드 핸들러입니다.
    #[tauri::command]
    pub fn rustra_dispatch(
        state: State<'_, RustraState>,
        command: String,
        args: Value,
    ) -> Result<Value, Value> {
        state.package.invoke_json(&command, args).map_err(|e| {
            serde_json::to_value(&e)
                .unwrap_or_else(|_| json!({"code": "unknown", "message": "unknown error"}))
        })
    }

    /// rustra 패키지를 Tauri 앱 빌더에 등록합니다.
    ///
    /// 이벤트는 폴링으로만 전달됩니다(기존 동작). 푸시 배선이 필요하면
    /// [`register_with_events`]를 사용하세요.
    pub fn register<R: tauri::Runtime>(
        package: Package,
        builder: tauri::Builder<R>,
    ) -> tauri::Builder<R> {
        builder
            .manage(RustraState { package })
            .invoke_handler(tauri::generate_handler![rustra_dispatch])
    }

    /// [`register`] + 이벤트 푸시 배선 — `Package::emit` 이 즉시
    /// `app.emit("rustra://{name}", payload_json)` 로 전달된다.
    ///
    /// 싱크 설치는 Tauri **플러그인**의 setup 훅에서 일어난다. `tauri::Builder`
    /// 자체의 `.setup()` 은 단일 슬롯이라 우리가 등록하면 호스트가 나중에 자기
    /// `.setup()` 을 붙일 때 우리 훅을 조용히 덮어써버린다 — 플러그인 setup 은
    /// 호스트 setup 과 독립적으로 항상 실행되므로 이 문제가 없다.
    ///
    /// # 채널 네이밍
    ///
    /// 이벤트별 채널: `rustra://{name}` (예: `rustra://llm.stream-token`).
    /// Tauri `listen()` 이 채널 이름으로 필터링하므로 JS 쪽에서 이름 기반
    /// 구독이 한 번에 된다(단일 와일드카드 채널 + JS 측 필터보다 낫다).
    /// Tauri 는 채널 이름에 영숫자/`-`/`/`/`:`/`_` 만 허용하므로 그 외 문자는
    /// [`sanitize_event_name`] 규칙으로 치환한다(예: `a.b` → `a_b`).
    ///
    /// # 페이로드 형태
    ///
    /// 페이로드는 JSON **문자열** 그대로(`emit_str`) 웹뷰로 전달된다 — rustra
    /// 이벤트 페이로드는 이미 JSON 직렬화된 `String` 이므로 이중 직렬화가 없다.
    /// Tauri 웹뷰 경로는 문자열을 JS 소스에 원시 splice 하므로 **JS `listen`
    /// 콜백은 이미 파싱된 객체를 받는다** — `JSON.parse` 불필요. Rust 쪽
    /// `listen` 만 원시 문자열을 본다(헤드리스 테스트가 확인하는 지점).
    ///
    /// # 에러 처리
    ///
    /// `app.emit` 실패는 stderr 에 로그만 남긴다 — 싱크 안에서
    /// 패닉하거나 프로세스를 죽이지 않는다(이벤트 1건 유실).
    pub fn register_with_events<R: tauri::Runtime>(
        package: Package,
        builder: tauri::Builder<R>,
    ) -> tauri::Builder<R> {
        // Package 는 Arc 내부 상태라 clone 이 공유된다 — 플러그인 setup 훅에서
        // 싱크를 설치해도 register 가 manage() 하는 패키지와 동일한 인스턴스다.
        let push_package = package.clone();
        let push_plugin = tauri::plugin::Builder::<R>::new("rustra-events")
            .setup(move |app, _api| {
                push_package.set_event_sink(Some(tauri_event_sink(app.clone())));
                Ok(())
            })
            .build();
        register(package, builder).plugin(push_plugin)
    }

    /// `AppHandle` 로 이벤트를 emit 하는 [`crate::events::EventSink`] 를 만든다.
    ///
    /// `register_with_events` 가 내부적으로 사용하는 것과 동일한 싱크를, 호스트가
    /// 자체 setup 흐름에서 직접 설치할 때 쓸 수 있다(예: 자체 플러그인/명령에서
    /// `app.handle().clone()` 을 이미 들고 있는 경우):
    ///
    /// ```rust,ignore
    /// use rustra::tauri_support::tauri_event_sink;
    ///
    /// tauri::Builder::default()
    ///     .setup(|app| {
    ///         let package = build_my_package();
    ///         package.set_event_sink(Some(tauri_event_sink(app.handle().clone())));
    ///         app.manage(RustraState { package });
    ///         Ok(())
    ///     })
    /// ```
    ///
    /// `AppHandle::emit` 은 내부적으로 스레드 안전이므로 emit 을 호출하는
    /// 어떤 스레드에서도 이 싱크를 안전하게 호출할 수 있다.
    pub fn tauri_event_sink<R: tauri::Runtime>(
        app: tauri::AppHandle<R>,
    ) -> crate::events::EventSink {
        Arc::new(move |name: &str, payload: &str| {
            let channel = event_channel(name);
            if let Err(error) = app.emit_str(&channel, payload.to_string()) {
                eprintln!(
                    "rustra: tauri emit failed on channel '{channel}' (event '{name}'): {error}"
                );
            }
        })
    }

    /// 이벤트 이름 → Tauri 채널 이름 매핑 (`rustra://{sanitized}`).
    ///
    /// Tauri 가 채널 이름에 허용하는 문자는 영숫자, `-`, `/`, `:`, `_` 뿐이다.
    /// 그 외 문자(예: `.`)는 `_` 로 치환한다. 치환 후 충돌 가능성은 문서상
    /// 주의로만 다룬다 — 실제 이벤트 이름은 kebab/dot 구분 없이 rustra 관례
    /// (`progress.tick`) 를 따르므로, 동일 세트에서 충돌하려면 접두사만 다른
    /// 이름(`a.b-c` vs `a.b_c`)을 의도적으로 만들어야 한다.
    pub fn event_channel(name: &str) -> String {
        format!("{EVENT_CHANNEL_PREFIX}{}", sanitize_event_name(name))
    }

    /// Tauri 채널 이름 규칙(영숫자/`-`/`/`/`:`/`_`)으로 이름을 정규화한다.
    fn sanitize_event_name(name: &str) -> String {
        name.chars()
            .map(|c| {
                if c.is_alphanumeric() || matches!(c, '-' | '/' | ':' | '_') {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn event_channel_uses_per_name_rustra_namespace() {
            assert_eq!(
                event_channel("llm.stream-token"),
                "rustra://llm_stream-token"
            );
            assert_eq!(event_channel("progress.tick"), "rustra://progress_tick");
            assert_eq!(event_channel("plain"), "rustra://plain");
            assert_eq!(event_channel("a:b/c-d_e"), "rustra://a:b/c-d_e");
        }

        #[test]
        fn event_channel_sanitizes_characters_tauri_rejects() {
            // Tauri EventName::new 은 영숫자/-,/, :, _ 외 문자를 가진 이름을
            // 에러로 거부한다 — emit 실패(=이벤트 유실)가 되지 않게 미리 치환.
            // (Tauri 검증이 char::is_alphanumeric() 을 쓰므로 한글 등 비ASCII
            // 영숫자는 그대로 통과한다 — 우리 치환 규칙과 동일 기준.)
            assert_eq!(event_channel("has space"), "rustra://has_space");
            assert_eq!(event_channel("a.b c"), "rustra://a_b_c");
            assert_eq!(event_channel("weird!*()"), "rustra://weird____");
        }
    }
}

/// 등록된 명령 집합을 나타내는 불변 패키지입니다.
///
/// [`PackageBuilder`]로 명령을 등록한 후 [`PackageBuilder::build`]로 생성합니다.
/// 내부적으로 `Arc` 기반이므로 저비용으로 복제할 수 있습니다.
///
/// # 수명 주기
///
/// ```text
/// Package::builder("my.pkg") → .command_fn(f1) → .command_fn(f2) → .build() → Package
/// ```
#[derive(Clone)]
pub struct Package {
    id: String,
    /// 명령 레지스트리. 포이즈닝 관용: writer 가 임계구역 안에서 패닉하면
    /// RwLock 이 포이즈닝되지만 내부 BTreeMap 은 구조적으로 유효하다.
    /// `.unwrap()` 이면 이후 모든 invoke 가 패닉하고, FFI 진입점(extern "C")
    /// 경계에서는 프로세스 abort 다 — ffi.rs 이벤트 싱크와 같은
    /// `into_inner()` 관용으로 과거 패닉 이후에도 invoke 가 동작하게 한다.
    state: Arc<RwLock<RegistryState>>,
    frozen: Arc<AtomicBool>,
    /// Rust → JS 이벤트 푸시 상태(버스 + 싱크). `emit()` 으로 발행, 싱크가
    /// 설치되어 있으면 즉시 콜백 호출(버스 우회), 아니면 호스트 어댑터가
    /// `event_bus()` 를 폴링해 플랫폼 푸시 채널로 전달한다.
    events: Arc<events::EventState>,
    /// (이벤트 계약) 선언된 이벤트 이름 → 페이로드 스키마 — schema.json 의
    /// `events` 섹션 소스. build 시점에 빌더에서 복사되어 불변이 된다.
    event_contracts: BTreeMap<String, Value>,
    states: Arc<state::StateMap>,
}

/// `Package`의 가변 내부 상태. `Arc<RwLock<_>>`로 보호되어 런타임 mutation을 지원한다.
struct RegistryState {
    commands: BTreeMap<String, Command>,
    id_to_name: BTreeMap<u16, String>,
    next_command_id: u16,
    /// (성능) command_id → 핸들러 직접 캐시 — `invoke_rkyv_v2` 의 핫패스가
    /// `id_to_name` → `commands` 이중 조회 + Arc 클론을 거치지 않게 한다.
    /// 등록/교체/해제 시점에 함께 유지된다(불변식: 값은 항상 `commands` 의
    /// 동일 명령과 같은 Arc 를 가리킨다).
    id_to_command: BTreeMap<u16, Command>,
    /// Runtime Authority: 부여된 capability 집합. deny-by-default —
    /// `required_capability` 가 `Some` 인 명령은 이 집합에 포함될 때만 실행된다.
    granted_capabilities: BTreeSet<String>,
    /// (T2, OTA) 스키마 협상 버전. `schema()`/`live_schema()` 와 코드젠이
    /// 노출한다 — JS > native 인 stale 조합을 감지하는 데 쓰인다.
    schema_version: u32,
}

impl std::fmt::Debug for Package {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let state = self
            .state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        f.debug_struct("Package")
            .field("id", &self.id)
            .field("frozen", &self.frozen.load(Ordering::Relaxed))
            .field("command_count", &state.commands.len())
            .finish()
    }
}

pub struct PackageBuilder {
    id: String,
    commands: BTreeMap<String, Command>,
    next_command_id: u16,
    /// (T2, OTA) `alias_command_id` 로 선언된 (명령, 구 command_id) 목록.
    /// 선언 시점에 즉시 검증 가능한 충돌은 그 자리에서 패닉시키고,
    /// 나머지는 `build()` 시점에 검증·병합한다.
    id_aliases: Vec<(String, u16)>,
    event_capacity: usize,
    /// (이벤트 계약) 선언된 이벤트 이름 → 페이로드 스키마. schema.json 의
    /// `events` 섹션과 TS 코드젠의 이벤트 타입으로 노출된다.
    events: BTreeMap<String, Value>,
    /// (T2, OTA) 스키마 협상 버전 — 빌드 시점 고정값. `build()` 에서
    /// `RegistryState.schema_version` 로 이동한다.
    schema_version: u32,
    states: state::StateMap,
}

/// TypeScript 코드 생성 결과입니다.
///
/// [`Package::generate_typescript`] 호출로 생성됩니다.
///
/// | 필드 | 출력 파일 | 내용 |
/// |------|----------|------|
/// | `schema_json` | `schema.json` | 전체 명령 스키마 (JSON) |
/// | `types_ts` | `types.ts` | TypeScript 타입 정의 |
/// | `commands_ts` | `commands.ts` | TypeScript 명령 헬퍼 함수 |
/// | `contract_ts` | `contract.ts` | 계약 해시 + 스키마 버전 (무결성/stale 검증용) |
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneratedPackage {
    /// JSON으로 직렬화된 전체 패키지 스키마입니다.
    pub schema_json: String,
    /// 생성된 TypeScript 타입 정의 코드입니다.
    pub types_ts: String,
    /// 생성된 TypeScript 명령 헬퍼 함수 코드입니다.
    pub commands_ts: String,
    /// 스키마의 SHA-256 해시입니다.
    pub contract_hash: String,
    /// `contract.ts` 전체 내용 — `GENERATED_CONTRACT_HASH` 와 (T2, OTA)
    /// `SCHEMA_VERSION` 상수를 함께 노출한다. JS 클라이언트가 이 값을
    /// 네이티브의 `schemaVersion` 과 비교해 JS > native stale 를 감지한다.
    pub contract_ts: String,
}

impl GeneratedPackage {
    /// 생성된 모든 파일을 지정한 디렉토리에 저장합니다.
    ///
    /// 디렉토리가 없으면 생성합니다:
    /// - `schema.json` — 전체 명령 스키마
    /// - `types.ts` — TypeScript 타입 정의
    /// - `commands.ts` — TypeScript 명령 헬퍼 함수
    /// - `contract.ts` — `GENERATED_CONTRACT_HASH`/`SCHEMA_VERSION` 상수
    pub fn write_to_dir(&self, output_dir: impl AsRef<Path>) -> crate::Result<()> {
        let output_dir = output_dir.as_ref();
        fs::create_dir_all(output_dir)?;
        fs::write(output_dir.join("schema.json"), &self.schema_json)?;
        fs::write(output_dir.join("types.ts"), &self.types_ts)?;
        fs::write(output_dir.join("commands.ts"), &self.commands_ts)?;
        fs::write(output_dir.join("contract.ts"), &self.contract_ts)?;
        Ok(())
    }
}

/// 단일 명령의 메타데이터와 핸들러입니다.
///
/// 스키마 필드(`input_schema`/`output_schema`/`definitions`)는 `Arc<Value>` 다 —
/// `invoke` 경로의 재진입 방지 clone-out이 매 호출마다 serde_json 트리 전체를
/// deep copy 하는 것을 포인터 복사로 만든다(스키마는 등록 후 불변이므로 안전).
#[derive(Clone)]
struct Command {
    command_id: u16,
    input_type: String,
    output_type: String,
    input_schema: Arc<Value>,
    output_schema: Arc<Value>,
    definitions: Arc<Value>,
    invoke: Arc<dyn Fn(Value) -> crate::Result<Value> + Send + Sync>,
    /// Fast binary handler: payload[2..] → postcard deserialize → typed handler → postcard serialize
    rkyv_v2_handler: Option<BinHandler>,
    rkyv_v2_decode: DecodeFn,
    rkyv_v2_encode_response: EncodeFn,
    /// true when this command uses Tier 3 (JSON fallback) wire format.
    rkyv_v2_tier3: bool,
    /// Runtime Authority: 이 명령이 요구하는 capability.
    /// `Some(cap)` 면 `cap` 이 `grant_capability` 로 부여되기 전까지 deny-by-default.
    /// `None` 이면 항상 허용 (기본 명령).
    required_capability: Option<&'static str>,
}

impl std::fmt::Debug for Command {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Command")
            .field("command_id", &self.command_id)
            .field("input_type", &self.input_type)
            .field("output_type", &self.output_type)
            .finish()
    }
}

/// 타입 지정 핸들러로부터 `Command`를 생성한다.
///
/// 빌드 시점(`PackageBuilder::command`)과 런타임 등록(`Package::register`)이
/// 동일한 생성 로직을 공유하도록 분리한 helper.
fn build_command<I, O, F>(command_id: u16, handler: F, force_tier3: bool) -> Command
where
    I: DeserializeOwned + JsonSchema + 'static,
    O: Serialize + JsonSchema + 'static,
    F: Fn(I) -> crate::Result<O> + Send + Sync + 'static,
{
    let (input_schema, input_defs) = schema_value::<I>();
    let (output_schema, output_defs) = schema_value::<O>();
    let mut definitions = input_defs;
    if let (Value::Object(obj), Value::Object(other)) = (&mut definitions, output_defs) {
        for (key, value) in other {
            obj.insert(key, value);
        }
    }
    let (rkyv_v2_decoder, input_tier) = build_rkyv_v2_decoder(&input_schema);
    let output_tier3 = is_output_tier3(&output_schema);
    // force_tier3 (런타임 등록된 동적 명령): TS codec 이 없으므로 JSON-in-binary(Tier 3) 강제.
    let is_tier3 = force_tier3 || input_tier == Tier::Tier3 || output_tier3;
    let rkyv_v2_decoder = if force_tier3 || (is_tier3 && input_tier != Tier::Tier3) {
        build_tier3_json_decoder()
    } else {
        rkyv_v2_decoder
    };
    let rkyv_v2_response_encoder = build_rkyv_v2_response_encoder(&output_schema, is_tier3);

    // Wrap handler in Arc so both JSON and binary paths can use it
    let handler = Arc::new(handler);

    // (Tier 3 정합) JS 코드젠(@rustra/cli)이 postcard 코덱을 생성하는 타입 집합과
    // 정합한다 — JS 쪽에서 미지원으로 레지스트리에서 제외된 명령(map 필드 등)은
    // 엔진이 Tier 3(JSON-in-binary) 로 라우팅한다. Rust 가 typed postcard 핸들러를
    // 그대로 켜두면 와이어가 어긋난다(JS 는 JSON 바이트를 보내고 Rust 는 postcard
    // 로 디코딩을 시도). 따라서 JS 코덱 지원 판정을 미러해 미지원 명령의
    // fast-path 를 끄고 JSON 경류(rkyv_v2_decode/encode_response — is_tier3 면
    // JSON-in-binary 프레임)로 통일한다.
    let js_codec_supported = js_postcard_codec_supported_with_defs(&input_schema, &definitions)
        && js_postcard_codec_supported_with_defs(&output_schema, &definitions);

    // Generate fast postcard-based binary handler that bypasses JSON Value.
    // force_tier3 인 경우 postcard fast-path 를 끄고 Tier 3 JSON fallback 로 보낸다.
    let rkyv_v2_handler: Option<BinHandler> = if force_tier3 || !js_codec_supported {
        None
    } else {
        let handler_bin = handler.clone();
        Some(Arc::new(move |payload: &[u8]| {
            if payload.len() < 2 {
                return Err(RustraError::invalid_args("rkyv v2: payload too short"));
            }
            let input: I = postcard::from_bytes(&payload[2..])
                .map_err(|e| RustraError::invalid_args(format!("postcard decode: {e}")))?;
            let output = handler_bin(input)?;
            let out_bytes = postcard::to_allocvec(&output)
                .map_err(|e| RustraError::internal(format!("postcard encode: {e}")))?;
            let mut buf = vec![0u8; 8 + out_bytes.len()];
            buf[0] = 1; // ok = true
            buf[8..8 + out_bytes.len()].copy_from_slice(&out_bytes);
            Ok(buf)
        }))
    };

    Command {
        command_id,
        input_type: short_type_name::<I>(),
        output_type: short_type_name::<O>(),
        input_schema: Arc::new(input_schema),
        output_schema: Arc::new(output_schema),
        definitions: Arc::new(definitions),
        invoke: Arc::new(move |params| {
            let input = serde_json::from_value::<I>(params).map_err(RustraError::invalid_args)?;
            let output = handler(input)?;
            serde_json::to_value(output).map_err(RustraError::internal)
        }),
        rkyv_v2_handler,
        rkyv_v2_decode: rkyv_v2_decoder,
        rkyv_v2_encode_response: rkyv_v2_response_encoder,
        rkyv_v2_tier3: is_tier3,
        required_capability: None,
    }
}

impl Package {
    /// 패키지의 고유 식별자(ID)를 반환합니다.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// 새로운 [`PackageBuilder`]를 생성합니다.
    ///
    /// `id`는 패키지를 식별하는 고유 문자열입니다. 역방향 도메인 표기법을 권장합니다
    /// (예: `"com.example.calculator"`).
    pub fn builder(id: impl Into<String>) -> PackageBuilder {
        PackageBuilder {
            id: id.into(),
            commands: BTreeMap::new(),
            next_command_id: 1,
            id_aliases: Vec::new(),
            event_capacity: 1024,
            events: BTreeMap::new(),
            schema_version: 1,
            states: state::StateMap::new(),
        }
    }

    /// 패키지에 등록된 `State<T>` 인스턴스를 조회합니다.
    pub fn state<T: Send + Sync + 'static>(&self) -> Option<State<T>> {
        let any_arc = self.states.get(&std::any::TypeId::of::<T>())?.clone();
        let concrete_arc = any_arc.downcast::<T>().ok()?;
        Some(State(concrete_arc))
    }

    /// 타입이 지정된 명령을 호출합니다.
    pub fn invoke<I, O>(&self, name: &str, input: I) -> crate::Result<O>
    where
        I: Serialize,
        O: DeserializeOwned,
    {
        let params = serde_json::to_value(input).map_err(RustraError::invalid_args)?;
        let result = self.invoke_json(name, params)?;
        serde_json::from_value(result).map_err(RustraError::internal)
    }

    /// JS 로 푸시할 이벤트를 발행한다.
    ///
    /// 커맨드 핸들러 안에서 호출한다. 페이로드는 `Serialize` 가능한 값이면
    /// 무엇이든 JSON 으로 직렬화된다.
    ///
    /// # 전달 경로 (상호 배타적)
    ///
    /// - [`Package::set_event_sink`] 로 싱크가 설치되어 있으면 **즉시 콜백 호출**.
    ///   이때 이벤트 버스에는 쌓이지 않는다(푸시+폴링 이중 수신 방지).
    /// - 싱크가 없으면 기존대로 [`Package::event_bus`] 큐에 쌓이고, 호스트
    ///   어댑터가 폴링해 플랫폼 푸시 채널(Tauri `emit`, RN `DeviceEventEmitter`)
    ///   로 전달한다.
    ///
    /// ```rust
    /// # use rustra::prelude::*;
    /// # #[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
    /// # #[serde(rename_all = "camelCase")]
    /// # struct ProgressInput { total: i64 }
    /// # #[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
    /// # #[serde(rename_all = "camelCase")]
    /// # struct ProgressOutput { done: bool }
    /// #[command]
    /// fn start_work(input: ProgressInput) -> Result<ProgressOutput> {
    ///     let pkg = current_package(); // 어댑터가 주입한 핸들
    ///     for i in 0..input.total {
    ///         pkg.emit("progress.tick", serde_json::json!({ "value": i }));
    ///     }
    ///     Ok(ProgressOutput { done: true })
    /// }
    /// # fn current_package() -> rustra::Package { unimplemented!() }
    /// ```
    pub fn emit<E: Serialize>(&self, event: impl Into<String>, payload: E) {
        let name = event.into();
        let json = serde_json::to_string(&payload).unwrap_or_else(|e| {
            // 직렬화 불가 페이로드를 조용히 빈 JSON 로 보내던 폴백 — 최소한 stderr
            // 경고를 남겨 스트리밍 유즈케이스에서 유실이 관측되게 한다.
            eprintln!("rustra: event '{name}' payload failed to serialize: {e}");
            "{}".to_string()
        });
        if self.events.deliver_via_sink(&name, &json) {
            return; // 싱크 경로 — 버스 우회 (이중 전달 방지)
        }
        self.events.bus.emit(name, json);
    }

    /// 푸시 전달 [`events::EventSink`] 를 설치/교체/해제한다.
    ///
    /// 빌드 이후 언제든 호출 가능하다(`Package` 는 `Arc` 내부 상태를 공유하므로
    /// clone 에서 설정해도 원본을 포함한 모든 clone 에 적용된다).
    /// `Some(sink)` 를 넘기면 이후 `emit` 은 싱크를 즉시 호출하고 **이벤트 버스에
    /// 쌓지 않는다** — 폴링(`take_pending_events`)과 푸시를 동시에 쓰는 호스트에서
    /// 같은 이벤트가 두 번 수신되는 것을 방지하는 계약이다. `None` 을 넘기면
    /// 즉시 폴링 경로로 돌아간다(버스 용량/drop-oldest 정책도 그대로).
    ///
    /// 싱크 콜백은 `emit` 을 호출한 스레드에서 실행되며, 패닉하면 stderr 에
    /// 로그만 남고 `emit` 은 정상 복귀한다(자세한 계약은 [`events::EventSink`]).
    ///
    /// ```rust
    /// # use rustra::prelude::*;
    /// # use std::sync::{Arc, Mutex};
    /// let pkg = Package::builder("example.stream").build();
    /// let seen = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
    /// let sink_seen = Arc::clone(&seen);
    /// pkg.set_event_sink(Some(Arc::new(move |name: &str, payload: &str| {
    ///     sink_seen.lock().unwrap().push((name.to_string(), payload.to_string()));
    /// })));
    /// pkg.emit("tick", serde_json::json!({ "value": 1 }));
    /// assert_eq!(seen.lock().unwrap().len(), 1);
    /// assert!(pkg.event_bus().take_pending_events().is_empty()); // 버스 우회
    /// pkg.set_event_sink(None);
    /// pkg.emit("tick", serde_json::json!({ "value": 2 }));
    /// assert_eq!(pkg.event_bus().take_pending_events().len(), 1); // 폴링 복귀
    /// ```
    /// # 동시성
    ///
    /// 설정/해제 시점(부트스트랩·종료) 호출을 전제로 한다. 교체 직후 진행 중이던
    /// `emit` 은 이전 경로(구 싱크 또는 버스)로 전달될 수 있으나, 이벤트별
    /// 정확히 한 번 전달은 항상 유지된다.
    pub fn set_event_sink(&self, sink: Option<events::EventSink>) {
        *self
            .events
            .sink
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = sink;
    }

    /// 이벤트 버스에 대한 접근자 — 호스트 어댑터 폴링용.
    ///
    /// 반환된 [`events::EventBus`]는 `Arc` 공유 클론이므로 어댑터에 저장해
    /// 자유롭게 폴링(`take_pending_events`)할 수 있다. 싱크가 설치된 동안에는
    /// `emit` 이 버스를 건너뛰므로 큐가 비어 있다.
    pub fn event_bus(&self) -> &events::EventBus {
        &self.events.bus
    }

    /// JSON [`Value`]를 직접 전달하여 명령을 호출합니다.
    ///
    /// [`invoke`](Package::invoke)의 비제네릭 버전으로, JSON 기반 라우팅에 사용됩니다.
    pub fn invoke_json(&self, name: &str, params: Value) -> crate::Result<Value> {
        // 핸들러 실행 중에는 잠금을 hold 하지 않도록 Command를 clone-out 한다.
        // (재진입 — 핸들러가 다시 register/unregister 호출 — 시 교착 방지)
        let command = {
            let state = self
                .state
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state
                .commands
                .get(name)
                .ok_or_else(|| RustraError::command_not_found(name))?
                .clone()
        };
        // Runtime Authority: deny-by-default — capability 가 요구되는데 부여되지
        // 않았으면 핸들러를 호출하지 않고 capability.denied 를 반환한다.
        self.capability_satisfied(&command)?;
        with_state_context(&self.states, || (command.invoke)(params))
    }

    /// command_id로 명령 이름을 조회합니다.
    pub fn resolve_command_id(&self, id: u16) -> Option<String> {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .id_to_name
            .get(&id)
            .cloned()
    }

    /// rkyv V2 바이너리 페이로드를 받아 명령을 실행합니다.
    ///
    /// 처음 2바이트에서 command_id를 읽고, 등록된 rkyv_v2_decoder로
    /// 입력 필드를 읽어 JSON Value로 재구성한 뒤 invoke_json으로 전달합니다.
    /// 결과는 rkyv_v2_encode_response로 바이너리로 인코딩하여 반환합니다.
    ///
    /// Tier 1/2 commands require at least 8 bytes (fixed header).
    /// Tier 3 commands require at least 2 bytes (command_id only, rest is JSON).
    ///
    /// 크기 게이트(구현 완료) — JSON/postcard FFI 경로와 동일한 동적 한도
    /// ([`ffi::max_payload_bytes`]) 를 초과하면 `payload.too_large` 를 반환한다.
    /// 소비 크레이트 FFI(calculator/template)와 C++ typed fast path 가 모두
    /// 이 함수를 통과하므로 여기가 rkyv V2 와이어의 단일 검사 지점이다.
    /// typed(tier 1) 경로는 JS 인코딩이 없어 JS 사전 검사를 건너뛰므로,
    /// 이 게이트가 "네이티브 한도가 그대로 적용된다" 계약을 실제로 만족시킨다.
    pub fn invoke_rkyv_v2(&self, payload: &[u8]) -> crate::Result<Vec<u8>> {
        if payload.len() < 2 {
            return Err(RustraError::invalid_args("rkyv v2: payload too short"));
        }
        let limit = crate::ffi::max_payload_bytes();
        if payload.len() > limit {
            return Err(RustraError::payload_too_large(payload.len(), limit));
        }
        let command_id = u16::from_le_bytes([payload[0], payload[1]]);
        let command = {
            let state = self
                .state
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            // 단일 조회 — 과거 id_to_name → commands 이중 조회 + Arc 클론을
            // id_to_command 직접 캐시로 대체했다(등록/교체/해제 시 함께 유지됨).
            state
                .id_to_command
                .get(&command_id)
                .ok_or_else(|| RustraError::command_not_found(format!("id:{command_id}")))?
                .clone()
        };
        // Runtime Authority: deny-by-default — capability 가 요구되는데 부여되지
        // 않았으면 바이너리 핸들러(또는 JSON fallback)를 호출하지 않고
        // capability.denied 를 반환한다. 에러는 rkyv V2 error wire 로 인코딩되어
        // JS RustraCommandError("capability.denied") 로 재구성된다.
        self.capability_satisfied(&command)?;

        // panic guard — 이 디스패치는 FFI 진입점(extern "C", nounwind) 에서 직접
        // 호출된다. 핸들러 패닉이 그대로 unwinding 하면 경계에서 프로세스 abort 다
        // (RN 호스트 크래시). JSON/postcard FFI 의 `ffi::with_panic_guard` 와 동일한
        // 계약으로, 패닉을 `internal` 에러로 정규화해 rkyv V2 에러 프레임으로 반환한다.
        // AssertUnwindSafe: 클로저가 캡처한 값(command/payload) 은 패닉 후 다시
        // 사용되지 않는다 — 결과만 반환한다.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            with_state_context(&self.states, || {
                // Fast path: use typed postcard binary handler (bypasses JSON Value entirely)
                if let Some(ref handler) = command.rkyv_v2_handler {
                    return handler(payload);
                }

                // Fallback: legacy JSON-based path for commands without binary handler
                if !command.rkyv_v2_tier3 && payload.len() < 8 {
                    return Err(RustraError::invalid_args("rkyv v2: payload too short"));
                }

                let params = (command.rkyv_v2_decode)(payload)?;
                let result = (command.invoke)(params)?;
                Ok((command.rkyv_v2_encode_response)(&result))
            })
        }));
        match outcome {
            Ok(result) => result,
            Err(panic) => Err(RustraError::internal(format!(
                "panic in handler: {}",
                crate::ffi::panic_message(&panic)
            ))),
        }
    }

    /// 런타임 mutation을 영구적으로 비활성화한다.
    ///
    /// release 빌드에서는 `build()` 시점에 이미 동결되어 있다. debug 빌드에서
    /// prod 동작을 시뮬레이션하거나 런타임에 명시적으로 잠그고 싶을 때 사용한다.
    /// 한 번 동결하면 해제할 수 없다.
    pub fn freeze(&self) {
        self.frozen.store(true, Ordering::Release);
    }

    /// 패키지가 동결되어 런타임 mutation이 불가능한지 여부.
    pub fn is_frozen(&self) -> bool {
        self.frozen.load(Ordering::Acquire)
    }

    fn ensure_mutable(&self) -> crate::Result<()> {
        if self.is_frozen() {
            Err(RustraError::custom(
                "registry.frozen",
                "package is frozen; runtime mutation disabled",
            ))
        } else {
            Ok(())
        }
    }

    /// Runtime Authority: capability 를 부여한다 (deny-by-default 해제).
    ///
    /// `required_capability` 가 `Some(cap)` 인 명령은 `cap` 이 부여되기 전까지
    /// `capability.denied` 로 거부된다 — 핸들러는 아예 호출되지 않는다. 이 메서드로
    /// `cap` 을 granted 집합에 추가하면 이후 해당 명령이 허용된다.
    ///
    /// 동결(freeze)은 레지스트리 **구조** mutation(register/unregister/replace)에만
    /// 적용된다 — grant는 런타임 권한 부여이므로 동결과 무관하게 허용한다. 그렇지
    /// 않으면 release 빌드(`build()` 시점 동결)에서 권한을 부여할 방법이 없어
    /// deny-by-default 가 deny-forever 가 된다.
    pub fn grant_capability(&self, cap: &str) -> crate::Result<()> {
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.granted_capabilities.insert(cap.to_string());
        Ok(())
    }

    /// `cap` 이 현재 부여되어 있는지 (읽기 전용, 동결 무관).
    pub fn has_capability(&self, cap: &str) -> bool {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .granted_capabilities
            .contains(cap)
    }

    /// `command` 가 요구하는 capability 가 현재 부여되어 있는지 검사한다.
    /// capability 가 `None` 이면 항상 허용.
    fn capability_satisfied(&self, command: &Command) -> crate::Result<()> {
        if let Some(required) = command.required_capability {
            let granted = self
                .state
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .granted_capabilities
                .contains(required);
            if !granted {
                return Err(RustraError::capability_denied(format!(
                    "command requires capability '{required}' which was not granted"
                )));
            }
        }
        Ok(())
    }

    /// 런타임에 명령을 등록한다.
    ///
    /// 같은 이름이 이미 존재하면 핸들러를 덮어쓴다. 이때 기존 `command_id`가 유지되어
    /// 바이너리 경로의 기존 호출자가 그대로 동작한다. 동결 상태면 `registry.frozen`,
    /// `command_id` 공간이 소진되면 `registry.id_exhausted` 에러를 반환한다.
    pub fn register<I, O, F>(&self, name: &str, handler: F) -> crate::Result<()>
    where
        I: DeserializeOwned + JsonSchema + 'static,
        O: Serialize + JsonSchema + 'static,
        F: Fn(I) -> crate::Result<O> + Send + Sync + 'static,
    {
        self.ensure_mutable()?;
        let name = name.to_string();
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // 같은 이름이면 기존 command_id 재사용(stable id). 새 이름이면 단조 증가 ID 할당.
        let command_id = match state.commands.get(&name).map(|c| c.command_id) {
            Some(existing) => existing,
            None => {
                let id = state.next_command_id;
                // u16::MAX 는 exhausted sentinel 로 예약 (할당 불가).
                if id == u16::MAX {
                    return Err(RustraError::custom(
                        "registry.id_exhausted",
                        "command_id u16 space exhausted (max 65534 commands)",
                    ));
                }
                state.next_command_id = id + 1;
                id
            }
        };
        let command = build_command::<I, O, F>(command_id, handler, true);
        state.id_to_command.insert(command_id, command.clone());
        state.commands.insert(name.clone(), command);
        state.id_to_name.insert(command_id, name);
        Ok(())
    }

    /// `#[command]` 함수를 이름 자동 추론으로 런타임 등록한다.
    pub fn register_fn<I, O, F>(&self, handler: F) -> crate::Result<()>
    where
        I: DeserializeOwned + JsonSchema + 'static,
        O: Serialize + JsonSchema + 'static,
        F: Fn(I) -> crate::Result<O> + Send + Sync + 'static,
    {
        let name = command_name_from_handler::<F>();
        self.register::<I, O, F>(&name, handler)
    }

    /// 기존 명령의 핸들러를 교체한다. 이름이 없으면 `command.not_found`.
    /// `command_id`는 유지된다. 동결 상태면 `registry.frozen`.
    pub fn replace<I, O, F>(&self, name: &str, handler: F) -> crate::Result<()>
    where
        I: DeserializeOwned + JsonSchema + 'static,
        O: Serialize + JsonSchema + 'static,
        F: Fn(I) -> crate::Result<O> + Send + Sync + 'static,
    {
        self.ensure_mutable()?;
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let existing = state
            .commands
            .get(name)
            .ok_or_else(|| RustraError::command_not_found(name))?;
        let command_id = existing.command_id;
        let required_capability = existing.required_capability;
        let mut command = build_command::<I, O, F>(command_id, handler, false);
        command.required_capability = required_capability;
        state.id_to_command.insert(command_id, command.clone());
        state.commands.insert(name.to_string(), command);
        Ok(())
    }

    /// 명령을 제거한다. `command_id`는 retired 되어 **재사용되지 않는다**.
    /// 이름이 없으면 `command.not_found`. 동결 상태면 `registry.frozen`.
    /// (T2, OTA) 그 명령을 가리키던 alias id 항목도 함께 제거된다.
    pub fn unregister(&self, name: &str) -> crate::Result<()> {
        self.ensure_mutable()?;
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.commands.remove(name).is_none() {
            return Err(RustraError::command_not_found(name));
        }
        // 실제 id 와 그 명령을 가리키던 alias id 를 모두 정리 — alias 만
        // 남으면 stale 라우팅 항목이 된다.
        let removed_ids: Vec<u16> = state
            .id_to_name
            .iter()
            .filter(|(_, target)| target.as_str() == name)
            .map(|(id, _)| *id)
            .collect();
        state.id_to_name.retain(|_, target| target != name);
        for id in removed_ids {
            state.id_to_command.remove(&id);
        }
        // NOTE: next_command_id는 감소시키지 않는다 — retired id는 영원히 재사용 금지.
        Ok(())
    }

    /// 현재 등록된 모든 명령의 라이브 스키마를 반환한다 (정적 + 동적).
    ///
    /// 읽기 전용이므로 debug/release 모두에서 사용 가능. `rustra_ffi_get_schema` 의 기반이 된다.
    pub fn live_schema(&self) -> Value {
        let state = self
            .state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Self::schema(&self.id, &state, &self.event_contracts)
    }

    /// 등록된 모든 명령에서 TypeScript 클라이언트 코드를 생성합니다.
    pub fn generate_typescript(&self) -> crate::Result<GeneratedPackage> {
        let state = self
            .state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let schema_json =
            serde_json::to_string_pretty(&Self::schema(&self.id, &state, &self.event_contracts))
                .map_err(RustraError::internal)?;
        let contract_hash = contract_hash(&schema_json);
        let types_ts = Self::generate_types_ts(&state);
        let commands_ts = Self::generate_commands_ts(&state);

        Ok(GeneratedPackage {
            contract_ts: format!(
                "export const GENERATED_CONTRACT_HASH = '{contract_hash}';\n\
                 export const SCHEMA_VERSION = {};\n",
                state.schema_version
            ),
            schema_json,
            types_ts,
            commands_ts,
            contract_hash,
        })
    }

    fn schema(id: &str, state: &RegistryState, event_contracts: &BTreeMap<String, Value>) -> Value {
        let commands = state
            .commands
            .iter()
            .map(|(name, command)| {
                let mut entry = json!({
                    "name": name,
                    "commandId": command.command_id,
                    "inputType": command.input_type,
                    "outputType": command.output_type,
                    "inputSchema": &*command.input_schema,
                    "outputSchema": &*command.output_schema,
                });
                // Include definitions if non-empty (for $ref resolution)
                #[allow(clippy::collapsible_if)]
                if let Value::Object(defs) = &*command.definitions {
                    if !defs.is_empty() {
                        entry
                            .as_object_mut()
                            .unwrap()
                            .insert("definitions".into(), (*command.definitions).clone());
                    }
                }
                entry
            })
            .collect::<Vec<_>>();

        // (이벤트 계약) 선언된 이벤트가 있을 때만 events 섹션을 만든다 — 없으면
        // 기존 schema.json 형태와 바이트 단위로 동일(하위호환).
        let mut root = json!({
            "packageId": id,
            "schemaVersion": state.schema_version,
            "commands": commands,
        });
        if !event_contracts.is_empty() {
            let events: Vec<Value> = event_contracts
                .iter()
                .map(|(name, contract)| {
                    json!({ "name": name, "payload": &contract["payload"], "definitions": &contract["definitions"] })
                })
                .collect();
            root.as_object_mut()
                .expect("root is an object")
                .insert("events".into(), json!(events));
        }
        root
    }

    fn generate_types_ts(state: &RegistryState) -> String {
        let mut output = String::from(
            "export type { EngineClient, RustraError } from '@rustra/types';\n\
             export { RustraCommandError } from '@rustra/types';\n\n",
        );

        let mut all_definitions = serde_json::Map::new();
        for command in state.commands.values() {
            if let Value::Object(defs) = &*command.definitions {
                for (key, value) in defs {
                    all_definitions.insert(key.clone(), value.clone());
                }
            }
        }
        let definitions = Value::Object(all_definitions);

        let mut emitted = BTreeSet::new();
        if let Value::Object(def_map) = &definitions {
            for (name, def_schema) in def_map {
                if emitted.insert(name.clone()) {
                    if let Some(desc) = def_schema.get("description").and_then(Value::as_str) {
                        output.push_str(&format!("/**\n * {}\n */\n", desc.replace('\n', "\n * ")));
                    }
                    output.push_str(&format!(
                        "export type {name} = {};\n\n",
                        ts_type_from_schema(def_schema, &definitions)
                    ));
                }
            }
        }

        for command in state.commands.values() {
            if command.input_type != "()" && emitted.insert(command.input_type.clone()) {
                if let Some(desc) = command
                    .input_schema
                    .get("description")
                    .and_then(Value::as_str)
                {
                    output.push_str(&format!("/**\n * {}\n */\n", desc.replace('\n', "\n * ")));
                }
                output.push_str(&format!(
                    "export type {} = {};\n\n",
                    command.input_type,
                    ts_type_from_schema(&command.input_schema, &definitions)
                ));
            }
            if command.output_type != "()" && emitted.insert(command.output_type.clone()) {
                if let Some(desc) = command
                    .output_schema
                    .get("description")
                    .and_then(Value::as_str)
                {
                    output.push_str(&format!("/**\n * {}\n */\n", desc.replace('\n', "\n * ")));
                }
                output.push_str(&format!(
                    "export type {} = {};\n\n",
                    command.output_type,
                    ts_type_from_schema(&command.output_schema, &definitions)
                ));
            }
        }

        output
    }

    fn generate_commands_ts(state: &RegistryState) -> String {
        // Tauri-like 글로벌 invoke 패턴: `configure()`로 설정한 엔진을
        // `invoke()`가 사용하므로 명령 함수는 engine 파라미터를 받지 않는다.
        let mut type_names = BTreeSet::new();
        for command in state.commands.values() {
            if command.input_type != "()" {
                type_names.insert(command.input_type.clone());
            }
            if command.output_type != "()" {
                type_names.insert(command.output_type.clone());
            }
        }

        let imports = type_names.into_iter().collect::<Vec<_>>().join(", ");
        let mut output = String::new();
        if !imports.is_empty() {
            output.push_str(&format!("import type {{ {imports} }} from './types.js';\n"));
        }
        output.push_str("import { invokeGenerated } from '@rustra/types';\n");
        output.push_str("import type { InvokeOptions } from '@rustra/types';\n\n");

        for (name, command) in state.commands.iter() {
            let out_type = if command.output_type == "()" {
                "void"
            } else {
                &command.output_type
            };
            if let Some(desc) = command
                .input_schema
                .get("description")
                .and_then(Value::as_str)
            {
                output.push_str(&format!("/**\n * {}\n */\n", desc.replace('\n', "\n * ")));
            }
            if command.input_type == "()" {
                output.push_str(&format!(
                    "export function {}(options?: InvokeOptions): Promise<{}> {{\n  return invokeGenerated<{}>({}, '{}', undefined, options);\n}}\n{}.commandId = '{}';\n\n",
                    command_function_name(name),
                    out_type,
                    out_type,
                    command.command_id,
                    name,
                    command_function_name(name),
                    name,
                ));
            } else {
                output.push_str(&format!(
                    "export function {}(input: {}, options?: InvokeOptions): Promise<{}> {{\n  return invokeGenerated<{}>({}, '{}', input, options);\n}}\n{}.commandId = '{}';\n\n",
                    command_function_name(name),
                    command.input_type,
                    out_type,
                    out_type,
                    command.command_id,
                    name,
                    command_function_name(name),
                    name,
                ));
            }
        }

        output
    }
}

impl PackageBuilder {
    /// `#[command]` 속성으로 정의된 함수를 이름 자동 추론으로 등록합니다.
    ///
    /// 함수 이름에서 `_command` 접미사를 제거한 뒤 lowerCamelCase로 변환하여
    /// 명령 이름으로 사용합니다. 예: `add_numbers` → `addNumbers`
    pub fn command_fn<I, O, F>(self, handler: F) -> Self
    where
        I: DeserializeOwned + JsonSchema + 'static,
        O: Serialize + JsonSchema + 'static,
        F: Fn(I) -> crate::Result<O> + Send + Sync + 'static,
    {
        let name = command_name_from_handler::<F>();
        self.command(name, handler)
    }

    /// 명령을 지정한 이름으로 등록합니다.
    ///
    /// # 패닉
    ///
    /// 같은 이름의 명령이 이미 등록되어 있으면 패닉합니다.
    pub fn command<I, O, F>(mut self, name: impl Into<String>, handler: F) -> Self
    where
        I: DeserializeOwned + JsonSchema + 'static,
        O: Serialize + JsonSchema + 'static,
        F: Fn(I) -> crate::Result<O> + Send + Sync + 'static,
    {
        let name = name.into();
        if self.commands.contains_key(&name) {
            panic!("duplicate command registration: '{name}'");
        }
        let command = build_command::<I, O, F>(self.next_command_id, handler, false);
        self.commands.insert(name, command);
        self.next_command_id += 1;
        self
    }

    /// Runtime Authority: 이미 등록된 명령에 capability 요구를 부여한다.
    ///
    /// `name` 명령은 `cap` 가 `Package::grant_capability` 로 부여되기 전까지
    /// deny-by-default 로 실행 거부된다. 빌더 체인에서 `.command(...)` 이후
    /// `.build()` 이전에 호출한다.
    ///
    /// # 패닉
    ///
    /// `name` 이 등록되어 있지 않으면 패닉한다.
    pub fn require_capability(mut self, name: &str, cap: &'static str) -> Self {
        let command = self
            .commands
            .get_mut(name)
            .unwrap_or_else(|| panic!("require_capability: command '{name}' not registered"));
        command.required_capability = Some(cap);
        self
    }

    /// `#[command(capability = "...")]` 메타 상수를 받아 조건부 require 로 이어
    /// 붙인다 — `register!`/`build!` 매크로가 사용한다.
    ///
    /// `cap: Option<&'static str>` 이 `Some` 이면 [`require_capability`](Self::require_capability)
    /// 와 동일하게 동작하고, `None` 이면 아무 일도 하지 않는다(메타 상수는 매크로가
    /// 항상 생성하므로 capability 없는 명령도 그대로 통과한다). 문자열 이름 재결합을
    /// 매크로가 파생한 심벌 쌍으로 대체해, 오타가 났다면 **컴파일** 에러로 드러난다.
    pub fn require_capability_if(mut self, name: &str, cap: Option<&'static str>) -> Self {
        if let Some(cap) = cap {
            let command = self
                .commands
                .get_mut(name)
                .unwrap_or_else(|| panic!("require_capability: command '{name}' not registered"));
            command.required_capability = Some(cap);
        }
        self
    }

    /// (T2, OTA) 구 클라이언트의 command_id 를 현재 명령에 alias 로 수용한다.
    ///
    /// JS 번들만 OTA 갱신되는 배포에서 **구 JS + 신 네이티브** 조합이 발생한다.
    /// rkyv V2 와이어에는 command_id 만 있으므로(이름 없음), 신 네이티브가
    /// 구 코드젠이 구운 id 를 alias 로 수용하는 것이 호환을 유지하는 유일한
    /// 경로다. alias 는 **부가적 라우팅 항목**이다 — 대상 명령의 실제
    /// command_id(신 클라이언트 코드젠이 굽는 값)는 그대로 두고, 구 id 가
    /// `id_to_name` 에서 같은 명령을 가리키게 한다.
    ///
    /// 대상 명령은 이 호출 시점에 등록되어 있어도 되고, 이후 `.command()` 로
    /// 등록될 예정이어도 된다(선언 순서 자유). 검증은 두 시점에 나뉜다:
    ///
    /// **선언 시점 즉시 패닉** — (a) 같은 alias id 를 다른 명령에 이미
    /// 선언함, (b) 같은 명령에 같은 alias id 를 중복 선언함(단순 유지를 위해
    /// 전부 거부), (c) 대상 명령이 이미 등록된 상태에서 그 id 가 **다른
    /// 등록된 명령의 실제 command_id** 인 경우 — 이 마지막은 조용한
    /// 섀도잉(구 id 가 엉뚱한 명령에 디스패치)이므로 그 자리에서 거부한다.
    ///
    /// **`build()` 시점 패닉** — (d) 대상 명령이 끝내 등록되지 않음.
    ///
    /// 대상이 아직 등록되지 않은 전방 선언에서 그 id 를 다른 명령이 점유하게
    /// 되면(스키마 성장으로 id 가 밀린 OTA 시나리오), `build()` 가 점유
    /// 명령을 fresh id 로 밀어내고 구 id 를 alias 항목으로 채운다 — 점유
    /// 명령은 신 규칙(삽입)이므로 아무도 그 id 를 알지 못하고, 이동이 안전하다.
    ///
    /// 선언 순서 관례: 성장 시나리오(신규 명령 삽입)에서는 alias 를 command
    /// 등록보다 먼저 선언한다 — 이후 선언 시 선언 시점 검증이 즉시 패닉한다.
    pub fn alias_command_id(mut self, command: &str, legacy_id: u16) -> Self {
        for (existing_cmd, existing_id) in &self.id_aliases {
            if *existing_id != legacy_id {
                continue;
            }
            if existing_cmd != command {
                panic!(
                    "alias_command_id: legacy id {legacy_id} is already aliased to \
                     '{existing_cmd}'; cannot also alias it to '{command}'"
                );
            }
            panic!("alias_command_id: duplicate alias id {legacy_id} for command '{command}'");
        }
        // 대상이 이미 등록된 상태라면, legacy_id 가 다른 등록된 명령의 실제
        // command_id 인지 지금 확인할 수 있다 — 확인 가능한 충돌은 조기 패닉.
        if self.commands.contains_key(command)
            && let Some((occupant, _)) = self
                .commands
                .iter()
                .find(|(_, cmd)| cmd.command_id == legacy_id)
            && occupant.as_str() != command
        {
            panic!(
                "alias_command_id: legacy id {legacy_id} is the real command_id of \
                 '{occupant}'; aliasing it to '{command}' would shadow '{occupant}'"
            );
        }
        self.id_aliases.push((command.to_string(), legacy_id));
        self
    }

    /// 이벤트 버스 큐의 최대 수용량을 설정합니다 (기본값: 1024).
    pub fn event_capacity(mut self, capacity: usize) -> Self {
        self.event_capacity = capacity.max(1);
        self
    }

    /// (이벤트 계약) `Package::emit` 으로 발행될 이벤트를 타입과 함께 선언한다.
    ///
    /// 선언된 이벤트는 schema.json 의 최상위 `events` 섹션에 이름/페이로드
    /// 스키마로 기록되고, TS 코드젠(@rustra/cli)이 이벤트 타입과 구독 헬퍼를
    /// 생성한다 — 커맨드와 동일한 "한 번 정의하면 어디서든 타입 안전" 계약을
    /// 이벤트에도 적용하는 진입점이다. 선언하지 않은 이벤트도 emit 은 가능하다
    /// (하위호환) — 코드젠 산출물에 타입이 없을 뿐이다.
    ///
    /// ```rust
    /// # use rustra::prelude::*;
    /// # #[derive(Debug, Serialize, Deserialize, JsonSchema)]
    /// # #[serde(rename_all = "camelCase")]
    /// # struct ProgressPayload { pub value: i64 }
    /// let pkg = Package::builder("example.stream")
    ///     .event::<ProgressPayload>("progress.tick")
    ///     .build();
    /// // emit("progress.tick", ProgressPayload { value: 1 }) 의 페이로드 타입이
    /// // schema.json/TS 코드젠에 노출된다.
    /// # let _ = pkg;
    /// ```
    pub fn event<E: JsonSchema>(mut self, name: &str) -> Self {
        let (schema, defs) = schema_value::<E>();
        self.events.insert(
            name.to_string(),
            json!({ "payload": schema, "definitions": defs }),
        );
        self
    }

    /// (T2, OTA) 스키마 버전 — 구 JS 클라이언트의 stale 감지에 사용된다.
    /// 코드젠이 SCHEMA_VERSION 으로 노출하고, 엔진이 live schema 의 버전과
    /// 비교해 JS > native 인 경우 경고한다. 기본 1.
    pub fn schema_version(mut self, version: u32) -> Self {
        self.schema_version = version;
        self
    }

    /// 공유 상태를 패키지에 등록합니다.
    ///
    /// 등록된 상태는 `State<T>` 파라미터를 받는 `#[command]` 핸들러에
    /// 자동으로 주입됩니다.
    pub fn manage<T: Send + Sync + 'static>(mut self, state: T) -> Self {
        self.states
            .insert(std::any::TypeId::of::<T>(), Arc::new(state));
        self
    }

    /// 등록된 모든 명령을 불변 [`Package`]로 빌드합니다.
    pub fn build(self) -> Package {
        let mut commands = self.commands;
        let mut next_command_id = self.next_command_id;

        // ── (T2, OTA) alias 병합 ────────────────────────────
        // alias 는 id_to_name 의 부가 라우팅 항목이다 — 대상 명령의 실제
        // command_id 는 그대로다. 대상 미등록은 패닉(선언 시점 검증은
        // alias_command_id 참조). 전방 선언된 alias 의 구 id 를 다른 명령이
        // 실제 id 로 점유 중이면(스키마 성장 시나리오) 점유 명령을 fresh id 로
        // 이동시킨다 — 조용한 섀도잉은 엉뚱한 명령 실행 버그이므로.
        let mut alias_id_to_name: BTreeMap<u16, String> = BTreeMap::new();
        for (command, legacy_id) in &self.id_aliases {
            if !commands.contains_key(command) {
                panic!(
                    "alias_command_id: target command '{command}' is not registered \
                     (aliases: {:#?})",
                    self.id_aliases
                );
            }
            alias_id_to_name.insert(*legacy_id, command.clone());
        }
        // fresh id 와 런타임 register 모두가 alias id 를 할당해 조용히 덮어쓰지
        // 못하게 next_command_id 를 **모든** alias id 너머로 먼저 밀어둔다.
        // 이 순서가 핵심이다: alias id 는 구 스키마 기준이라 현재 명령 수보다
        // 클 수 있다(구 명령이 제거된 경우) — displacement 의 fresh id 를
        // alias 병합 이후의 next_command_id 로 할당하면 이미 병합된 alias 항목
        // 위에 정확히 덜어져 silent misrouting 이 된다(리뷰 지적 회귀).
        if let Some(&max_alias) = alias_id_to_name.keys().next_back() {
            // u16::MAX 는 exhausted sentinel — alias 가 그 근처면 이후
            // 런타임 register 는 기존처럼 registry.id_exhausted 로 거부된다.
            next_command_id = next_command_id.max(max_alias.saturating_add(1));
        }
        for (command, legacy_id) in &self.id_aliases {
            // 점유 충돌 해소: legacy_id 가 다른 명령의 실제 id 면 그 명령을
            // fresh id 로 이동. 선언 시점에 등록돼 있던 충돌은 alias_command_id
            // 가 이미 패닉시켰으므로, 여기 오는 전방 선언 케이스만 남는다.
            if let Some((occupant, _)) = commands
                .iter()
                .find(|(name, cmd)| cmd.command_id == *legacy_id && name.as_str() != command)
            {
                let occupant = occupant.clone();
                let fresh = next_command_id;
                next_command_id += 1;
                commands
                    .get_mut(&occupant)
                    .expect("occupant verified above")
                    .command_id = fresh;
            }
        }

        let mut id_to_name: BTreeMap<u16, String> = alias_id_to_name;
        for (name, cmd) in &commands {
            id_to_name.insert(cmd.command_id, name.clone());
        }
        // (성능) id → Command 직접 캐시 — alias id 포함 전체 id_to_name 키와
        // 정확히 같은 라우팅을 제공한다(lookup 일관성: id_to_name 이 가리키는
        // 모든 id 는 여기서도 같은 명령을 찾는다).
        let id_to_command: BTreeMap<u16, Command> = id_to_name
            .iter()
            .map(|(id, name)| {
                let cmd = commands
                    .get(name)
                    .unwrap_or_else(|| panic!("build(): id {id} → '{name}' not in commands"));
                (*id, cmd.clone())
            })
            .collect();
        // (T2 리뷰) tripwire: 최종 병합 뒤 모든 alias 가 자기 명령을 가리키는지
        // 확인한다. displacement/next_command_id 순서가 다시 깨지면(alias 항목을
        // 실제 id 삽입이 덮어쓰거나 fresh id 가 alias 와 겹치면) 여기서 즉시
        // 잡힌다 — 조용한 misrouting 을 빌드 시점 국소 실패로 바꾼다.
        debug_assert!(
            self.id_aliases.iter().all(|(command, legacy_id)| {
                id_to_name.get(legacy_id).is_some_and(|n| n == command)
            }),
            "alias merge invariant broken: some legacy id does not resolve to its command"
        );
        Package {
            id: self.id,
            state: Arc::new(RwLock::new(RegistryState {
                commands,
                id_to_name,
                id_to_command,
                next_command_id,
                granted_capabilities: BTreeSet::new(),
                schema_version: self.schema_version,
            })),
            frozen: Arc::new(AtomicBool::new(!cfg!(debug_assertions))),
            events: Arc::new(events::EventState::with_capacity(self.event_capacity)),
            event_contracts: self.events,
            states: Arc::new(self.states),
        }
    }

    /// [`build`](PackageBuilder::build)의 별칭입니다.
    ///
    /// `rustra::build!("name", fn1, fn2).done()` 형태에서 사용합니다.
    pub fn done(self) -> Package {
        self.build()
    }
}

#[cfg(test)]
#[cfg_attr(not(debug_assertions), allow(dead_code))]
mod runtime_registry_tests {
    use super::*;
    use schemars::JsonSchema;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Serialize, Deserialize, JsonSchema)]
    struct TestIn {
        _v: i64,
    }
    #[derive(Debug, Serialize, Deserialize, JsonSchema)]
    struct TestOut {
        v: i64,
    }

    // NOTE: 이 handler들은 #[command] 없이 일반 fn. `register(name, handler)` 는
    // 이름 추론이 필요 없으므로 매크로 없이도 등록 가능하다. (매크로는 크레이트 내부
    // 인라인 테스트에선 rustra::__private 경로가 해석되지 않아 사용할 수 없다.)
    fn c1(_: TestIn) -> Result<TestOut> {
        Ok(TestOut { v: 1 })
    }
    fn c2(_: TestIn) -> Result<TestOut> {
        Ok(TestOut { v: 2 })
    }
    fn c3(_: TestIn) -> Result<TestOut> {
        Ok(TestOut { v: 3 })
    }

    #[derive(Debug, Serialize, Deserialize, JsonSchema)]
    struct EchoIn {
        v: i64,
    }
    #[derive(Debug, Serialize, Deserialize, JsonSchema)]
    struct EchoOut {
        v: i64,
    }
    fn echo(input: EchoIn) -> Result<EchoOut> {
        Ok(EchoOut { v: input.v })
    }

    fn empty_pkg() -> Package {
        Package::builder("test.wb").build()
    }

    fn id_of(pkg: &Package, name: &str) -> u16 {
        pkg.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .commands
            .get(name)
            .unwrap()
            .command_id
    }

    #[test]
    #[cfg(debug_assertions)]
    fn debug_build_is_mutable_by_default() {
        let pkg = empty_pkg();
        assert!(!pkg.is_frozen(), "debug build should be mutable by default");
        pkg.freeze();
        assert!(pkg.is_frozen());
    }

    // ── 레지스트리 RwLock 포이즈닝 관용 ───────────────────────
    // 레지스트리 writer 가 임계구역 안에서 패닉하면 RwLock 이 포이즈닝된다.
    // 포이즈닝은 "락을 잡은 채 패닉이 일어났다" 신호일 뿐 — BTreeMap 자체는
    // 구조적으로 유효하다(중간 상태 corruption 없음). .unwrap() 이면 이후
    // 모든 invoke 가 패닉하는데, FFI 진입점(extern "C") 경계에서는 프로세스
    // abort 다. 관용 처리로 과거 패닉 이후에도 앱이 invoke 가능해야 한다.

    #[test]
    #[cfg(debug_assertions)]
    fn poisoned_registry_lock_still_serves_invokes() {
        let pkg = empty_pkg();
        pkg.register("c1", c1).unwrap();
        // 의도적 포이즈닝 — write guard 를 잡은 채 패닉
        let _ = std::panic::catch_unwind(|| {
            let _guard = pkg.state.write().unwrap();
            panic!("intentional poison");
        });
        // 관용 처리 후: invoke/조회가 패닉하지 않고 정상 동작한다
        let out: TestOut = pkg.invoke("c1", TestIn { _v: 0 }).unwrap();
        assert_eq!(out.v, 1);
        let id = id_of(&pkg, "c1");
        assert_eq!(pkg.resolve_command_id(id).as_deref(), Some("c1"));
        assert!(pkg.live_schema()["commands"].as_array().is_some());
    }

    /// release 빌드 동등 검증 — `build()` 산출 패키지는 동결 상태지만 포이즈닝
    /// 관용 자체는 동작해야 한다. 등록은 불가(동결)하므로 빌더로 명령을 넣은
    /// 뒤(build 시점엔 미동결) 포이즈닝 후 invoke 가능성만 확인한다.
    /// (인라인 테스트에선 build! 매크로를 못 쓴다 — 위 NOTE 참조.)
    #[test]
    #[cfg(not(debug_assertions))]
    fn poisoned_registry_lock_still_serves_invokes_release() {
        let pkg = Package::builder("test.poison.release")
            .command("c1", c1)
            .build();
        let _ = std::panic::catch_unwind(|| {
            let _guard = pkg.state.write().unwrap();
            panic!("intentional poison");
        });
        let out: TestOut = pkg.invoke("c1", TestIn { _v: 0 }).unwrap();
        assert_eq!(out.v, 1);
    }

    #[test]
    #[cfg(not(debug_assertions))]
    fn release_build_is_frozen_by_default() {
        let pkg = empty_pkg();
        assert!(pkg.is_frozen(), "release build should be frozen by default");
    }

    #[test]
    #[cfg(debug_assertions)]
    fn register_assigns_monotonic_ids() {
        let pkg = empty_pkg();
        pkg.register("c1", c1).unwrap();
        pkg.register("c2", c2).unwrap();
        assert_eq!(id_of(&pkg, "c1"), 1);
        assert_eq!(id_of(&pkg, "c2"), 2);
    }

    #[test]
    #[cfg(debug_assertions)]
    fn unregistered_id_is_never_reused() {
        let pkg = empty_pkg();
        pkg.register("c1", c1).unwrap();
        pkg.register("c2", c2).unwrap();
        let id_c2 = id_of(&pkg, "c2");
        pkg.unregister("c2").unwrap();
        pkg.register("c3", c3).unwrap();
        let id_c3 = id_of(&pkg, "c3");
        assert_ne!(id_c2, id_c3, "retired id must not be reused");
        assert_eq!(id_c2, 2);
        assert_eq!(id_c3, 3);
    }

    #[test]
    #[cfg(debug_assertions)]
    fn register_replaces_with_stable_id() {
        let pkg = empty_pkg();
        pkg.register("c1", c1).unwrap();
        let id_before = id_of(&pkg, "c1");
        pkg.register("c1", c2).unwrap(); // 같은 이름 → replace, id 유지
        let id_after = id_of(&pkg, "c1");
        assert_eq!(
            id_before, id_after,
            "command_id must stay stable on replace"
        );
        let out: TestOut = pkg.invoke("c1", TestIn { _v: 0 }).unwrap();
        assert_eq!(out.v, 2, "replaced handler should be in effect");
    }

    #[test]
    #[cfg(debug_assertions)]
    fn replace_missing_errors_and_unregister_twice_errors() {
        let pkg = empty_pkg();
        let err = pkg.replace("nope", c1).unwrap_err();
        assert_eq!(err.code(), "command.not_found");
        let err = pkg.unregister("nope").unwrap_err();
        assert_eq!(err.code(), "command.not_found");
    }

    #[test]
    #[cfg(debug_assertions)]
    fn register_errors_when_id_space_exhausted() {
        let pkg = empty_pkg();
        {
            let mut st = pkg.state.write().unwrap();
            st.next_command_id = u16::MAX; // exhausted sentinel
        }
        let err = pkg.register("c1", c1).unwrap_err();
        assert_eq!(err.code(), "registry.id_exhausted");
    }

    #[test]
    #[cfg(debug_assertions)]
    fn frozen_blocks_all_mutation_but_invoke_works() {
        let pkg = empty_pkg();
        pkg.register("c1", c1).unwrap();
        pkg.freeze();

        assert_eq!(
            pkg.register("c2", c2).unwrap_err().code(),
            "registry.frozen"
        );
        assert_eq!(pkg.unregister("c1").unwrap_err().code(), "registry.frozen");
        assert_eq!(pkg.replace("c1", c2).unwrap_err().code(), "registry.frozen");

        // 동결 상태에서도 invoke/generate 는 정상 동작
        let out: TestOut = pkg.invoke("c1", TestIn { _v: 0 }).unwrap();
        assert_eq!(out.v, 1);
        assert!(pkg.generate_typescript().is_ok());
    }

    #[test]
    #[cfg(debug_assertions)]
    fn shared_clone_sees_runtime_mutation() {
        // Package clone 은 동일 레지스트리를 공유한다 (Arc semantics).
        let pkg = empty_pkg();
        let pkg2 = pkg.clone();
        pkg.register("c1", c1).unwrap();
        // 다른 clone 에서도 보여야 한다
        assert_eq!(id_of(&pkg2, "c1"), 1);
        let out: TestOut = pkg2.invoke("c1", TestIn { _v: 0 }).unwrap();
        assert_eq!(out.v, 1);
    }

    /// 동적(런타임 등록) 명령이 rkyv V2 Tier 3 경로로 호출되는지 검증.
    #[test]
    #[cfg(debug_assertions)]
    fn dynamic_command_invokable_via_rkyv_v2_tier3() {
        let pkg = empty_pkg();
        pkg.register("echo", echo).unwrap();
        // Tier 3 wire: [command_id: u16 LE @0][json @2]
        let json = br#"{"v":7}"#;
        let mut payload = vec![0u8; 2 + json.len()];
        payload[0..2].copy_from_slice(&1u16.to_le_bytes());
        payload[2..].copy_from_slice(json);
        let resp = pkg.invoke_rkyv_v2(&payload).unwrap();
        // success tier3: [ok:1 @0][pad 3B][json_len: u32 LE @4][json @8]
        assert_eq!(resp[0], 1, "ok flag should be 1");
        let len = u32::from_le_bytes(resp[4..8].try_into().unwrap()) as usize;
        let out: serde_json::Value = serde_json::from_slice(&resp[8..8 + len]).unwrap();
        assert_eq!(out["v"], 7);
    }

    /// live_schema() 가 동적 명령을 포함하는지 검증.
    #[test]
    #[cfg(debug_assertions)]
    fn live_schema_includes_dynamic_command() {
        let pkg = empty_pkg();
        pkg.register("echo", echo).unwrap();
        let s = pkg.live_schema();
        let cmds = s["commands"].as_array().unwrap();
        let echo_entry = cmds
            .iter()
            .find(|c| c["name"] == "echo")
            .expect("echo should be in live schema");
        assert_eq!(echo_entry["commandId"], 1);
        assert_eq!(
            echo_entry["inputSchema"]["properties"]["v"]["type"],
            "integer"
        );
    }

    /// deny-by-default: capability 가 부여되지 않으면 capability.denied 로 거부.
    #[test]
    #[cfg(debug_assertions)]
    fn capability_required_command_denied_without_grant() {
        let pkg = Package::builder("test.wb")
            .command("locked", c1)
            .require_capability("locked", "compute:secure")
            .build();
        // capability 미부여 → 거부. 핸들러(c1) 는 호출되지 않는다.
        let err = pkg
            .invoke::<_, TestOut>("locked", TestIn { _v: 0 })
            .unwrap_err();
        assert_eq!(err.code(), "capability.denied");
        assert!(!pkg.has_capability("compute:secure"));
    }

    /// grant 후에는 동일 명령이 허용된다.
    #[test]
    #[cfg(debug_assertions)]
    fn capability_grant_allows_command() {
        let pkg = Package::builder("test.wb")
            .command("locked", c1)
            .require_capability("locked", "compute:secure")
            .build();
        pkg.grant_capability("compute:secure").unwrap();
        assert!(pkg.has_capability("compute:secure"));
        let out: TestOut = pkg.invoke("locked", TestIn { _v: 0 }).unwrap();
        assert_eq!(out.v, 1, "granted capability should allow execution");
    }

    /// capability 가 없는 일반 명령은 grant 여부와 무관하게 항상 허용.
    #[test]
    #[cfg(debug_assertions)]
    fn non_gated_command_always_allowed() {
        let pkg = Package::builder("test.wb").command("open", c1).build();
        let out: TestOut = pkg.invoke("open", TestIn { _v: 0 }).unwrap();
        assert_eq!(out.v, 1);
    }

    /// rkyv V2 바이너리 경로에서도 deny-by-default 가 동작한다.
    #[test]
    #[cfg(debug_assertions)]
    fn capability_denied_on_rkyv_v2_path() {
        let pkg = Package::builder("test.wb")
            .command("locked", echo) // command_id 1
            .require_capability("locked", "compute:secure")
            .build();
        // locked(EchoIn) 는 Tier 1 (단일 i64) — fast postcard path.
        // capability 게이트가 디코더보다 먼저 평가되므로 cmd_id 만 있어도 된다.
        let mut payload = vec![0u8; 2];
        payload[0..2].copy_from_slice(&1u16.to_le_bytes()); // command_id = 1
        let err = pkg.invoke_rkyv_v2(&payload).unwrap_err();
        assert_eq!(err.code(), "capability.denied");
    }

    /// 동결 상태에서는 레지스트리 mutation(register)은 거부되지만 grant_capability 는
    /// 허용된다 — grant는 구조 변경이 아닌 런타임 권한 부여이며, release 빌드(동결
    /// 시작)에서 권한을 부여할 유일한 경로다.
    #[test]
    #[cfg(debug_assertions)]
    fn grant_capability_allowed_when_frozen_but_register_blocked() {
        let pkg = Package::builder("test.wb")
            .command("locked", c1)
            .require_capability("locked", "compute:secure")
            .build();
        pkg.freeze();

        // 구조 mutation은 동결로 차단된다.
        assert_eq!(
            pkg.register("new_cmd", c2).unwrap_err().code(),
            "registry.frozen"
        );

        // grant는 동결과 무관하게 동작한다.
        pkg.grant_capability("compute:secure").unwrap();
        assert!(pkg.has_capability("compute:secure"));

        // 부여된 뒤에는 해당 명령이 실제로 호출된다.
        let out = pkg
            .invoke_json("locked", serde_json::json!({ "_v": 0 }))
            .unwrap();
        assert_eq!(out["v"], 1);
    }

    /// 코어 FFI rkyv V2 심볼이 등록된 패키지로 동작하는지 검증한다 —
    /// 소비자마다 복제하던 패닉 가드+버퍼 프로토콜의 단일 구현.
    /// (전역 PACKAGE OnceLock 을 다른 FFI 테스트와 공유하므로, 여기서는
    /// 심볼의 정상 경로만 검증한다 — trust_baseline_ffi.rs 가 나머지 계약을
    /// 담당한다.)
    #[test]
    fn core_rkyv_v2_ffi_symbol_dispatches() {
        let pkg = Package::builder("test.wb")
            .command("double", |args: serde_json::Value| {
                Ok::<_, RustraError>(serde_json::json!(args["v"].as_i64().unwrap_or(0) * 2))
            })
            .build();
        pkg.register_ffi();
        // command_id 1 번 프레임: [cmd_id u16][pad 6][postcard payload]
        let mut payload = [0u8; 8];
        payload[0..2].copy_from_slice(&1u16.to_le_bytes());
        let mut out_len = 0usize;
        let ptr = unsafe {
            crate::ffi::rustra_ffi_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len)
        };
        // 전역 패키지가 다른 테스트의 것일 수 있다(OnceLock 선점) — 어느 쪽이든
        // 심볼이 유효한 프레임을 반환하는지만 검증한다(에러 프레임도 ok=0 헤더를
        // 가진다). null/빈 응답이 아니면 심블의 계약은 성립이다.
        assert!(
            out_len >= 10,
            "rkyv V2 frame must have 10-byte header, got {out_len}"
        );
        if !ptr.is_null() {
            let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) };
            assert!(bytes[0] == 0 || bytes[0] == 1, "ok flag must be 0 or 1");
            unsafe { crate::ffi::rustra_ffi_free(ptr, out_len) };
        }
    }
}

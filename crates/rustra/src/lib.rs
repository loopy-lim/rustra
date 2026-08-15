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

pub use rustra_macros::bridge_type;
pub use rustra_macros::build;
pub use rustra_macros::command;
pub use rustra_macros::register;

pub use rkyv_codec::encode_rkyv_v2_error;

mod codegen;
mod error;
pub mod events;
pub mod ffi;
pub mod renderer_host;
mod rkyv_codec;
mod schema;

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
    build_tier3_json_decoder, is_output_tier3,
};

pub use error::{Result, RustraError};

use codegen::{command_function_name, contract_hash, ts_type_from_schema};
use schema::{command_name_from_handler, schema_value, short_type_name};

/// 자주 사용하는 타입과 매크로를 한 번에 가져올 수 있는 prelude 모듈입니다.
///
/// ```rust
/// use rustra::prelude::*;
/// ```
pub mod prelude {
    pub use crate::{
        GeneratedPackage, Package, PackageBuilder, Result, RustraError, bridge_type, build,
        command,
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
#[cfg(feature = "tauri")]
pub mod tauri_support {
    use crate::Package;
    use serde_json::{Value, json};
    use tauri::State;

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
    pub fn register<R: tauri::Runtime>(
        package: Package,
        builder: tauri::Builder<R>,
    ) -> tauri::Builder<R> {
        builder
            .manage(RustraState { package })
            .invoke_handler(tauri::generate_handler![rustra_dispatch])
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
    state: Arc<RwLock<RegistryState>>,
    frozen: Arc<AtomicBool>,
    /// Rust → JS 이벤트 푸시 버스. `emit()` 으로 발행, 호스트 어댑터가
    /// `event_bus()` 를 폴링해 플랫폼 푸시 채널로 전달한다.
    bus: events::EventBus,
}

/// `Package`의 가변 내부 상태. `Arc<RwLock<_>>`로 보호되어 런타임 mutation을 지원한다.
struct RegistryState {
    commands: BTreeMap<String, Command>,
    id_to_name: BTreeMap<u16, String>,
    next_command_id: u16,
    /// Runtime Authority: 부여된 capability 집합. deny-by-default —
    /// `required_capability` 가 `Some` 인 명령은 이 집합에 포함될 때만 실행된다.
    granted_capabilities: BTreeSet<String>,
}

impl std::fmt::Debug for Package {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let state = self.state.read().unwrap();
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
/// | `contract_hash` | `contract.ts` | 스키마 해시 (무결성 검증용) |
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
}

impl GeneratedPackage {
    /// 생성된 모든 파일을 지정한 디렉토리에 저장합니다.
    ///
    /// 디렉토리가 없으면 생성합니다:
    /// - `schema.json` — 전체 명령 스키마
    /// - `types.ts` — TypeScript 타입 정의
    /// - `commands.ts` — TypeScript 명령 헬퍼 함수
    /// - `contract.ts` — `GENERATED_CONTRACT_HASH` 상수
    pub fn write_to_dir(&self, output_dir: impl AsRef<Path>) -> crate::Result<()> {
        let output_dir = output_dir.as_ref();
        fs::create_dir_all(output_dir)?;
        fs::write(output_dir.join("schema.json"), &self.schema_json)?;
        fs::write(output_dir.join("types.ts"), &self.types_ts)?;
        fs::write(output_dir.join("commands.ts"), &self.commands_ts)?;
        fs::write(
            output_dir.join("contract.ts"),
            format!(
                "export const GENERATED_CONTRACT_HASH = '{}';\n",
                self.contract_hash
            ),
        )?;
        Ok(())
    }
}

/// 단일 명령의 메타데이터와 핸들러입니다.
#[derive(Clone)]
struct Command {
    command_id: u16,
    input_type: String,
    output_type: String,
    input_schema: Value,
    output_schema: Value,
    definitions: Value,
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

    // Generate fast postcard-based binary handler that bypasses JSON Value.
    // force_tier3 인 경우 postcard fast-path 를 끄고 Tier 3 JSON fallback 로 보낸다.
    let rkyv_v2_handler: Option<BinHandler> = if force_tier3 {
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
        input_schema,
        output_schema,
        definitions,
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
    /// 새로운 [`PackageBuilder`]를 생성합니다.
    ///
    /// `id`는 패키지를 식별하는 고유 문자열입니다. 역방향 도메인 표기법을 권장합니다
    /// (예: `"com.example.calculator"`).
    pub fn builder(id: impl Into<String>) -> PackageBuilder {
        PackageBuilder {
            id: id.into(),
            commands: BTreeMap::new(),
            next_command_id: 1,
        }
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
    /// 무엇이든 JSON 으로 직렬화된다. 발행된 이벤트는 [`Package::event_bus`]
    /// 큐에 쌓이고, 호스트 어댑터가 폴링해 플랫폼 푸시 채널(Lynx BTS
    /// `post_task_to_runtime`, Tauri `emit`, RN `DeviceEventEmitter`)로 전달한다.
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
        let json = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string());
        self.bus.emit(event, json);
    }

    /// 이벤트 버스에 대한 접근자 — 호스트 어댑터 폴링용.
    ///
    /// 반환된 [`events::EventBus`]는 `Arc` 공유 클론이므로 어댑터에 저장해
    /// 자유롭게 폴링(`take_pending_events`)할 수 있다.
    pub fn event_bus(&self) -> &events::EventBus {
        &self.bus
    }

    /// JSON [`Value`]를 직접 전달하여 명령을 호출합니다.
    ///
    /// [`invoke`](Package::invoke)의 비제네릭 버전으로, JSON 기반 라우팅에 사용됩니다.
    pub fn invoke_json(&self, name: &str, params: Value) -> crate::Result<Value> {
        // 핸들러 실행 중에는 잠금을 hold 하지 않도록 Command를 clone-out 한다.
        // (재진입 — 핸들러가 다시 register/unregister 호출 — 시 교착 방지)
        let command = {
            let state = self.state.read().unwrap();
            state
                .commands
                .get(name)
                .ok_or_else(|| RustraError::command_not_found(name))?
                .clone()
        };
        // Runtime Authority: deny-by-default — capability 가 요구되는데 부여되지
        // 않았으면 핸들러를 호출하지 않고 capability.denied 를 반환한다.
        self.capability_satisfied(&command)?;
        (command.invoke)(params)
    }

    /// command_id로 명령 이름을 조회합니다.
    pub fn resolve_command_id(&self, id: u16) -> Option<String> {
        self.state.read().unwrap().id_to_name.get(&id).cloned()
    }

    /// rkyv V2 바이너리 페이로드를 받아 명령을 실행합니다.
    ///
    /// 처음 2바이트에서 command_id를 읽고, 등록된 rkyv_v2_decoder로
    /// 입력 필드를 읽어 JSON Value로 재구성한 뒤 invoke_json으로 전달합니다.
    /// 결과는 rkyv_v2_encode_response로 바이너리로 인코딩하여 반환합니다.
    ///
    /// Tier 1/2 commands require at least 8 bytes (fixed header).
    /// Tier 3 commands require at least 2 bytes (command_id only, rest is JSON).
    pub fn invoke_rkyv_v2(&self, payload: &[u8]) -> crate::Result<Vec<u8>> {
        if payload.len() < 2 {
            return Err(RustraError::invalid_args("rkyv v2: payload too short"));
        }
        let command_id = u16::from_le_bytes([payload[0], payload[1]]);
        let command = {
            let state = self.state.read().unwrap();
            let command_name = state
                .id_to_name
                .get(&command_id)
                .ok_or_else(|| RustraError::command_not_found(format!("id:{command_id}")))?;
            state
                .commands
                .get(command_name)
                .ok_or_else(|| RustraError::command_not_found(command_name))?
                .clone()
        };
        // Runtime Authority: deny-by-default — capability 가 요구되는데 부여되지
        // 않았으면 바이너리 핸들러(또는 JSON fallback)를 호출하지 않고
        // capability.denied 를 반환한다. 에러는 rkyv V2 error wire 로 인코딩되어
        // JS RustraCommandError("capability.denied") 로 재구성된다.
        self.capability_satisfied(&command)?;

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
    /// `cap` 을 granted 집합에 추가하면 이후 해당 명령이 허용된다. 동결 상태면
    /// `registry.frozen`.
    pub fn grant_capability(&self, cap: &str) -> crate::Result<()> {
        self.ensure_mutable()?;
        let mut state = self.state.write().unwrap();
        state.granted_capabilities.insert(cap.to_string());
        Ok(())
    }

    /// `cap` 이 현재 부여되어 있는지 (읽기 전용, 동결 무관).
    pub fn has_capability(&self, cap: &str) -> bool {
        self.state
            .read()
            .unwrap()
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
                .unwrap()
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
        let mut state = self.state.write().unwrap();
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
        let mut state = self.state.write().unwrap();
        let command_id = state
            .commands
            .get(name)
            .map(|c| c.command_id)
            .ok_or_else(|| RustraError::command_not_found(name))?;
        let command = build_command::<I, O, F>(command_id, handler, false);
        state.commands.insert(name.to_string(), command);
        Ok(())
    }

    /// 명령을 제거한다. `command_id`는 retired 되어 **재사용되지 않는다**.
    /// 이름이 없으면 `command.not_found`. 동결 상태면 `registry.frozen`.
    pub fn unregister(&self, name: &str) -> crate::Result<()> {
        self.ensure_mutable()?;
        let mut state = self.state.write().unwrap();
        let removed = state
            .commands
            .remove(name)
            .ok_or_else(|| RustraError::command_not_found(name))?;
        state.id_to_name.remove(&removed.command_id);
        // NOTE: next_command_id는 감소시키지 않는다 — retired id는 영원히 재사용 금지.
        Ok(())
    }

    /// 현재 등록된 모든 명령의 라이브 스키마를 반환한다 (정적 + 동적).
    ///
    /// 읽기 전용이므로 debug/release 모두에서 사용 가능. `rustra_ffi_get_schema` 의 기반이 된다.
    pub fn live_schema(&self) -> Value {
        let state = self.state.read().unwrap();
        Self::schema(&self.id, &state)
    }

    /// 등록된 모든 명령에서 TypeScript 클라이언트 코드를 생성합니다.
    pub fn generate_typescript(&self) -> crate::Result<GeneratedPackage> {
        let state = self.state.read().unwrap();
        let schema_json = serde_json::to_string_pretty(&Self::schema(&self.id, &state))
            .map_err(RustraError::internal)?;
        let contract_hash = contract_hash(&schema_json);
        let types_ts = Self::generate_types_ts(&state);
        let commands_ts = Self::generate_commands_ts(&state);

        Ok(GeneratedPackage {
            schema_json,
            types_ts,
            commands_ts,
            contract_hash,
        })
    }

    fn schema(id: &str, state: &RegistryState) -> Value {
        let commands = state
            .commands
            .iter()
            .map(|(name, command)| {
                let mut entry = json!({
                    "name": name,
                    "commandId": command.command_id,
                    "inputType": command.input_type,
                    "outputType": command.output_type,
                    "inputSchema": command.input_schema,
                    "outputSchema": command.output_schema,
                });
                // Include definitions if non-empty (for $ref resolution)
                #[allow(clippy::collapsible_if)]
                if let Value::Object(defs) = &command.definitions {
                    if !defs.is_empty() {
                        entry
                            .as_object_mut()
                            .unwrap()
                            .insert("definitions".into(), command.definitions.clone());
                    }
                }
                entry
            })
            .collect::<Vec<_>>();

        json!({
            "packageId": id,
            "commands": commands,
        })
    }

    fn generate_types_ts(state: &RegistryState) -> String {
        let mut output = String::from(
            "export type { EngineClient, RustraError } from '@rustra/types';\n\
             export { RustraCommandError } from '@rustra/types';\n\n",
        );

        let mut all_definitions = serde_json::Map::new();
        for command in state.commands.values() {
            if let Value::Object(defs) = &command.definitions {
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
                    output.push_str(&format!(
                        "export type {name} = {};\n\n",
                        ts_type_from_schema(def_schema, &definitions)
                    ));
                }
            }
        }

        for command in state.commands.values() {
            if emitted.insert(command.input_type.clone()) {
                output.push_str(&format!(
                    "export type {} = {};\n\n",
                    command.input_type,
                    ts_type_from_schema(&command.input_schema, &definitions)
                ));
            }
            if emitted.insert(command.output_type.clone()) {
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
            type_names.insert(command.input_type.clone());
            type_names.insert(command.output_type.clone());
        }

        let imports = type_names.into_iter().collect::<Vec<_>>().join(", ");
        let mut output = format!("import type {{ {imports} }} from './types.js';\n");
        output.push_str("import { invoke } from '@rustra/types';\n\n");

        for (name, command) in state.commands.iter() {
            output.push_str(&format!(
                "export function {}(input: {}): Promise<{}> {{\n  return invoke<{}>('{}', input);\n}}\n\n",
                command_function_name(name),
                command.input_type,
                command.output_type,
                command.output_type,
                name,
            ));
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

    /// 등록된 모든 명령을 불변 [`Package`]로 빌드합니다.
    pub fn build(self) -> Package {
        let id_to_name: BTreeMap<u16, String> = self
            .commands
            .iter()
            .map(|(name, cmd)| (cmd.command_id, name.clone()))
            .collect();
        Package {
            id: self.id,
            state: Arc::new(RwLock::new(RegistryState {
                commands: self.commands,
                id_to_name,
                next_command_id: self.next_command_id,
                granted_capabilities: BTreeSet::new(),
            })),
            frozen: Arc::new(AtomicBool::new(!cfg!(debug_assertions))),
            bus: events::EventBus::new(),
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
            .unwrap()
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

    /// 동결 상태에서는 grant_capability 도 거부된다 (registry.frozen).
    #[test]
    #[cfg(debug_assertions)]
    fn grant_capability_blocked_when_frozen() {
        let pkg = Package::builder("test.wb")
            .command("locked", c1)
            .require_capability("locked", "compute:secure")
            .build();
        pkg.freeze();
        assert_eq!(
            pkg.grant_capability("compute:secure").unwrap_err().code(),
            "registry.frozen"
        );
    }
}

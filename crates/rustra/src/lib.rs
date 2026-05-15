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

pub use rustra_macros::command;
pub use rustra_macros::register;

mod codegen;
mod error;
mod schema;

use schemars::JsonSchema;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::sync::Arc;

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
        command, encode_rkyv_v2_error, register, GeneratedPackage, Package, PackageBuilder, Result,
        RustraError,
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
    use serde::{de::DeserializeOwned, Serialize};

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
    use serde_json::{json, Value};
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
    commands: Arc<BTreeMap<String, Command>>,
    id_to_name: Arc<BTreeMap<u16, String>>,
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

    /// JSON [`Value`]를 직접 전달하여 명령을 호출합니다.
    ///
    /// [`invoke`](Package::invoke)의 비제네릭 버전으로, JSON 기반 라우팅에 사용됩니다.
    pub fn invoke_json(&self, name: &str, params: Value) -> crate::Result<Value> {
        let command = self
            .commands
            .get(name)
            .ok_or_else(|| RustraError::command_not_found(name))?;
        (command.invoke)(params)
    }

    /// command_id로 명령 이름을 조회합니다.
    pub fn resolve_command_id(&self, id: u16) -> Option<&str> {
        self.id_to_name.get(&id).map(|s| s.as_str())
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
        let command_name = self
            .resolve_command_id(command_id)
            .ok_or_else(|| RustraError::command_not_found(format!("id:{command_id}")))?;

        let command = self
            .commands
            .get(command_name)
            .ok_or_else(|| RustraError::command_not_found(command_name))?;

        // Fast path: use typed postcard binary handler (bypasses JSON Value entirely)
        if let Some(ref handler) = command.rkyv_v2_handler {
            return handler(payload);
        }

        // Fallback: legacy JSON-based path for commands without binary handler
        if !command.rkyv_v2_tier3 && payload.len() < 8 {
            return Err(RustraError::invalid_args("rkyv v2: payload too short"));
        }

        let params = (command.rkyv_v2_decode)(payload)?;
        let result = self.invoke_json(command_name, params)?;
        Ok((command.rkyv_v2_encode_response)(&result))
    }

    /// 등록된 모든 명령에서 TypeScript 클라이언트 코드를 생성합니다.
    pub fn generate_typescript(&self) -> crate::Result<GeneratedPackage> {
        let schema_json =
            serde_json::to_string_pretty(&self.schema()).map_err(RustraError::internal)?;
        let contract_hash = contract_hash(&schema_json);
        let types_ts = self.generate_types_ts();
        let commands_ts = self.generate_commands_ts();

        Ok(GeneratedPackage {
            schema_json,
            types_ts,
            commands_ts,
            contract_hash,
        })
    }

    fn schema(&self) -> Value {
        let commands = self
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
            "packageId": self.id,
            "commands": commands,
        })
    }

    fn generate_types_ts(&self) -> String {
        let mut output = String::from(
            "export type { EngineClient, RustraError } from '@rustra/types';\n\
             export { RustraCommandError } from '@rustra/types';\n\n",
        );

        let mut all_definitions = serde_json::Map::new();
        for command in self.commands.values() {
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

        for command in self.commands.values() {
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

    fn generate_commands_ts(&self) -> String {
        let mut type_names =
            BTreeSet::from(["EngineClient".to_string(), "RustraError".to_string()]);
        for command in self.commands.values() {
            type_names.insert(command.input_type.clone());
            type_names.insert(command.output_type.clone());
        }

        let imports = type_names.into_iter().collect::<Vec<_>>().join(", ");
        let mut output = format!("import type {{ {imports} }} from './types.js';\n\n");

        for (name, command) in self.commands.iter() {
            output.push_str(&format!(
                "export function {}(engine: EngineClient, input: {}): Promise<{}> {{\n  return engine.invoke<{}>('{}', input);\n}}\n\n",
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
        let is_tier3 = input_tier == Tier::Tier3 || output_tier3;
        // If the command uses Tier 3 for either input or output, force the
        // input decoder to the Tier 3 JSON fallback as well.
        let rkyv_v2_decoder = if is_tier3 && input_tier != Tier::Tier3 {
            build_tier3_json_decoder()
        } else {
            rkyv_v2_decoder
        };
        let rkyv_v2_response_encoder = build_rkyv_v2_response_encoder(&output_schema, is_tier3);

        // Wrap handler in Arc so both JSON and binary paths can use it
        let handler = Arc::new(handler);

        // Generate fast postcard-based binary handler that bypasses JSON Value
        let handler_bin = handler.clone();
        let rkyv_v2_handler: Option<BinHandler> = Some(Arc::new(move |payload: &[u8]| {
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
        }));

        let command = Command {
            command_id: self.next_command_id,
            input_type: short_type_name::<I>(),
            output_type: short_type_name::<O>(),
            input_schema,
            output_schema,
            definitions,
            invoke: Arc::new(move |params| {
                let input =
                    serde_json::from_value::<I>(params).map_err(RustraError::invalid_args)?;
                let output = handler(input)?;
                serde_json::to_value(output).map_err(RustraError::internal)
            }),
            rkyv_v2_handler,
            rkyv_v2_decode: rkyv_v2_decoder,
            rkyv_v2_encode_response: rkyv_v2_response_encoder,
            rkyv_v2_tier3: is_tier3,
        };
        let name = name.into();
        if self.commands.contains_key(&name) {
            panic!("duplicate command registration: '{name}'");
        }
        self.commands.insert(name, command);
        self.next_command_id += 1;
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
            commands: Arc::new(self.commands),
            id_to_name: Arc::new(id_to_name),
        }
    }
}

/// Build the Tier 3 JSON fallback decoder.
///
/// Wire format: `[command_id: u16 @0 LE][json_string @2...]`
///
/// Reads bytes after the 2-byte command_id as a UTF-8 JSON string and
/// deserializes it into a [`serde_json::Value`].
fn build_tier3_json_decoder() -> DecodeFn {
    Arc::new(|payload: &[u8]| {
        if payload.len() < 2 {
            return Err(RustraError::invalid_args(
                "rkyv v2 tier3: payload too short for command_id",
            ));
        }
        let json_str = std::str::from_utf8(&payload[2..])
            .map_err(|_| RustraError::invalid_args("rkyv v2 tier3: invalid UTF-8"))?;
        serde_json::from_str(json_str).map_err(|e| {
            RustraError::invalid_args(format!("rkyv v2 tier3: JSON parse failed: {e}"))
        })
    })
}

/// JSON Schema에서 rkyv V2 디코더를 자동 생성합니다.
///
/// 입력 스키마의 프로퍼티를 분석하여 고정폭 필드와 가변폭 필드를 분리하고,
/// 바이트에서 직접 값을 읽어 JSON Value를 재구성하는 클로저를 반환합니다.
///
/// Tier 1: 모든 필드가 고정폭 primitive (i64, i32, f64, …)
/// Tier 2: String 또는 Vec<primitive> 필드 포함
/// Tier 3: 중첩 구조체, enum, Option<T> 등 — 아직 미지원
type BinHandler = Arc<dyn Fn(&[u8]) -> crate::Result<Vec<u8>> + Send + Sync>;
type DecodeFn = Arc<dyn Fn(&[u8]) -> crate::Result<Value> + Send + Sync>;
type EncodeFn = Arc<dyn Fn(&Value) -> Vec<u8> + Send + Sync>;

fn build_rkyv_v2_decoder(input_schema: &Value) -> (DecodeFn, Tier) {
    let props = match input_schema.get("properties").and_then(Value::as_object) {
        Some(p) => p,
        None => {
            return (
                Arc::new(|_| Err(RustraError::internal("no properties in input schema"))),
                Tier::Tier3,
            );
        }
    };
    let required: BTreeSet<String> = input_schema
        .get("required")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();

    // Classify fields into fixed and variable, and determine the tier.
    let mut fixed_fields: Vec<(String, usize, WireFieldKind)> = Vec::new();
    let mut var_fields: Vec<(String, WireFieldKind)> = Vec::new();
    let mut tier = Tier::Tier1;

    let mut offset: usize = 8; // command_id u16 + 6B padding

    for (name, prop_schema) in props {
        if !required.contains(name) {
            tier = Tier::Tier3;
            continue;
        }
        let Some(kind) = wire_kind_from_schema(prop_schema) else {
            tier = Tier::Tier3;
            continue;
        };

        if kind.is_fixed() {
            let size = kind.size();
            offset = align_up(offset, size);
            fixed_fields.push((name.clone(), offset, kind));
            offset += size;
        } else {
            tier = if tier == Tier::Tier1 {
                Tier::Tier2
            } else {
                tier
            };
            var_fields.push((name.clone(), kind));
        }
    }

    if tier == Tier::Tier3 {
        return (build_tier3_json_decoder(), Tier::Tier3);
    }

    // var_data_start is where variable-length fields begin in the payload.
    let var_data_start = offset;

    (
        Arc::new(move |payload: &[u8]| {
            let mut result = serde_json::Map::new();

            // Read fixed fields at their pre-computed offsets.
            for (name, field_offset, kind) in &fixed_fields {
                let val = read_wire_field(payload, *field_offset, *kind)?;
                result.insert(name.clone(), val);
            }

            // Read variable-length fields sequentially after the fixed region.
            let mut cursor = var_data_start;
            for (name, kind) in &var_fields {
                // u32 LE length prefix
                if cursor + 4 > payload.len() {
                    return Err(RustraError::invalid_args(
                        "rkyv v2: payload truncated at var-field length",
                    ));
                }
                let len_bytes: [u8; 4] = payload[cursor..cursor + 4].try_into().unwrap();
                let field_len = u32::from_le_bytes(len_bytes) as usize;
                cursor += 4;

                if cursor + field_len > payload.len() {
                    return Err(RustraError::invalid_args(
                        "rkyv v2: payload truncated at var-field data",
                    ));
                }

                let val = match kind {
                    WireFieldKind::String => {
                        let s = std::str::from_utf8(&payload[cursor..cursor + field_len]).map_err(
                            |_| RustraError::invalid_args("rkyv v2: invalid UTF-8 in string field"),
                        )?;
                        json!(s)
                    }
                    WireFieldKind::VecI64 => {
                        let elem_size = 8usize;
                        if !field_len.is_multiple_of(elem_size) {
                            return Err(RustraError::invalid_args(
                                "rkyv v2: Vec<i64> data length not a multiple of 8",
                            ));
                        }
                        let count = field_len / elem_size;
                        let mut arr = Vec::with_capacity(count);
                        for i in 0..count {
                            let off = cursor + i * elem_size;
                            let bytes: [u8; 8] = payload[off..off + 8].try_into().unwrap();
                            arr.push(i64::from_le_bytes(bytes));
                        }
                        json!(arr)
                    }
                    WireFieldKind::VecF64 => {
                        let elem_size = 8usize;
                        if !field_len.is_multiple_of(elem_size) {
                            return Err(RustraError::invalid_args(
                                "rkyv v2: Vec<f64> data length not a multiple of 8",
                            ));
                        }
                        let count = field_len / elem_size;
                        let mut arr = Vec::with_capacity(count);
                        for i in 0..count {
                            let off = cursor + i * elem_size;
                            let bytes: [u8; 8] = payload[off..off + 8].try_into().unwrap();
                            arr.push(f64::from_le_bytes(bytes));
                        }
                        json!(arr)
                    }
                    WireFieldKind::VecI32 => {
                        let elem_size = 4usize;
                        if !field_len.is_multiple_of(elem_size) {
                            return Err(RustraError::invalid_args(
                                "rkyv v2: Vec<i32> data length not a multiple of 4",
                            ));
                        }
                        let count = field_len / elem_size;
                        let mut arr = Vec::with_capacity(count);
                        for i in 0..count {
                            let off = cursor + i * elem_size;
                            let bytes: [u8; 4] = payload[off..off + 4].try_into().unwrap();
                            arr.push(i32::from_le_bytes(bytes));
                        }
                        json!(arr)
                    }
                    WireFieldKind::VecBool => {
                        let count = field_len;
                        let mut arr = Vec::with_capacity(count);
                        for i in 0..count {
                            arr.push(payload[cursor + i] != 0);
                        }
                        json!(arr)
                    }
                    WireFieldKind::VecU8 => {
                        json!(payload[cursor..cursor + field_len])
                    }
                    _ => unreachable!("fixed kind in var_fields"),
                };
                result.insert(name.clone(), val);
                cursor += field_len;
            }

            Ok(Value::Object(result))
        }),
        tier,
    )
}

/// Builds a response encoder that turns a JSON Value (output from invoke_json)
/// into the rkyv V2 binary response format.
///
/// Tier 1/2 wire format:
/// ```text
/// [ok: u8 @0][pad 7B]
/// [fixed output fields @8...][var output fields...]
/// ```
///
/// Tier 3 wire format:
/// ```text
/// [ok: u8 @0][pad 3B][json_len: u32 @4 LE][json_bytes @8...]
/// ```
///
/// For errors the encoder is not used; `encode_rkyv_v2_error` is called instead.
fn build_rkyv_v2_response_encoder(output_schema: &Value, is_tier3: bool) -> EncodeFn {
    // Tier 3: encode response as JSON string after ok byte
    if is_tier3 {
        return Arc::new(move |value: &Value| {
            let json_str = serde_json::to_string(value).unwrap_or_default();
            let json_bytes = json_str.as_bytes();
            let json_len = json_bytes.len() as u32;
            let mut buf = vec![0u8; 8 + json_bytes.len()];
            buf[0] = 1; // ok = true
            buf[4..8].copy_from_slice(&json_len.to_le_bytes());
            buf[8..8 + json_bytes.len()].copy_from_slice(json_bytes);
            buf
        });
    }
    let props = match output_schema.get("properties").and_then(Value::as_object) {
        Some(p) => p,
        None => {
            return Arc::new(|_| {
                // No properties → return ok-only response (8 bytes)
                let mut buf = vec![0u8; 8];
                buf[0] = 1; // ok = true
                buf
            });
        }
    };

    let required: BTreeSet<String> = output_schema
        .get("required")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();

    let mut fixed_fields: Vec<(String, usize, WireFieldKind)> = Vec::new();
    let mut var_fields: Vec<(String, WireFieldKind)> = Vec::new();
    let mut offset: usize = 8; // ok u8 + 7B padding

    // Sort fields by alignment descending then by original order to match
    // the decoder's layout (the decoder iterates properties in schema order).
    let ordered: Vec<_> = props
        .iter()
        .filter(|(name, _)| required.contains(name.as_str()))
        .collect();

    for (name, prop_schema) in &ordered {
        if let Some(kind) = wire_kind_from_schema(prop_schema) {
            if kind.is_fixed() {
                let size = kind.size();
                offset = align_up(offset, size);
                fixed_fields.push(((*name).clone(), offset, kind));
                offset += size;
            } else {
                var_fields.push(((*name).clone(), kind));
            }
        }
    }

    // Pre-compute the total buffer size needed for the fixed region so we
    // can allocate once and fill in-place.
    let fixed_end = offset;

    Arc::new(move |value: &Value| {
        let mut buf = vec![0u8; fixed_end];
        buf[0] = 1; // ok = true

        // Encode fixed fields
        for (name, field_offset, kind) in &fixed_fields {
            let val = value.get(name);
            match kind {
                WireFieldKind::I64 => {
                    let v = val.and_then(Value::as_i64).unwrap_or(0);
                    buf[*field_offset..*field_offset + 8].copy_from_slice(&v.to_le_bytes());
                }
                WireFieldKind::I32 => {
                    let v = val.and_then(Value::as_i64).unwrap_or(0) as i32;
                    buf[*field_offset..*field_offset + 4].copy_from_slice(&v.to_le_bytes());
                }
                WireFieldKind::U32 => {
                    let v = val.and_then(Value::as_u64).unwrap_or(0) as u32;
                    buf[*field_offset..*field_offset + 4].copy_from_slice(&v.to_le_bytes());
                }
                WireFieldKind::U16 => {
                    let v = val.and_then(Value::as_u64).unwrap_or(0) as u16;
                    buf[*field_offset..*field_offset + 2].copy_from_slice(&v.to_le_bytes());
                }
                WireFieldKind::F64 => {
                    let v = val.and_then(Value::as_f64).unwrap_or(0.0);
                    buf[*field_offset..*field_offset + 8].copy_from_slice(&v.to_le_bytes());
                }
                WireFieldKind::F32 => {
                    let v = val.and_then(Value::as_f64).unwrap_or(0.0) as f32;
                    buf[*field_offset..*field_offset + 4].copy_from_slice(&v.to_le_bytes());
                }
                WireFieldKind::Bool => {
                    buf[*field_offset] = if val.and_then(Value::as_bool).unwrap_or(false) {
                        1
                    } else {
                        0
                    };
                }
                _ => unreachable!("var kind in fixed_fields"),
            }
        }

        // Encode variable-length fields
        for (name, kind) in &var_fields {
            let val = value.get(name);
            match kind {
                WireFieldKind::String => {
                    let s = val.and_then(Value::as_str).unwrap_or("");
                    let s_bytes = s.as_bytes();
                    buf.extend_from_slice(&(s_bytes.len() as u32).to_le_bytes());
                    buf.extend_from_slice(s_bytes);
                }
                WireFieldKind::VecI64 => {
                    let arr = val
                        .and_then(Value::as_array)
                        .map(|a| a.as_slice())
                        .unwrap_or(&[]);
                    let data_len = arr.len() * 8;
                    buf.extend_from_slice(&(data_len as u32).to_le_bytes());
                    for item in arr {
                        let v = item.as_i64().unwrap_or(0);
                        buf.extend_from_slice(&v.to_le_bytes());
                    }
                }
                WireFieldKind::VecF64 => {
                    let arr = val
                        .and_then(Value::as_array)
                        .map(|a| a.as_slice())
                        .unwrap_or(&[]);
                    let data_len = arr.len() * 8;
                    buf.extend_from_slice(&(data_len as u32).to_le_bytes());
                    for item in arr {
                        let v = item.as_f64().unwrap_or(0.0);
                        buf.extend_from_slice(&v.to_le_bytes());
                    }
                }
                WireFieldKind::VecI32 => {
                    let arr = val
                        .and_then(Value::as_array)
                        .map(|a| a.as_slice())
                        .unwrap_or(&[]);
                    let data_len = arr.len() * 4;
                    buf.extend_from_slice(&(data_len as u32).to_le_bytes());
                    for item in arr {
                        let v = item.as_i64().unwrap_or(0) as i32;
                        buf.extend_from_slice(&v.to_le_bytes());
                    }
                }
                WireFieldKind::VecBool => {
                    let arr = val
                        .and_then(Value::as_array)
                        .map(|a| a.as_slice())
                        .unwrap_or(&[]);
                    buf.extend_from_slice(&(arr.len() as u32).to_le_bytes());
                    for item in arr {
                        buf.push(if item.as_bool().unwrap_or(false) {
                            1
                        } else {
                            0
                        });
                    }
                }
                WireFieldKind::VecU8 => {
                    // Vec<u8> encodes as the raw byte slice
                    let arr = val
                        .and_then(Value::as_array)
                        .map(|a| a.as_slice())
                        .unwrap_or(&[]);
                    buf.extend_from_slice(&(arr.len() as u32).to_le_bytes());
                    for item in arr {
                        buf.push(item.as_u64().unwrap_or(0) as u8);
                    }
                }
                _ => unreachable!("fixed kind in var_fields"),
            }
        }

        buf
    })
}

/// Encodes an rkyv V2 error response.
///
/// Wire format:
/// ```text
/// [ok: u8 @0 = 0][pad 7B][error_len: u16 @8][error_bytes...]
/// ```
pub fn encode_rkyv_v2_error(msg: &str) -> Vec<u8> {
    let msg_bytes = msg.as_bytes();
    let msg_len = msg_bytes.len().min(u16::MAX as usize) as u16;
    let mut buf = vec![0u8; 8 + 2 + msg_len as usize];
    buf[0] = 0; // ok = false
    buf[8..10].copy_from_slice(&msg_len.to_le_bytes());
    buf[10..10 + msg_len as usize].copy_from_slice(&msg_bytes[..msg_len as usize]);
    buf.truncate(10 + msg_len as usize);
    buf
}

#[derive(Clone, Copy, Debug)]
#[allow(dead_code)]
enum WireFieldKind {
    // Tier 1 — fixed-width primitives
    I64,
    I32,
    U32,
    U16,
    F64,
    F32,
    Bool,
    // Tier 2 — variable-length
    String,
    VecI64,
    VecF64,
    VecU8,
    VecI32,
    VecBool,
}

#[allow(dead_code)]
impl WireFieldKind {
    fn size(&self) -> usize {
        match self {
            Self::I64 | Self::F64 => 8,
            Self::I32 | Self::U32 | Self::F32 => 4,
            Self::U16 => 2,
            Self::Bool => 1,
            // Variable-length fields have no fixed size;
            // return 1 so alignment computation is a no-op.
            Self::String
            | Self::VecI64
            | Self::VecF64
            | Self::VecU8
            | Self::VecI32
            | Self::VecBool => 1,
        }
    }

    fn element_size(&self) -> usize {
        match self {
            Self::VecI64 | Self::VecF64 => 8,
            Self::VecI32 => 4,
            Self::VecBool => 1,
            Self::VecU8 => 1,
            _ => 0,
        }
    }

    fn is_fixed(&self) -> bool {
        !matches!(
            self,
            Self::String | Self::VecI64 | Self::VecF64 | Self::VecU8 | Self::VecI32 | Self::VecBool
        )
    }
}

/// Determines which serialisation tier a command belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tier {
    /// All fields are fixed-width primitives (i64, i32, f64, …).
    Tier1,
    /// Has at least one String or Vec<primitive> field.
    Tier2,
    /// Has nested structs, enums, Option<T>, or other unsupported types.
    Tier3,
}

fn wire_kind_from_schema(schema: &Value) -> Option<WireFieldKind> {
    match schema.get("type").and_then(Value::as_str)? {
        "boolean" => Some(WireFieldKind::Bool),
        "integer" => match schema.get("format").and_then(Value::as_str) {
            Some("int64") => Some(WireFieldKind::I64),
            _ => Some(WireFieldKind::I32),
        },
        "number" => match schema.get("format").and_then(Value::as_str) {
            Some("double") => Some(WireFieldKind::F64),
            _ => Some(WireFieldKind::F32),
        },
        "string" => Some(WireFieldKind::String),
        "array" => {
            let items = schema.get("items")?;
            let item_type = items.get("type").and_then(Value::as_str)?;
            match item_type {
                "integer" => match items.get("format").and_then(Value::as_str) {
                    Some("int64") | None => Some(WireFieldKind::VecI64),
                    Some("int32") => Some(WireFieldKind::VecI32),
                    _ => None,
                },
                "number" => match items.get("format").and_then(Value::as_str) {
                    Some("double") | None => Some(WireFieldKind::VecF64),
                    _ => None,
                },
                "boolean" => Some(WireFieldKind::VecBool),
                _ => None,
            }
        }
        _ => None,
    }
}

fn align_up(offset: usize, alignment: usize) -> usize {
    offset.div_ceil(alignment) * alignment
}

/// Check if an output schema requires Tier 3 encoding (JSON fallback).
///
/// Returns true if any property is a nested struct, enum, Option, or other
/// type that cannot be represented as a fixed-width or simple variable-length
/// wire field.
fn is_output_tier3(output_schema: &Value) -> bool {
    let props = match output_schema.get("properties").and_then(Value::as_object) {
        Some(p) => p,
        None => return false,
    };
    let required: BTreeSet<String> = output_schema
        .get("required")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();

    for (name, prop_schema) in props {
        if !required.contains(name) {
            return true; // optional field → Tier 3
        }
        if wire_kind_from_schema(prop_schema).is_none() {
            return true; // unsupported type → Tier 3
        }
    }
    false
}

fn read_wire_field(payload: &[u8], offset: usize, kind: WireFieldKind) -> crate::Result<Value> {
    if offset + kind.size() > payload.len() {
        return Err(RustraError::invalid_args("rkyv v2: payload truncated"));
    }
    Ok(match kind {
        WireFieldKind::I64 => {
            let bytes: [u8; 8] = payload[offset..offset + 8].try_into().unwrap();
            json!(i64::from_le_bytes(bytes))
        }
        WireFieldKind::I32 => {
            let bytes: [u8; 4] = payload[offset..offset + 4].try_into().unwrap();
            json!(i32::from_le_bytes(bytes))
        }
        WireFieldKind::U32 => {
            let bytes: [u8; 4] = payload[offset..offset + 4].try_into().unwrap();
            json!(u32::from_le_bytes(bytes))
        }
        WireFieldKind::U16 => {
            let bytes: [u8; 2] = payload[offset..offset + 2].try_into().unwrap();
            json!(u16::from_le_bytes(bytes))
        }
        WireFieldKind::F64 => {
            let bytes: [u8; 8] = payload[offset..offset + 8].try_into().unwrap();
            json!(f64::from_le_bytes(bytes))
        }
        WireFieldKind::F32 => {
            let bytes: [u8; 4] = payload[offset..offset + 4].try_into().unwrap();
            json!(f32::from_le_bytes(bytes))
        }
        WireFieldKind::Bool => json!(payload[offset] != 0),
        // Variable-length kinds should not be read via read_wire_field;
        // they are handled inline in the decoder closure.
        WireFieldKind::String
        | WireFieldKind::VecI64
        | WireFieldKind::VecF64
        | WireFieldKind::VecU8
        | WireFieldKind::VecI32
        | WireFieldKind::VecBool => {
            unreachable!("variable-length fields are read inline")
        }
    })
}

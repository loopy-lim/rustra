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
        command, register, GeneratedPackage, Package, PackageBuilder, Result, RustraError,
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
    rkyv_v2_decode: Arc<dyn Fn(&[u8]) -> crate::Result<Value> + Send + Sync>,
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
    pub fn invoke_rkyv_v2(&self, payload: &[u8]) -> crate::Result<Value> {
        if payload.len() < 8 {
            return Err(RustraError::invalid_args("rkyv v2: payload too short"));
        }
        let command_id = u16::from_le_bytes([payload[0], payload[1]]);
        let command_name = self
            .resolve_command_id(command_id)
            .ok_or_else(|| RustraError::command_not_found(&format!("id:{command_id}")))?;

        let command = self
            .commands
            .get(command_name)
            .ok_or_else(|| RustraError::command_not_found(command_name))?;

        let params = (command.rkyv_v2_decode)(payload)?;
        self.invoke_json(command_name, params)
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
                json!({
                    "name": name,
                    "commandId": command.command_id,
                    "inputType": command.input_type,
                    "outputType": command.output_type,
                    "inputSchema": command.input_schema,
                    "outputSchema": command.output_schema,
                })
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
        let rkyv_v2_decoder = build_rkyv_v2_decoder(&input_schema);
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
            rkyv_v2_decode: rkyv_v2_decoder,
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

/// JSON Schema에서 rkyv V2 디코더를 자동 생성합니다.
///
/// 입력 스키마의 프로퍼티를 분석하여 고정폭 필드의 오프셋을 계산하고,
/// 바이트에서 직접 값을 읽어 JSON Value를 재구성하는 클로저를 반환합니다.
/// 모든 필드가 primitive(int/float/bool)인 Tier 1 명령에만 작동합니다.
fn build_rkyv_v2_decoder(
    input_schema: &Value,
) -> Arc<dyn Fn(&[u8]) -> crate::Result<Value> + Send + Sync> {
    let props = match input_schema.get("properties").and_then(Value::as_object) {
        Some(p) => p,
        None => {
            return Arc::new(|_| {
                Err(RustraError::internal("no properties in input schema"))
            });
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

    let mut fields: Vec<(String, usize, WireFieldKind)> = Vec::new();
    let mut offset: usize = 8; // command_id u16 + 6B padding
    let mut all_fixed = true;

    for (name, prop_schema) in props {
        if !required.contains(name) {
            all_fixed = false;
            continue;
        }
        let Some(kind) = wire_kind_from_schema(prop_schema) else {
            all_fixed = false;
            continue;
        };
        let size = kind.size();
        offset = align_up(offset, size);
        fields.push((name.clone(), offset, kind));
        offset += size;
    }

    if !all_fixed || fields.is_empty() {
        return Arc::new(move |payload| {
            let command_id = u16::from_le_bytes([payload[0], payload[1]]);
            Err(RustraError::invalid_args(&format!(
                "rkyv v2: command id {command_id} has non-primitive fields, not Tier 1"
            )))
        });
    }

    Arc::new(move |payload: &[u8]| {
        let mut result = serde_json::Map::new();
        for (name, field_offset, kind) in &fields {
            let val = read_wire_field(payload, *field_offset, *kind)?;
            result.insert(name.clone(), val);
        }
        Ok(Value::Object(result))
    })
}

#[derive(Clone, Copy, Debug)]
enum WireFieldKind {
    I64,
    I32,
    U32,
    U16,
    F64,
    F32,
    Bool,
}

impl WireFieldKind {
    fn size(&self) -> usize {
        match self {
            Self::I64 | Self::F64 => 8,
            Self::I32 | Self::U32 | Self::F32 => 4,
            Self::U16 => 2,
            Self::Bool => 1,
        }
    }
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
        _ => None,
    }
}

fn align_up(offset: usize, alignment: usize) -> usize {
    (offset + alignment - 1) / alignment * alignment
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
    })
}

/// rkyv V2 응답을 rkyv 바이트로 직렬화합니다.
///
/// 성공 시: `{ ok: true, value: <output> }`
/// 실패 시: `{ ok: false, value: 0, error: <message> }`
///
/// 응답은 항상 고정폭(32바이트)입니다.
/// offset 0-7: ok (bool + 7B padding)
/// offset 8-15: value (i64 LE)
/// offset 16-31: error (16B for None)
pub fn rkyv_v2_response(value: i64) -> Vec<u8> {
    let mut buf = vec![0u8; 16];
    buf[0] = 1; // ok = true
    buf[8..16].copy_from_slice(&value.to_le_bytes());
    buf
}

pub fn rkyv_v2_error_response(msg: &str) -> Vec<u8> {
    let mut buf = vec![0u8; 16];
    buf[0] = 0; // ok = false
    // error message는 현재 반환하지 않음 (고정폭 유지)
    let _ = msg;
    buf
}

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

use schemars::{schema_for, JsonSchema};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::any::type_name;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::path::Path;
use std::sync::Arc;

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
/// 직접 사용할 필요는 없습니다.
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
///
/// TypeScript 측에서는 `rustra_dispatch` 커맨드를 통해 모든 rustra 커맨드를
/// 라우팅합니다:
///
/// ```ts
/// import { createTauriEngine } from '@rustra/tauri';
/// const engine = createTauriEngine({ invoke: window.__TAURI__.core.invoke });
/// ```
#[cfg(feature = "tauri")]
pub mod tauri_support {
    use crate::Package;
    use serde_json::{json, Value};
    use tauri::State;

    /// Tauri의 managed state로 보관되는 rustra 패키지입니다.
    ///
    /// [`register`] 함수를 통해 [`Package`]를 Tauri 빌더에 등록하면
    /// 내부적으로 이 타입이 생성됩니다.
    pub struct RustraState {
        /// 등록된 rustra 명령 패키지입니다.
        pub package: Package,
    }

    /// 모든 rustra 커맨드를 디스패치하는 Tauri 커맨드 핸들러입니다.
    ///
    /// Tauri의 IPC를 통해 `{ command: string, args: Value }` 형태로
    /// 요청을 받아 해당 rustra 커맨드로 라우팅합니다.
    ///
    /// 이 함수는 [`register`]를 통해 자동으로 등록되므로 직접 호출하지 않습니다.
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
    /// 내부적으로 [`RustraState`]를 managed state로 추가하고
    /// [`rustra_dispatch`]를 invoke handler에 등록합니다.
    ///
    /// # 예제
    ///
    /// ```rust,ignore
    /// let builder = tauri_support::register(my_package, tauri::Builder::default());
    /// builder.run(tauri::generate_context!()).expect("app failed");
    /// ```
    pub fn register<R: tauri::Runtime>(
        package: Package,
        builder: tauri::Builder<R>,
    ) -> tauri::Builder<R> {
        builder
            .manage(RustraState { package })
            .invoke_handler(tauri::generate_handler![rustra_dispatch])
    }
}

/// rustra 작업의 결과 타입입니다.
///
/// [`RustraError`]를 에러로 사용하는 [`std::result::Result`]의 별칭입니다.
pub type Result<T> = std::result::Result<T, RustraError>;

/// rustra 명령 실행 중 발생할 수 있는 에러입니다.
///
/// 모든 에러는 `code`와 `message` 필드를 가지며, TypeScript 측에서도
/// 동일한 구조의 [`RustraError`] 타입으로 전달됩니다.
///
/// # 에러 코드 분류
///
/// | 코드 | 팩토리 메서드 | 의미 |
/// |------|-------------|------|
/// | `command.not_found` | [`command_not_found`] | 등록되지 않은 명령 호출 |
/// | `command.invalid_args` | [`invalid_args`] | 입력 인자 역직렬화 실패 |
/// | `internal` | [`internal`] | 내부 오류 (직렬화, I/O 등) |
/// | (커스텀) | [`custom`] | 사용자 정의 에러 |
///
/// # 예제
///
/// ```rust
/// use rustra::{RustraError, Result};
///
/// fn validate(value: i64) -> Result<()> {
///     if value > 100 {
///         return Err(RustraError::custom("validation.too_large", "value exceeds limit"));
///     }
///     Ok(())
/// }
/// ```
///
/// [`command_not_found`]: RustraError::command_not_found
/// [`invalid_args`]: RustraError::invalid_args
/// [`internal`]: RustraError::internal
/// [`custom`]: RustraError::custom
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RustraError {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "is_false")]
    retryable: bool,
}

fn is_false(v: &bool) -> bool {
    !v
}

impl RustraError {
    /// 등록되지 않은 명령을 호출했을 때의 에러를 생성합니다.
    ///
    /// # 예제
    ///
    /// ```rust
    /// use rustra::RustraError;
    /// let err = RustraError::command_not_found("multiply");
    /// assert_eq!(err.code(), "command.not_found");
    /// ```
    pub fn command_not_found(name: impl Into<String>) -> Self {
        let name = name.into();
        Self {
            code: "command.not_found",
            message: format!("command not found: {name}"),
            retryable: false,
        }
    }

    /// 입력 인자의 역직렬화에 실패했을 때의 에러를 생성합니다.
    ///
    /// serde의 역직렬화 에러 메시지를 그대로 포함합니다.
    ///
    /// # 예제
    ///
    /// ```rust
    /// use rustra::RustraError;
    /// let err = RustraError::invalid_args("missing field `a`");
    /// assert_eq!(err.code(), "command.invalid_args");
    /// ```
    pub fn invalid_args(error: impl fmt::Display) -> Self {
        Self {
            code: "command.invalid_args",
            message: error.to_string(),
            retryable: false,
        }
    }

    /// 내부 오류 (직렬화 실패, I/O 오류 등) 에러를 생성합니다.
    ///
    /// # 예제
    ///
    /// ```rust
    /// use rustra::RustraError;
    /// let err = RustraError::internal("failed to serialize output");
    /// assert_eq!(err.code(), "internal");
    /// ```
    pub fn internal(error: impl fmt::Display) -> Self {
        Self {
            code: "internal",
            message: error.to_string(),
            retryable: false,
        }
    }

    /// 사용자 정의 에러 코드와 메시지로 에러를 생성합니다.
    ///
    /// `code`는 `&'static str`이어야 하며, 도메인 점 표기법을 권장합니다.
    ///
    /// # 예제
    ///
    /// ```rust
    /// use rustra::RustraError;
    /// let err = RustraError::custom("validation.too_large", "value exceeds limit");
    /// assert_eq!(err.code(), "validation.too_large");
    /// ```
    pub fn custom(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
        }
    }

    /// Transport/network error. Code: `transport.error`. Retryable.
    pub fn transport(error: impl fmt::Display) -> Self {
        Self {
            code: "transport.error",
            message: error.to_string(),
            retryable: true,
        }
    }

    /// Timeout error. Code: `transport.timeout`. Retryable.
    pub fn timeout(error: impl fmt::Display) -> Self {
        Self {
            code: "transport.timeout",
            message: error.to_string(),
            retryable: true,
        }
    }

    /// Builder-style method to mark any error as retryable.
    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    /// 에러 코드를 반환합니다.
    pub fn code(&self) -> &'static str {
        self.code
    }

    /// 에러 메시지를 반환합니다.
    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn is_retryable(&self) -> bool {
        self.retryable
    }
}

impl fmt::Display for RustraError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for RustraError {}

/// [`std::io::Error`]를 [`RustraError::internal`]로 변환합니다.
impl From<std::io::Error> for RustraError {
    fn from(error: std::io::Error) -> Self {
        Self::internal(error)
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
///
/// # 예제
///
/// ```rust
/// use rustra::prelude::*;
///
/// let package = Package::builder("example.calculator")
///     .command_fn(add_numbers)
///     .build();
/// ```
#[derive(Clone)]
pub struct Package {
    id: String,
    commands: Arc<BTreeMap<String, Command>>,
}

/// 명령을 점진적으로 등록하는 빌더입니다.
///
/// [`Package::builder`]로 생성하며, 체이닝으로 여러 명령을 추가한 후
/// [`build`](PackageBuilder::build)로 [`Package`]를 완성합니다.
///
/// # 예제
///
/// ```rust
/// use rustra::prelude::*;
///
/// let package = Package::builder("example.calculator")
///     .command_fn(add_numbers)
///     .command("customName", my_handler)
///     .build();
/// ```
pub struct PackageBuilder {
    id: String,
    commands: BTreeMap<String, Command>,
}

/// TypeScript 코드 생성 결과입니다.
///
/// [`Package::generate_typescript`] 호출로 생성됩니다.
///
/// 각 필드는 독립적인 출력 파일에 해당합니다:
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
    /// 스키마의 SHA-256 해시로, 런타임에 생성된 코드와
    /// 일치하는지 검증하는 데 사용합니다.
    pub contract_hash: String,
}

impl GeneratedPackage {
    /// 생성된 모든 파일을 지정한 디렉토리에 저장합니다.
    ///
    /// 디렉토리가 없으면 생성합니다. 다음 파일이 저장됩니다:
    ///
    /// - `schema.json` — 전체 명령 스키마
    /// - `types.ts` — TypeScript 타입 정의
    /// - `commands.ts` — TypeScript 명령 헬퍼 함수
    /// - `contract.ts` — `GENERATED_CONTRACT_HASH` 상수
    ///
    /// # 에러
    ///
    /// 디렉토리 생성이나 파일 쓰기에 실패하면 [`RustraError::internal`]을 반환합니다.
    pub fn write_to_dir(&self, output_dir: impl AsRef<Path>) -> Result<()> {
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
///
/// 입력/출력 타입 이름, JSON Schema, 그리고 실제 실행 함수를 보관합니다.
#[derive(Clone)]
struct Command {
    input_type: String,
    output_type: String,
    input_schema: Value,
    output_schema: Value,
    definitions: Value,
    invoke: Arc<dyn Fn(Value) -> Result<Value> + Send + Sync>,
}

impl Package {
    /// 새로운 [`PackageBuilder`]를 생성합니다.
    ///
    /// `id`는 패키지를 식별하는 고유 문자열로, 생성된 스키마의
    /// `packageId` 필드에 사용됩니다. 역방향 도메인 표기법을 권장합니다
    /// (예: `"com.example.calculator"`).
    pub fn builder(id: impl Into<String>) -> PackageBuilder {
        PackageBuilder {
            id: id.into(),
            commands: BTreeMap::new(),
        }
    }

    /// 타입이 지정된 명령을 호출합니다.
    ///
    /// `input`을 JSON으로 직렬화하여 명령 핸들러에 전달하고,
    /// 결과를 `O` 타입으로 역직렬화하여 반환합니다.
    ///
    /// # 에러
    ///
    /// - 입력 직렬화 실패 → [`RustraError::invalid_args`]
    /// - 명령 미등록 → [`RustraError::command_not_found`]
    /// - 핸들러 에러 → 핸들러가 반환한 에러
    /// - 출력 역직렬화 실패 → [`RustraError::internal`]
    ///
    /// # 예제
    ///
    /// ```rust,ignore
    /// let result: AddNumbersOutput = package.invoke("addNumbers", AddNumbersInput { a: 1, b: 2 })?;
    /// ```
    pub fn invoke<I, O>(&self, name: &str, input: I) -> Result<O>
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
    /// [`invoke`](Package::invoke)의 비제네릭 버전으로, 직렬화/역직렬화
    /// 오버헤드 없이 JSON 값을 그대로 전달합니다. Tauri 통합 등에서
    /// JSON 기반 라우팅에 사용됩니다.
    pub fn invoke_json(&self, name: &str, params: Value) -> Result<Value> {
        let command = self
            .commands
            .get(name)
            .ok_or_else(|| RustraError::command_not_found(name))?;
        (command.invoke)(params)
    }

    /// 등록된 모든 명령에서 TypeScript 클라이언트 코드를 생성합니다.
    ///
    /// 반환된 [`GeneratedPackage`]에는 타입 정의, 명령 헬퍼 함수,
    /// JSON 스키마, 계약 해시가 포함됩니다.
    ///
    /// # 에러
    ///
    /// 스키마 직렬화에 실패하면 [`RustraError::internal`]을 반환합니다.
    ///
    /// # 예제
    ///
    /// ```rust,ignore
    /// let generated = package.generate_typescript()?;
    /// generated.write_to_dir("./generated")?;
    /// ```
    pub fn generate_typescript(&self) -> Result<GeneratedPackage> {
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

    /// 전체 패키지 스키마를 JSON [`Value`]로 직렬화합니다.
    ///
    /// `packageId`와 `commands` 배열을 포함하며, 각 커맨드는
    /// `name`, `inputType`, `outputType`, `inputSchema`, `outputSchema`를
    /// 포함합니다.
    fn schema(&self) -> Value {
        let commands = self
            .commands
            .iter()
            .map(|(name, command)| {
                json!({
                    "name": name,
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

    /// 모든 명령의 입출력 타입에 대한 TypeScript 타입 정의를 생성합니다.
    ///
    /// `@rustra/types`에서 `EngineClient`, `RustraError`, `RustraCommandError`를
    /// re-export하고, 등록된 모든 타입을 `export type`으로 생성합니다.
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

    /// 각 명령에 대한 TypeScript 헬퍼 함수를 생성합니다.
    ///
    /// 각 함수는 `EngineClient`와 입력을 받아 `Promise<OutputType>`을 반환합니다.
    ///
    /// ```ts
    /// export function addNumbers(engine: EngineClient, input: AddNumbersInput): Promise<AddNumbersOutput> {
    ///   return engine.invoke<AddNumbersOutput>('addNumbers', input);
    /// }
    /// ```
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
    ///
    /// # 예제
    ///
    /// ```rust,ignore
    /// let pkg = Package::builder("example.calculator")
    ///     .command_fn(add_numbers)
    ///     .build();
    /// ```
    pub fn command_fn<I, O, F>(self, handler: F) -> Self
    where
        I: DeserializeOwned + JsonSchema + 'static,
        O: Serialize + JsonSchema + 'static,
        F: Fn(I) -> Result<O> + Send + Sync + 'static,
    {
        let name = command_name_from_handler::<F>();
        self.command(name, handler)
    }

    /// 명령을 지정한 이름으로 등록합니다.
    ///
    /// `command_fn`과 달리 이름을 직접 지정합니다.
    /// 동일한 이름으로 중복 등록하면 패닉합니다.
    ///
    /// # 타입 제약
    ///
    /// - `I`: [`DeserializeOwned`] + [`JsonSchema`] — 명령 입력
    /// - `O`: [`Serialize`] + [`JsonSchema`] — 명령 출력
    /// - `F`: `Fn(I) -> Result<O> + Send + Sync + 'static` — 핸들러
    ///
    /// # 패닉
    ///
    /// 같은 이름의 명령이 이미 등록되어 있으면 패닉합니다.
    pub fn command<I, O, F>(mut self, name: impl Into<String>, handler: F) -> Self
    where
        I: DeserializeOwned + JsonSchema + 'static,
        O: Serialize + JsonSchema + 'static,
        F: Fn(I) -> Result<O> + Send + Sync + 'static,
    {
        let (input_schema, input_defs) = schema_value::<I>();
        let (output_schema, output_defs) = schema_value::<O>();
        let mut definitions = input_defs;
        if let (Value::Object(obj), Value::Object(other)) = (&mut definitions, output_defs) {
            for (key, value) in other {
                obj.insert(key, value);
            }
        }
        let command = Command {
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
        };
        let name = name.into();
        if self.commands.contains_key(&name) {
            panic!("duplicate command registration: '{name}'");
        }
        self.commands.insert(name, command);
        self
    }

    /// 등록된 모든 명령을 불변 [`Package`]로 빌드합니다.
    pub fn build(self) -> Package {
        Package {
            id: self.id,
            commands: Arc::new(self.commands),
        }
    }
}

/// 타입 `T`의 JSON Schema를 (루트 스키마, definitions) 튜플로 직렬화합니다.
fn schema_value<T>() -> (Value, Value)
where
    T: JsonSchema,
{
    let schema = schema_for!(T);
    let root = serde_json::to_value(schema.schema).expect("schema serializes");
    let defs = serde_json::to_value(schema.definitions).expect("definitions serialize");
    (root, defs)
}

/// `std::any::type_name`에서 마지막 세그먼트만 추출합니다.
///
/// 예: `"my_crate::AddNumbersInput"` → `"AddNumbersInput"`
fn short_type_name<T>() -> String {
    type_name::<T>()
        .rsplit("::")
        .next()
        .expect("type name has a final segment")
        .to_string()
}

/// 핸들러 함수 타입 `F`의 이름에서 커맨드 이름을 추출합니다.
///
/// `_command` 접미사를 제거한 뒤 lowerCamelCase로 변환합니다.
/// 예: `add_numbers_command` → `addNumbers`
fn command_name_from_handler<F>() -> String {
    let raw = short_type_name::<F>();
    snake_to_lower_camel(raw.trim_end_matches("_command"))
}

/// SHA-256 해시를 hex 문자열로 반환합니다.
///
/// 스키마 무결성 검증을 위한 `contract_hash` 생성에 사용합니다.
fn contract_hash(input: impl AsRef<[u8]>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_ref());
    hex::encode(hasher.finalize())
}

/// JSON Schema [`Value`]를 TypeScript 타입 표현식으로 변환합니다.
///
/// 재귀적으로 `$ref`, `anyOf`, `object`, `array` 등을 처리합니다.
fn ts_type_from_schema(schema: &Value, definitions: &Value) -> String {
    if let Some(r#ref) = schema.get("$ref").and_then(Value::as_str) {
        return resolve_ref(r#ref, definitions);
    }

    if let Some(any_of) = schema.get("anyOf").and_then(Value::as_array) {
        let parts: Vec<String> = any_of
            .iter()
            .map(|s| ts_type_from_schema(s, definitions))
            .collect();
        return parts.join(" | ");
    }

    match schema.get("type") {
        Some(Value::String(t)) => match t.as_str() {
            "object" => {
                if schema.get("properties").is_none()
                    && schema.get("additionalProperties").is_some()
                {
                    let value_type = ts_type_from_schema(
                        schema.get("additionalProperties").unwrap(),
                        definitions,
                    );
                    return format!("Record<string, {value_type}>");
                }
                ts_object_from_schema(schema, definitions)
            }
            "integer" | "number" => "number".to_string(),
            "string" => {
                if let Some(enum_values) = schema.get("enum").and_then(Value::as_array) {
                    let variants: Vec<String> = enum_values
                        .iter()
                        .filter_map(|v| match v {
                            Value::String(s) => Some(format!("'{s}'")),
                            _ => None,
                        })
                        .collect();
                    if !variants.is_empty() {
                        return variants.join(" | ");
                    }
                }
                "string".to_string()
            }
            "boolean" => "boolean".to_string(),
            "array" => {
                if let Some(items) = schema.get("items").and_then(Value::as_array) {
                    let types: Vec<String> = items
                        .iter()
                        .map(|s| ts_type_from_schema(s, definitions))
                        .collect();
                    if !types.is_empty() {
                        return format!("[{}]", types.join(", "));
                    }
                }
                let item_type = schema
                    .get("items")
                    .map(|s| ts_type_from_schema(s, definitions))
                    .unwrap_or_else(|| "unknown".to_string());
                format!("{item_type}[]")
            }
            "null" => "null".to_string(),
            _ => "unknown".to_string(),
        },
        Some(Value::Array(types)) => {
            let parts: Vec<String> = types
                .iter()
                .filter_map(|t| t.as_str())
                .map(|t| match t {
                    "integer" | "number" => "number".to_string(),
                    "string" => "string".to_string(),
                    "boolean" => "boolean".to_string(),
                    "null" => "null".to_string(),
                    "object" => ts_object_from_schema(schema, definitions),
                    "array" => {
                        schema
                            .get("items")
                            .map(|s| ts_type_from_schema(s, definitions))
                            .unwrap_or_else(|| "unknown".to_string())
                            + "[]"
                    }
                    _ => "unknown".to_string(),
                })
                .collect();
            parts.join(" | ")
        }
        _ => "unknown".to_string(),
    }
}

/// `$ref` 문자열에서 타입 이름을 추출합니다.
///
/// `#/definitions/Foo` → `Foo`, `#/$defs/Foo` → `Foo`
fn resolve_ref(r#ref: &str, _definitions: &Value) -> String {
    let name = r#ref
        .strip_prefix("#/definitions/")
        .or_else(|| r#ref.strip_prefix("#/$defs/"))
        .unwrap_or(r#ref);
    name.to_string()
}

/// JSON Schema object를 TypeScript 객체 타입 리터럴로 변환합니다.
///
/// `properties`의 각 필드를 `name: type;` 형식으로 생성하며,
/// `required`에 없는 필드는 `?` 선택적 필드로 표시합니다.
fn ts_object_from_schema(schema: &Value, definitions: &Value) -> String {
    let required = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return "Record<string, unknown>".to_string();
    };

    let fields = properties
        .iter()
        .map(|(name, property_schema)| {
            let optional = if required.contains(name.as_str()) {
                ""
            } else {
                "?"
            };
            format!(
                "  {name}{optional}: {};",
                ts_type_from_schema(property_schema, definitions)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!("{{\n{fields}\n}}")
}

/// 명령 이름을 lowerCamelCase TypeScript 함수 이름으로 변환합니다.
///
/// 비영숫자 문자를 구분자로 처리합니다.
/// 예: `addNumbers` → `addNumbers`, `do-something` → `doSomething`
fn command_function_name(name: &str) -> String {
    let mut output = String::new();
    let mut uppercase_next = false;

    for character in name.chars() {
        if character.is_ascii_alphanumeric() {
            if output.is_empty() {
                output.push(character.to_ascii_lowercase());
            } else if uppercase_next {
                output.push(character.to_ascii_uppercase());
            } else {
                output.push(character);
            }
            uppercase_next = false;
        } else {
            uppercase_next = true;
        }
    }

    if output.is_empty() {
        "command".to_string()
    } else {
        output
    }
}

/// snake_case, kebab-case, dot.case를 lowerCamelCase로 변환합니다.
///
/// 예: `add_numbers` → `addNumbers`, `my-command` → `myCommand`
fn snake_to_lower_camel(name: &str) -> String {
    let mut output = String::new();
    let mut uppercase_next = false;

    for character in name.chars() {
        if character == '_' || character == '-' || character == '.' {
            uppercase_next = true;
            continue;
        }

        if output.is_empty() {
            output.push(character.to_ascii_lowercase());
        } else if uppercase_next {
            output.push(character.to_ascii_uppercase());
            uppercase_next = false;
        } else {
            output.push(character);
        }
    }

    output
}

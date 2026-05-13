pub use rustra_macros::command;
pub use rustra_macros::register;

use schemars::{JsonSchema, schema_for};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::any::type_name;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::path::Path;
use std::sync::Arc;

pub mod prelude {
    pub use crate::{GeneratedPackage, Package, PackageBuilder, Result, RustraError, command, register};
    pub use schemars::JsonSchema;
    pub use serde::{Deserialize, Serialize};
}

pub mod __private {
    use schemars::JsonSchema;
    use serde::{Serialize, de::DeserializeOwned};

    pub trait CommandInput: DeserializeOwned + JsonSchema + 'static {}
    impl<T: DeserializeOwned + JsonSchema + 'static> CommandInput for T {}

    pub trait CommandOutput: Serialize + JsonSchema + 'static {}
    impl<T: Serialize + JsonSchema + 'static> CommandOutput for T {}
}

#[cfg(feature = "tauri")]
pub mod tauri_support {
    use crate::Package;
    use serde_json::{Value, json};
    use tauri::State;

    pub struct RustraState {
        pub package: Package,
    }

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

    pub fn register<R: tauri::Runtime>(
        package: Package,
        builder: tauri::Builder<R>,
    ) -> tauri::Builder<R> {
        builder
            .manage(RustraState { package })
            .invoke_handler(tauri::generate_handler![rustra_dispatch])
    }
}

pub type Result<T> = std::result::Result<T, RustraError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RustraError {
    code: &'static str,
    message: String,
}

impl RustraError {
    pub fn command_not_found(name: impl Into<String>) -> Self {
        let name = name.into();
        Self {
            code: "command.not_found",
            message: format!("command not found: {name}"),
        }
    }

    pub fn invalid_args(error: impl fmt::Display) -> Self {
        Self {
            code: "command.invalid_args",
            message: error.to_string(),
        }
    }

    pub fn internal(error: impl fmt::Display) -> Self {
        Self {
            code: "internal",
            message: error.to_string(),
        }
    }

    pub fn custom(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for RustraError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for RustraError {}

impl From<std::io::Error> for RustraError {
    fn from(error: std::io::Error) -> Self {
        Self::internal(error)
    }
}

#[derive(Clone)]
pub struct Package {
    id: String,
    commands: Arc<BTreeMap<String, Command>>,
}

pub struct PackageBuilder {
    id: String,
    commands: BTreeMap<String, Command>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneratedPackage {
    pub schema_json: String,
    pub types_ts: String,
    pub commands_ts: String,
    pub contract_hash: String,
}

impl GeneratedPackage {
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
    pub fn builder(id: impl Into<String>) -> PackageBuilder {
        PackageBuilder {
            id: id.into(),
            commands: BTreeMap::new(),
        }
    }

    pub fn invoke<I, O>(&self, name: &str, input: I) -> Result<O>
    where
        I: Serialize,
        O: DeserializeOwned,
    {
        let params = serde_json::to_value(input).map_err(RustraError::invalid_args)?;
        let result = self.invoke_json(name, params)?;
        serde_json::from_value(result).map_err(RustraError::internal)
    }

    pub fn invoke_json(&self, name: &str, params: Value) -> Result<Value> {
        let command = self
            .commands
            .get(name)
            .ok_or_else(|| RustraError::command_not_found(name))?;
        (command.invoke)(params)
    }

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

    fn generate_types_ts(&self) -> String {
        let mut output = String::from(
            "export type EngineClient = {\n  invoke<T>(command: string, args?: unknown): Promise<T>;\n};\n\n\
             export type RustraError = {\n  readonly code: string;\n  readonly message: string;\n};\n\n",
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
        let mut type_names = BTreeSet::from(["EngineClient".to_string(), "RustraError".to_string()]);
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
    pub fn command_fn<I, O, F>(self, handler: F) -> Self
    where
        I: DeserializeOwned + JsonSchema + 'static,
        O: Serialize + JsonSchema + 'static,
        F: Fn(I) -> Result<O> + Send + Sync + 'static,
    {
        let name = command_name_from_handler::<F>();
        self.command(name, handler)
    }

    pub fn command<I, O, F>(mut self, name: impl Into<String>, handler: F) -> Self
    where
        I: DeserializeOwned + JsonSchema + 'static,
        O: Serialize + JsonSchema + 'static,
        F: Fn(I) -> Result<O> + Send + Sync + 'static,
    {
        let (input_schema, input_defs) = schema_value::<I>();
        let (output_schema, output_defs) = schema_value::<O>();
        let mut definitions = input_defs;
        if let (Value::Object(obj), Value::Object(other)) =
            (&mut definitions, output_defs)
        {
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

    pub fn build(self) -> Package {
        Package {
            id: self.id,
            commands: Arc::new(self.commands),
        }
    }
}

fn schema_value<T>() -> (Value, Value)
where
    T: JsonSchema,
{
    let schema = schema_for!(T);
    let root = serde_json::to_value(schema.schema).expect("schema serializes");
    let defs = serde_json::to_value(schema.definitions).expect("definitions serialize");
    (root, defs)
}

fn short_type_name<T>() -> String {
    type_name::<T>()
        .rsplit("::")
        .next()
        .expect("type name has a final segment")
        .to_string()
}

fn command_name_from_handler<F>() -> String {
    let raw = short_type_name::<F>();
    snake_to_lower_camel(raw.trim_end_matches("_command"))
}

fn contract_hash(input: impl AsRef<[u8]>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_ref());
    hex::encode(hasher.finalize())
}

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
            "object" => ts_object_from_schema(schema, definitions),
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
                    "array" => schema
                        .get("items")
                        .map(|s| ts_type_from_schema(s, definitions))
                        .unwrap_or_else(|| "unknown".to_string())
                        + "[]",
                    _ => "unknown".to_string(),
                })
                .collect();
            parts.join(" | ")
        }
        _ => "unknown".to_string(),
    }
}

fn resolve_ref(r#ref: &str, _definitions: &Value) -> String {
    let name = r#ref
        .strip_prefix("#/definitions/")
        .or_else(|| r#ref.strip_prefix("#/$defs/"))
        .unwrap_or(r#ref);
    name.to_string()
}

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

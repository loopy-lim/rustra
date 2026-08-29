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

#[path = "private.rs"]
pub mod __private;
mod builder;
pub mod byte_buffer;
pub mod cancel;
pub mod channels;
mod codegen;
mod command;
mod complex_codec;
mod entry;
mod error;
pub mod events;
mod executor;
pub mod ffi;
mod invoke;
mod limits;
mod package;
mod package_codegen;
pub mod prelude;
mod registry;
#[doc(hidden)]
pub mod renderer_host;
mod rkyv_codec;
mod schema;
pub mod state;
#[cfg(feature = "tauri")]
pub mod tauri_support;

pub(crate) use command::{
    Command, build_command, generated_byte_field_name, generated_field_names,
};
pub(crate) use package::{FrozenRegistry, RegistryState};
pub use package::{GeneratedPackage, Package, PackageBuilder};

pub(crate) use schemars::JsonSchema;
pub(crate) use serde::{Serialize, de::DeserializeOwned};
pub(crate) use serde_json::{Value, json};
pub(crate) use std::collections::{BTreeMap, BTreeSet};
pub(crate) use std::fs;
pub(crate) use std::path::{Path, PathBuf};
pub(crate) use std::sync::atomic::{AtomicBool, Ordering};
pub(crate) use std::sync::{Arc, OnceLock, RwLock};

pub(crate) use complex_codec::{
    ComplexCodecLimits, annotate_variant_order, complex_decode, complex_encode,
    complex_encode_into, complex_schema_supported,
};
pub(crate) use rkyv_codec::{
    BinHandler, BinIntoHandler, DecodeFn, DirectResponse, EncodeFn, RawHandler,
    build_rkyv_v2_decoder, build_rkyv_v2_response_encoder, build_tier3_json_decoder,
    js_postcard_codec_supported_with_defs,
};

pub(crate) use codegen::{command_function_name, contract_hash, ts_type_from_schema};
pub use error::{Result, RustraError};
pub(crate) use schema::{command_name_from_handler, schema_value, short_type_name};
pub use state::{State, get_state, with_state_context};

/// Input boundary for a command whose entire payload is one contiguous byte
/// buffer. Implementations must create an owned Rust value; the native host's
/// borrowed pointer is never retained after the synchronous call returns.
pub trait BufferCommandInput: DeserializeOwned + JsonSchema + 'static {
    fn from_buffer(bytes: Vec<u8>) -> Self;
}

/// Output boundary paired with [`BufferCommandInput`]. Returning the owned
/// vector lets the FFI transfer that allocation without a postcard frame copy.
pub trait BufferCommandOutput: Serialize + JsonSchema + 'static {
    fn into_buffer(self) -> Vec<u8>;
}

fn postcard_uvar_len(mut value: usize) -> usize {
    let mut len = 1;
    while value >= 0x80 {
        value >>= 7;
        len += 1;
    }
    len
}
#[cfg(test)]
mod buffer_invoke_tests;
#[cfg(test)]
mod complex_into_tests;
#[cfg(test)]
mod raw_invoke_tests;
#[cfg(test)]
mod runtime_registry_tests;

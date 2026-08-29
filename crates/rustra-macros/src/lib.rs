//! # rustra-macros — rustra용 proc macro
//!
//! `#[command]` 속성 매크로와 `register!` / `build!` 매크로를 제공합니다.
//!
//! 직접 이 crate를 사용하지 말고 `rustra` crate를 통해 사용하세요:
//!
//! ```rust
//! use rustra::prelude::*;
//!
//! #[bridge_type]
//! struct AddInput { a: i64, b: i64 }
//! #[bridge_type]
//! struct AddOutput { sum: i64 }
//!
//! #[command]
//! fn add_numbers(input: AddInput) -> Result<AddOutput> {
//!     Ok(AddOutput { sum: input.a + input.b })
//! }
//! ```

use proc_macro::TokenStream;
use proc_macro2::TokenStream as TokenStream2;
use quote::quote;
use rustra_naming::snake_to_lower_camel;
use syn::{
    DeriveInput, GenericArgument, Ident, ItemFn, LitStr, PathArguments, ReturnType, Token, Type,
    parse::Parse, parse::ParseStream, parse_macro_input,
};

include!("macro_command_support.rs");

include!("macro_command.rs");

include!("macro_register.rs");

include!("macro_bridge_type.rs");

include!("macro_build.rs");

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

// unsafe 전무 실측 후 금지 — 이 크레이트의 `unsafe` 토큰은 quote! 가 생성하는
// 사용자 측 코드(capability 래퍼)용이며, 매크로 크레이트 자체에는 unsafe 아이템이
// 없다. 자체 unsafe 도입을 빌드 시점에 원천 차단한다.
#![forbid(unsafe_code)]

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

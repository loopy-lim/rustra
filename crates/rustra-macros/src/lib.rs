//! # rustra-macros — rustra용 proc macro
//!
//! `#[command]` 속성 매크로와 `register!` 매크로를 제공합니다.
//!
//! 직접 이 crate를 사용하지 말고 `rustra` crate를 통해 사용하세요:
//!
//! ```rust,ignore
//! use rustra::prelude::*;
//!
//! #[command]
//! fn add_numbers(input: AddInput) -> Result<AddOutput> { ... }
//! ```

use proc_macro::TokenStream;
use proc_macro2::TokenStream as TokenStream2;
use quote::quote;
use syn::{
    DeriveInput, GenericArgument, Ident, ItemFn, LitStr, PathArguments, ReturnType, Token, Type,
    parse::Parse, parse::ParseStream, parse_macro_input,
};

/// `#[command]` 속성의 파싱 결과입니다.
///
/// `#[command]` 또는 `#[command(name = "customName")]` 형태를 지원합니다.
struct CommandAttr {
    /// 명시적으로 지정한 명령 이름. 없으면 함수 이름에서 자동 추론합니다.
    name: Option<String>,
}

/// `#[command]` 속성의 입력을 파싱합니다.
///
/// 빈 입력(`#[command]`)이면 `name: None`, `#[command(name = "foo")]`면 `name: Some("foo")`입니다.
impl Parse for CommandAttr {
    fn parse(input: ParseStream) -> syn::Result<Self> {
        if input.is_empty() {
            return Ok(CommandAttr { name: None });
        }

        let key: Ident = input.parse()?;
        if key != "name" {
            return Err(syn::Error::new(key.span(), "expected `name`"));
        }
        let _: Token![=] = input.parse()?;
        let name: LitStr = input.parse()?;

        Ok(CommandAttr {
            name: Some(name.value()),
        })
    }
}

/// 함수를 rustra 명령으로 등록하는 속성 매크로입니다.
///
/// ## 제약 사항
///
/// - 정확히 하나의 입력 파라미터를 가져야 합니다.
/// - 반환 타입은 `Result<O>` 형태여야 합니다.
/// - 입력 타입 `I`는 `DeserializeOwned + JsonSchema`를 충족해야 합니다.
/// - 출력 타입 `O`는 `Serialize + JsonSchema`를 충족해야 합니다.
///
/// ## 명령 이름 규칙
///
/// - `#[command]`: 함수 이름에서 `_command` 접미사를 제거한 뒤 lowerCamelCase로 변환
///   (예: `add_numbers` → `addNumbers`)
/// - `#[command(name = "customName")]`: 지정한 이름을 그대로 사용
///
/// ## 컴파일 타임 검증
///
/// 매크로는 다음을 자동으로 검증합니다:
/// - 입력 파라미터가 정확히 하나인지
/// - 반환 타입이 `Result<O>` 형태인지
/// - 입출력 타입이 필요한 trait bound를 충족하는지
///
/// ## 예제
///
/// ```rust,ignore
/// #[command]
/// fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
///     Ok(AddNumbersOutput { value: input.a + input.b })
/// }
///
/// #[command(name = "multiply")]
/// fn mul(input: MulInput) -> Result<MulOutput> { ... }
/// ```
#[proc_macro_attribute]
pub fn command(attr: TokenStream, item: TokenStream) -> TokenStream {
    let attr = parse_macro_input!(attr as CommandAttr);
    let func = parse_macro_input!(item as ItemFn);

    if func.sig.inputs.is_empty() {
        return syn::Error::new_spanned(
            &func.sig,
            "#[command] requires exactly one input parameter, but none were provided",
        )
        .to_compile_error()
        .into();
    }

    if func.sig.inputs.len() > 1 {
        return syn::Error::new_spanned(
            &func.sig.inputs[1],
            "#[command] requires exactly one input parameter; remove additional parameters",
        )
        .to_compile_error()
        .into();
    }

    if func.sig.asyncness.is_some() {
        return syn::Error::new_spanned(
            func.sig.fn_token,
            "#[command] functions must be synchronous — use `fn` not `async fn`",
        )
        .to_compile_error()
        .into();
    }

    let input_type = match &func.sig.inputs[0] {
        syn::FnArg::Typed(pat_type) => &*pat_type.ty,
        _ => {
            return syn::Error::new_spanned(
                &func.sig.inputs[0],
                "#[command] parameter must be a typed value (e.g., `input: MyInput`), not `self`",
            )
            .to_compile_error()
            .into();
        }
    };

    let output_type = match &func.sig.output {
        ReturnType::Type(_, ty) => match extract_result_inner(ty) {
            Some(inner) => inner,
            None => {
                return syn::Error::new_spanned(
                    ty,
                    "#[command] must return `Result<O>` where O: Serialize + JsonSchema",
                )
                .to_compile_error()
                .into();
            }
        },
        _ => {
            return syn::Error::new_spanned(
                &func.sig,
                "#[command] must have an explicit return type `Result<O>`",
            )
            .to_compile_error()
            .into();
        }
    };

    let fn_name = &func.sig.ident;
    let command_name = attr.name.unwrap_or_else(|| {
        let raw = fn_name.to_string();
        snake_to_lower_camel(raw.trim_end_matches("_command"))
    });
    let meta_ident = Ident::new(
        &format!("__RUstra_meta_{}", fn_name),
        proc_macro2::Span::call_site(),
    );

    let expanded = quote! {
        #func

        #[allow(non_upper_case_globals, dead_code)]
        const #meta_ident: &str = #command_name;

        #[allow(dead_code)]
        const _: () = {
            fn _assert_command_bounds<
                __I: rustra::__private::CommandInput,
                __O: rustra::__private::CommandOutput,
            >() {
            }
            fn _check_command_bounds() {
                _assert_command_bounds::<#input_type, #output_type>();
            }
        };
    };

    expanded.into()
}

/// `register!` 매크로의 파싱 결과입니다.
///
/// 형태: `<builder_expr>, <fn_ident>, <fn_ident>, ...`
struct RegisterInput {
    /// 패키지 빌더 표현식 (예: `Package::builder("my.pkg")`)
    builder: syn::Expr,
    /// 등록할 `#[command]` 함수 식별자 목록입니다.
    commands: Vec<Ident>,
}

/// `register!` 매크로 입력을 파싱합니다.
///
/// 형태: `<builder>, <fn1>, <fn2>, ...` (쉼표로 구분, 마지막 쉼표는 선택)
impl Parse for RegisterInput {
    fn parse(input: ParseStream) -> syn::Result<Self> {
        let builder: syn::Expr = input.parse()?;
        let _: Token![,] = input.parse()?;

        let mut commands = Vec::new();
        loop {
            let name: Ident = input.parse()?;
            commands.push(name);
            if input.parse::<Token![,]>().is_err() {
                break;
            }
        }

        Ok(RegisterInput { builder, commands })
    }
}

/// Registers `#[command]` functions with a package builder.
///
/// ```ignore
/// rustra::register!(Package::builder("my.pkg"), add_numbers, multiply)
///     .build()
/// ```
#[proc_macro]
pub fn register(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as RegisterInput);

    if input.commands.is_empty() {
        return syn::Error::new(
            proc_macro2::Span::call_site(),
            "register! requires at least one command function after the builder expression",
        )
        .to_compile_error()
        .into();
    }

    let builder = &input.builder;
    let chain: TokenStream2 = input
        .commands
        .iter()
        .map(|fn_name| {
            let meta_ident = Ident::new(
                &format!("__RUstra_meta_{}", fn_name),
                proc_macro2::Span::call_site(),
            );
            quote! { .command(#meta_ident, #fn_name) }
        })
        .collect();

    let expanded = quote! {
        #builder #chain
    };

    expanded.into()
}

/// `Result<O>` 타입에서 내부 `O` 타입을 추출합니다.
///
/// `Result<O>`가 아니면 `None`을 반환합니다.
fn extract_result_inner(ty: &Type) -> Option<TokenStream2> {
    let Type::Path(type_path) = ty else {
        return None;
    };
    let segment = type_path.path.segments.last()?;
    if segment.ident != "Result" {
        return None;
    }
    let PathArguments::AngleBracketed(args) = &segment.arguments else {
        return None;
    };
    let GenericArgument::Type(inner_ty) = args.args.first()? else {
        return None;
    };
    Some(quote! { #inner_ty })
}

/// struct/enum에 bridge에 필요한 derive와 serde 설정을 자동 추가하는 속성 매크로입니다.
///
/// 다음을 자동으로 추가합니다:
/// - `#[derive(Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]`
/// - `#[serde(rename_all = "camelCase")]` (기존 serde rename 속성이 없을 시)
///
/// ## 예제
///
/// ```rust,ignore
/// #[bridge_type]
/// #[derive(Clone)]
/// struct AddNumbersInput { a: i64, b: i64 }
/// ```
#[proc_macro_attribute]
pub fn bridge_type(_attr: TokenStream, item: TokenStream) -> TokenStream {
    let mut input = parse_macro_input!(item as DeriveInput);

    // Add derive attributes for bridge-required traits
    input.attrs.push(syn::parse_quote! {
        #[derive(Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
    });

    // Add serde rename_all = "camelCase" only if no serde(rename_all = ...) exists
    let has_serde_rename = input.attrs.iter().any(|attr| {
        if !attr.path().is_ident("serde") {
            return false;
        }
        let Ok(nested) = attr.parse_args_with(
            syn::punctuated::Punctuated::<syn::MetaNameValue, syn::Token![,]>::parse_terminated,
        ) else {
            return false;
        };
        nested.iter().any(|nv| nv.path.is_ident("rename_all"))
    });

    if !has_serde_rename {
        input.attrs.push(syn::parse_quote! {
            #[serde(rename_all = "camelCase")]
        });
    }

    quote! { #input }.into()
}

/// `build!` 매크로의 파싱 결과입니다.
///
/// 형태: `"package.name", <fn_ident>, <fn_ident>, ...`
struct BuildInput {
    package_name: LitStr,
    commands: Vec<Ident>,
}

impl Parse for BuildInput {
    fn parse(input: ParseStream) -> syn::Result<Self> {
        let package_name: LitStr = input.parse()?;
        let _: Token![,] = input.parse()?;

        let mut commands = Vec::new();
        loop {
            if input.is_empty() {
                break;
            }
            let name: Ident = input.parse()?;
            commands.push(name);
            if input.parse::<Token![,]>().is_err() {
                break;
            }
        }

        if commands.is_empty() {
            return Err(syn::Error::new(
                package_name.span(),
                "build! requires at least one command function after the package name",
            ));
        }

        Ok(BuildInput {
            package_name,
            commands,
        })
    }
}

/// `#[command]` 함수들을 간결하게 등록하는 매크로입니다.
///
/// `register!(Package::builder("name"), fn1, fn2).build()` 대신
/// `rustra::build!("name", fn1, fn2).done()`을 사용할 수 있습니다.
///
/// ## 예제
///
/// ```rust,ignore
/// pub fn my_package() -> Package {
///     rustra::build!("com.example.my", add_numbers, multiply).done()
/// }
/// ```
#[proc_macro]
pub fn build(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as BuildInput);

    let package_name = &input.package_name;
    let chain: TokenStream2 = input
        .commands
        .iter()
        .map(|fn_name| {
            let meta_ident = Ident::new(
                &format!("__RUstra_meta_{}", fn_name),
                proc_macro2::Span::call_site(),
            );
            quote! { .command(#meta_ident, #fn_name) }
        })
        .collect();

    let expanded = quote! {
        rustra::Package::builder(#package_name) #chain
    };

    expanded.into()
}

/// snake_case, kebab-case를 lowerCamelCase로 변환합니다.
///
/// 예: `add_numbers` → `addNumbers`, `my_func_command` → `myFunc`
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

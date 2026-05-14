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
    Attribute, DeriveInput, Ident, LitStr, Meta,
    parse::Parse, parse::ParseStream, parse_macro_input, parse_quote, GenericArgument, ItemFn, PathArguments,
    ReturnType, Token, Type,
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

    if func.sig.inputs.len() != 1 {
        return syn::Error::new_spanned(
            &func.sig,
            "#[command] function must have exactly one input parameter",
        )
        .to_compile_error()
        .into();
    }

    let input_type = match &func.sig.inputs[0] {
        syn::FnArg::Typed(pat_type) => &*pat_type.ty,
        _ => {
            return syn::Error::new_spanned(
                &func.sig.inputs[0],
                "#[command] function must take a typed parameter",
            )
            .to_compile_error()
            .into();
        }
    };

    let output_type = match &func.sig.output {
        ReturnType::Type(_, ty) => match extract_result_inner(ty) {
            Some(inner) => inner,
            None => {
                return syn::Error::new_spanned(ty, "#[command] must return Result<O>")
                    .to_compile_error()
                    .into();
            }
        },
        _ => {
            return syn::Error::new_spanned(&func.sig, "#[command] must return Result<O>")
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

/// Struct/enum에 `Debug`, `Serialize`, `Deserialize`, `JsonSchema` derive와
/// `#[serde(rename_all = "camelCase")]`를 자동 추가하는 속성 매크로입니다.
///
/// `#[bridge(rename_all = "snake_case")]`로 기본 `camelCase`를 오버라이드할 수 있습니다.
/// 이미 `#[serde(rename_all = ...)]`가 있으면 그 값을 유지합니다.
///
/// ## 예제
///
/// ```rust,ignore
/// #[rustra::bridge_type]
/// struct MyInput {
///     field_name: String, // → "fieldName" in JSON
/// }
///
/// #[rustra::bridge_type]
/// #[bridge(rename_all = "snake_case")]
/// struct RawInput {
///     field_name: String, // → "field_name" in JSON
/// }
/// ```
#[proc_macro_attribute]
pub fn bridge_type(_attr: TokenStream, item: TokenStream) -> TokenStream {
    let input = parse_macro_input!(item as DeriveInput);

    // Check if rename_all is already specified in #[serde(...)] or #[bridge(...)]
    let existing_rename_all = find_rename_all(&input.attrs);
    let bridge_rename = find_bridge_rename_all(&input.attrs);

    // Determine the final rename_all value
    let rename_all_lit = match (&existing_rename_all, &bridge_rename) {
        (Some(existing), _) => existing.clone(), // serde attr takes precedence
        (None, Some(bridge)) => bridge.clone(),  // bridge attr overrides default
        (None, None) => "camelCase".to_string(), // default
    };

    // Remove #[bridge(...)] attributes — they are consumed, not passed through
    let mut filtered_attrs: Vec<Attribute> = input
        .attrs
        .iter()
        .filter(|attr| !is_bridge_attr(attr))
        .cloned()
        .collect();

    // Build the new derive and serde attributes
    let derive_attr: Attribute = parse_quote! {
        #[derive(Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
    };
    let serde_attr: Attribute = parse_quote! {
        #[serde(rename_all = #rename_all_lit)]
    };

    // Prepend our new attributes (derive first, then serde)
    filtered_attrs.insert(0, derive_attr);
    filtered_attrs.insert(1, serde_attr);

    let vis = &input.vis;
    let ident = &input.ident;
    let generics = &input.generics;
    let where_clause = &generics.where_clause;
    let body_tokens = match &input.data {
        syn::Data::Struct(data) => {
            let fields = &data.fields;
            quote! { #fields }
        }
        syn::Data::Enum(data) => {
            let variants = &data.variants;
            quote! { #variants }
        }
        syn::Data::Union(data) => {
            let fields = &data.fields;
            quote! { #fields }
        }
    };

    let item_type = match &input.data {
        syn::Data::Struct(_) => quote! { struct },
        syn::Data::Enum(_) => quote! { enum },
        syn::Data::Union(_) => quote! { union },
    };

    let expanded = quote! {
        #(#filtered_attrs)*
        #vis #item_type #ident #generics #where_clause #body_tokens
    };

    expanded.into()
}

/// Find `rename_all` value in `#[serde(rename_all = "...")]` attributes.
fn find_rename_all(attrs: &[Attribute]) -> Option<String> {
    for attr in attrs {
        if attr.path().is_ident("serde") {
            if let Meta::List(list) = &attr.meta {
                let nested: Result<Vec<Meta>, _> = list.parse_args_with(
                    syn::punctuated::Punctuated::<Meta, Token![,]>::parse_terminated
                ).map(|p| p.into_iter().collect());
                if let Ok(metas) = nested {
                    for meta in metas {
                        if let Meta::NameValue(nv) = meta {
                            if nv.path.is_ident("rename_all") {
                                if let syn::Expr::Lit(syn::ExprLit {
                                    lit: syn::Lit::Str(s),
                                    ..
                                }) = &nv.value {
                                    return Some(s.value());
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

/// Find `rename_all` value in `#[bridge(rename_all = "...")]` attributes.
fn find_bridge_rename_all(attrs: &[Attribute]) -> Option<String> {
    for attr in attrs {
        if attr.path().is_ident("bridge") {
            if let Meta::List(list) = &attr.meta {
                let nested: Result<Vec<Meta>, _> = list.parse_args_with(
                    syn::punctuated::Punctuated::<Meta, Token![,]>::parse_terminated
                ).map(|p| p.into_iter().collect());
                if let Ok(metas) = nested {
                    for meta in metas {
                        if let Meta::NameValue(nv) = meta {
                            if nv.path.is_ident("rename_all") {
                                if let syn::Expr::Lit(syn::ExprLit {
                                    lit: syn::Lit::Str(s),
                                    ..
                                }) = &nv.value {
                                    return Some(s.value());
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

/// Check if an attribute is `#[bridge(...)]`.
fn is_bridge_attr(attr: &Attribute) -> bool {
    attr.path().is_ident("bridge")
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

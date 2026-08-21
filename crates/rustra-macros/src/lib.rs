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
use syn::{
    DeriveInput, GenericArgument, Ident, ItemFn, LitStr, PathArguments, ReturnType, Token, Type,
    parse::Parse, parse::ParseStream, parse_macro_input,
};

/// `#[command]` 속성의 파싱 결과입니다.
///
/// `#[command]`, `#[command(name = "customName")]`,
/// `#[command(capability = "compute:secure")]` 형태를 지원합니다.
struct CommandAttr {
    /// 명시적으로 지정한 명령 이름. 없으면 함수 이름에서 자동 추론합니다.
    name: Option<String>,
    /// 이 명령이 요구하는 capability. `require_capability` 문자열 결합을 대체한다.
    capability: Option<String>,
}

/// `#[command]` 속성의 입력을 파싱합니다.
///
/// 빈 입력(`#[command]`)이면 둘 다 `None`. `name = "foo"` / `capability = "cap"` 키를
/// 쉼표로 구분해 받는다. 알 수 없는 키는 지원 목록을 안내하는 에러가 된다.
impl Parse for CommandAttr {
    fn parse(input: ParseStream) -> syn::Result<Self> {
        let mut attr = CommandAttr {
            name: None,
            capability: None,
        };
        if input.is_empty() {
            return Ok(attr);
        }

        loop {
            let key: Ident = input.parse()?;
            if key == "name" {
                let _: Token![=] = input.parse()?;
                let name: LitStr = input.parse()?;
                attr.name = Some(name.value());
            } else if key == "capability" {
                let _: Token![=] = input.parse()?;
                let cap: LitStr = input.parse()?;
                attr.capability = Some(cap.value());
            } else {
                return Err(syn::Error::new(
                    key.span(),
                    "unsupported `#[command]` key; supported keys: `name`, `capability`",
                ));
            }
            if input.parse::<Token![,]>().is_err() {
                break;
            }
        }

        Ok(attr)
    }
}

/// 함수를 rustra 명령으로 등록하는 속성 매크로입니다.
///
/// ## 지원 기능
///
/// - 동기(`fn`) 및 비동기(`async fn`) 함수 지원
/// - 0개 인자(`fn ping() -> Result<()>`) 및 1개 데이터 인자(`fn add(input: Input) -> Result<Output>`)
/// - `State<T>` 의존성 자동 주입 (`fn get(input: In, db: State<Db>) -> Result<Out>`)
/// - Rust doc comment(`///`)를 추출하여 메타데이터에 보존
///
/// ## 명령 이름 규칙
///
/// - `#[command]`: 함수 이름에서 `_command` 접미사를 제거한 뒤 lowerCamelCase로 변환
///   (예: `add_numbers` → `addNumbers`)
/// - `#[command(name = "customName")]`: 지정한 이름을 그대로 사용
#[proc_macro_attribute]
pub fn command(attr: TokenStream, item: TokenStream) -> TokenStream {
    let attr = parse_macro_input!(attr as CommandAttr);
    let func = parse_macro_input!(item as ItemFn);

    // Extract doc comments
    let docs: Vec<String> = func
        .attrs
        .iter()
        .filter_map(|attr| {
            if attr.path().is_ident("doc")
                && let syn::Meta::NameValue(nv) = &attr.meta
                && let syn::Expr::Lit(syn::ExprLit {
                    lit: syn::Lit::Str(s),
                    ..
                }) = &nv.value
            {
                return Some(s.value().trim().to_string());
            }
            None
        })
        .collect();
    let doc_comment = docs.join("\n");

    let is_async = func.sig.asyncness.is_some();
    let fn_name = &func.sig.ident;
    let vis = &func.vis;
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

    // Analyze parameters
    struct ParamInfo {
        pat: syn::Pat,
        ty: Type,
        is_state: bool,
        state_inner: Option<Type>,
    }

    let mut params = Vec::new();
    for input in &func.sig.inputs {
        match input {
            syn::FnArg::Receiver(_) => {
                return syn::Error::new_spanned(input, "#[command] functions cannot accept `self`")
                    .to_compile_error()
                    .into();
            }
            syn::FnArg::Typed(pat_type) => {
                let is_state_inner = extract_state_inner(&pat_type.ty);
                let is_state = is_state_inner.is_some();
                params.push(ParamInfo {
                    pat: (*pat_type.pat).clone(),
                    ty: (*pat_type.ty).clone(),
                    is_state,
                    state_inner: is_state_inner,
                });
            }
        }
    }

    let data_params: Vec<&ParamInfo> = params.iter().filter(|p| !p.is_state).collect();
    if data_params.len() > 1 {
        return syn::Error::new_spanned(
            &func.sig.inputs,
            "#[command] supports at most one input data parameter (plus optional State<T> parameters)",
        )
        .to_compile_error()
        .into();
    }

    let input_type = if let Some(data) = data_params.first() {
        let ty = &data.ty;
        quote! { #ty }
    } else {
        quote! { () }
    };

    let inner_fn_name = Ident::new(
        &format!("__rustra_inner_{}", fn_name),
        proc_macro2::Span::call_site(),
    );
    let mut inner_func = func.clone();
    inner_func.sig.ident = inner_fn_name.clone();

    let command_name = attr.name.unwrap_or_else(|| {
        let raw = fn_name.to_string();
        snake_to_lower_camel(raw.trim_end_matches("_command"))
    });
    let meta_ident = Ident::new(
        &format!("__RUstra_meta_{}", fn_name),
        proc_macro2::Span::call_site(),
    );
    let doc_ident = Ident::new(
        &format!("__RUstra_doc_{}", fn_name),
        proc_macro2::Span::call_site(),
    );
    // capability 속성이 있으면 메타 상수에 싣는다. register!/build! 가 이를 읽어
    // require_capability 로 연결한다 — 문자열 이름 재결합(오타 시 런타임 패닉) 대신
    // 매크로 시점에 같은 심벌에서 파생된다.
    let capability_ident = Ident::new(
        &format!("__RUstra_cap_{}", fn_name),
        proc_macro2::Span::call_site(),
    );
    let capability_const: TokenStream2 = if let Some(cap) = &attr.capability {
        quote! {
            #[allow(non_upper_case_globals, dead_code)]
            const #capability_ident: Option<&str> = Some(#cap);
        }
    } else {
        quote! {
            #[allow(non_upper_case_globals, dead_code)]
            const #capability_ident: Option<&str> = None;
        }
    };

    // Prepare state bindings and call args
    let mut state_bindings = Vec::new();
    let mut call_args = Vec::new();

    for param in &params {
        if param.is_state {
            let pat = &param.pat;
            let ty = &param.ty;
            let inner_ty = param.state_inner.as_ref().unwrap();
            state_bindings.push(quote! {
                let #pat: #ty = rustra::get_state::<#inner_ty>()
                    .ok_or_else(|| rustra::RustraError::internal(concat!("State<", stringify!(#inner_ty), "> not managed in package")))?;
            });
            call_args.push(quote! { #pat });
        } else {
            call_args.push(quote! { __rustra_input });
        }
    }

    let outer_input_arg = if data_params.is_empty() {
        quote! { _: () }
    } else {
        quote! { __rustra_input: #input_type }
    };

    let inner_invocation = if is_async {
        quote! {
            rustra::__private::block_on(async move {
                #inner_fn_name(#(#call_args),*).await
            })
        }
    } else {
        quote! {
            #inner_fn_name(#(#call_args),*)
        }
    };

    let expanded = quote! {
        #inner_func

        #vis fn #fn_name(#outer_input_arg) -> rustra::Result<#output_type> {
            #(#state_bindings)*
            #inner_invocation
        }

        #capability_const

        #[allow(non_upper_case_globals, dead_code)]
        const #meta_ident: &str = #command_name;

        #[allow(non_upper_case_globals, dead_code)]
        const #doc_ident: &str = #doc_comment;

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

/// Type이 `State<T>` 형태인지 검사하고 내부 `T`를 반환합니다.
fn extract_state_inner(ty: &Type) -> Option<Type> {
    let Type::Path(type_path) = ty else {
        return None;
    };
    let segment = type_path.path.segments.last()?;
    if segment.ident == "State"
        && let PathArguments::AngleBracketed(args) = &segment.arguments
        && let Some(GenericArgument::Type(inner_ty)) = args.args.first()
    {
        return Some(inner_ty.clone());
    }
    None
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
/// ```rust
/// use rustra::prelude::*;
///
/// #[bridge_type]
/// struct AddInput { a: i64, b: i64 }
/// #[bridge_type]
/// struct AddOutput { sum: i64 }
///
/// #[command]
/// fn add_numbers(input: AddInput) -> Result<AddOutput> {
///     Ok(AddOutput { sum: input.a + input.b })
/// }
///
/// let pkg = rustra::register!(Package::builder("my.pkg"), add_numbers).build();
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
            let cap_ident = Ident::new(
                &format!("__RUstra_cap_{}", fn_name),
                proc_macro2::Span::call_site(),
            );
            // capability 메타가 Some이면 .require_capability 로 이어 붙인다. 상수가
            // Option<&str> 이므로 if let 체인으로 분기 — None이면 .command 만.
            quote! {
                .command(#meta_ident, #fn_name)
                .require_capability_if(#meta_ident, #cap_ident)
            }
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
/// ```rust
/// use rustra::prelude::*;
///
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
/// ```rust
/// use rustra::prelude::*;
///
/// #[bridge_type]
/// struct AddInput { a: i64, b: i64 }
/// #[bridge_type]
/// struct AddOutput { sum: i64 }
///
/// #[command]
/// fn add_numbers(input: AddInput) -> Result<AddOutput> {
///     Ok(AddOutput { sum: input.a + input.b })
/// }
///
/// let pkg = rustra::build!("com.example.my", add_numbers).done();
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
            let cap_ident = Ident::new(
                &format!("__RUstra_cap_{}", fn_name),
                proc_macro2::Span::call_site(),
            );
            quote! {
                .command(#meta_ident, #fn_name)
                .require_capability_if(#meta_ident, #cap_ident)
            }
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

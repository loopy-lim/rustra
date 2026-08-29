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
            let doc_ident = Ident::new(
                &format!("__RUstra_doc_{}", fn_name),
                proc_macro2::Span::call_site(),
            );
            // capability 메타가 Some이면 .require_capability 로 이어 붙인다. 상수가
            // Option<&str> 이므로 if let 체인으로 분기 — None이면 .command 만.
            quote! {
                .command(#meta_ident, #fn_name)
                .command_doc(#meta_ident, #doc_ident)
                .require_capability_if(#meta_ident, #cap_ident)
            }
        })
        .collect();

    let expanded = quote! {
        #builder #chain
    };

    expanded.into()
}

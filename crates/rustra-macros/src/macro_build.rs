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
            let doc_ident = Ident::new(
                &format!("__RUstra_doc_{}", fn_name),
                proc_macro2::Span::call_site(),
            );
            // (감사 #5) `#[command]` 가 생성하는 안전 어댑터(`__rustra_register_*`)를
            // 통해 등록한다 — capability 래퍼는 `unsafe fn` 이므로 원본 이름으로는
            // F: Fn 바운드를 통과하지 못하고(무음 드랍 차단), 어댑터는 I/O 타입
            // 추론이 그대로 성립한다.
            let register_ident = Ident::new(
                &format!("__rustra_register_{}", fn_name),
                proc_macro2::Span::call_site(),
            );
            quote! {
                .command(#meta_ident, #register_ident)
                .command_doc(#meta_ident, #doc_ident)
                .require_capability_if(#meta_ident, #cap_ident)
            }
        })
        .collect();

    let expanded = quote! {
        rustra::Package::builder(#package_name) #chain
    };

    expanded.into()
}

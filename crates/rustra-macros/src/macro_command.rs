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

    let doc_comment = command_doc_comment(&func);

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

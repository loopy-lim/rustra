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
    // (감사 #5 후속) inner 클론은 반드시 비공개 — `#vis` 를 남기면
    // `.command_fn(__rustra_inner_{fn})` 이 안전 `fn` 으로 조용히 통과하는
    // 우회 경로가 된다(C1). 래퍼/어댑터와 같은 모듈에서만 호출되므로 비공개로
    // 충분하다.
    inner_func.vis = syn::Visibility::Inherited;

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
    let capability_const = meta_opt_const(
        &capability_ident,
        quote! { Option<&str> },
        attr.capability.as_ref().map(|cap| quote! { #cap }),
    );

    // 플랫폼 속성 — 지원 플랫폼 cfg 조건과 Platform 상수를 파생한다. 매크로가
    // cfg 게이팅을 소유한다: 사용자 fn 에 #[cfg] 를 직접 붙이면 속성 매크로보다
    // 먼저 strip 돼 이 전개가 일어나지 않는다(platform 절의 문서 참고).
    let platforms_ident = Ident::new(
        &format!("__RUstra_platforms_{}", fn_name),
        proc_macro2::Span::call_site(),
    );
    let platforms_const_ty = quote! { Option<&'static [rustra::platform::Platform]> };
    let (supported_cfg, unsupported_cfg, platform_paths, platforms_const): (
        TokenStream2,
        TokenStream2,
        Vec<TokenStream2>,
        TokenStream2,
    ) = if let Some(platforms) = &attr.platforms {
        let mut os_checks = Vec::new();
        let mut paths = Vec::new();
        for platform in platforms {
            let (os, variant_name) = match platform.as_str() {
                "windows" => ("windows", "Windows"),
                "macos" => ("macos", "Macos"),
                "linux" => ("linux", "Linux"),
                "android" => ("android", "Android"),
                "ios" => ("ios", "Ios"),
                other => {
                    return syn::Error::new_spanned(
                        &func.sig.ident,
                        format!(
                            "unknown platform '{other}'; supported: windows, macos, linux, android, ios"
                        ),
                    )
                    .to_compile_error()
                    .into();
                }
            };
            os_checks.push(quote! { target_os = #os });
            // Platform variant 식별자 — quote 가 String 을 문자열 리터럴로
            // 렌더링하지 않도록 Ident 로 변환한다.
            let variant = Ident::new(variant_name, proc_macro2::Span::call_site());
            paths.push(quote! { rustra::platform::Platform::#variant });
        }
        (
            quote! { any(#(#os_checks),*) },
            quote! { not(any(#(#os_checks),*)) },
            paths.clone(),
            meta_opt_const(
                &platforms_ident,
                platforms_const_ty.clone(),
                Some(quote! { &[#(#paths),*] }),
            ),
        )
    } else {
        (
            quote! {},
            quote! {},
            Vec::new(),
            meta_opt_const(&platforms_ident, platforms_const_ty, None),
        )
    };

    // 에러 속성 — 커맨드별 도메인 에러 코드 선언. const 생성자 체인으로 상수를
    // 구성하고 register!/build! 가 errors_meta_if 로 연결한다(capability/platforms
    // 메타 상수 관례 — None 이면 선언 없는 명령도 체인을 그대로 통과).
    let errors_ident = Ident::new(
        &format!("__RUstra_errors_{}", fn_name),
        proc_macro2::Span::call_site(),
    );
    let errors_const = meta_opt_const(
        &errors_ident,
        quote! { Option<&'static [rustra::CommandErrorVariant]> },
        attr.errors.as_ref().map(|errors| {
            let variants = errors
                .iter()
                .map(|code| quote! { rustra::CommandErrorVariant::new(#code) });
            quote! { &[#(#variants),*] }
        }),
    );

    // 디바이스 역량 속성 — 커맨드가 전제하는 역량 토큰 선언. 카탈로그 검증은
    // 등록 시점(command_devices)에 loud-fail 한다 — 매크로 크레이트는 카탈로그를
    // 모르므로 토큰 목록만 상수로 싣는다(platforms/errors 메타 상수 관례).
    let devices_ident = Ident::new(
        &format!("__RUstra_devices_{}", fn_name),
        proc_macro2::Span::call_site(),
    );
    let devices_const = meta_opt_const(
        &devices_ident,
        quote! { Option<&'static [rustra::device_capabilities::DeviceCapability]> },
        attr.devices.as_ref().map(|devices| {
            let capabilities = devices
                .iter()
                .map(|token| quote! { rustra::device_capabilities::DeviceCapability::new(#token) });
            quote! { &[#(#capabilities),*] }
        }),
    );

    // (감사 #5) capability 무음 드랍 차단: capability 가 있으면 래퍼를 `unsafe fn`
    // 으로 생성한다. `unsafe fn` 아이템 타입은 `Fn` 을 구현하지 않으므로
    // `.command_fn(f)`/`.command(name, f)`/`buffer_command_fn`/`register_fn` 등
    // 일반 등록 경로의 `F: Fn` 바운드에서 **컴파일 에러**가 된다 — 조용한 공개
    // 명령화를 원천 차단. register!/build! 는 명시적 unsafe 클로저로 감싸 등록하며
    // capability 연결(require_capability_if)은 그대로 유지된다.
    let wrapper_unsafety: TokenStream2 = if attr.capability.is_some() {
        quote! { unsafe }
    } else {
        quote! {}
    };
    // register!/build! 가 이름추론 등록에 쓰는 doc(hidden) 안전 어댑터 — fn 아이템이라
    // `Fn(I) -> Result<O>` 바운드에서 I/O 추론이 그대로 성립한다(클로저 추론과 달리).
    // (감사 #5 후속) 비공개로 고정 — `#vis` 를 남기면 크로스 크레이트에서
    // `.command_fn(__rustra_register_{fn})` 우회가 가능해진다(I1). 같은 모듈의
    // register!/build! 호출(`crate::` 경로)은 fn 저자와 같은 신뢰 도메인이라
    // 허용 잔여다.
    let register_ident = Ident::new(
        &format!("__rustra_register_{}", fn_name),
        proc_macro2::Span::call_site(),
    );
    let register_call: TokenStream2 = if attr.capability.is_some() {
        quote! { unsafe { #fn_name(__rustra_input) } }
    } else {
        quote! { #fn_name(__rustra_input) }
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

    // 미지원 플랫폼용 스텁 inner — 같은 시그니처(파라미터는 unused 허용)로
    // platform.unavailable 을 반환한다. cfg 배타성으로 지원 플랫폼의 진짜 inner
    // 와 정확히 하나만 컴파일된다. I/O 타입은 전 플랫폼에 존재해야 한다.
    let mut stub_func = func.clone();
    stub_func.sig.ident = inner_fn_name.clone();
    stub_func.vis = syn::Visibility::Inherited;
    stub_func.block = syn::parse_quote! {
        {
            Err(rustra::RustraError::platform_unavailable(
                #command_name,
                &[#(#platform_paths),*],
            ))
        }
    };

    let (real_inner, stub_inner): (TokenStream2, TokenStream2) = if attr.platforms.is_some() {
        (
            quote! { #[cfg(#supported_cfg)] #inner_func },
            quote! { #[cfg(#unsupported_cfg)] #[allow(unused_variables)] #stub_func },
        )
    } else {
        (quote! { #inner_func }, quote! {})
    };

    let expanded = quote! {
        #real_inner
        #stub_inner

        #vis #wrapper_unsafety fn #fn_name(#outer_input_arg) -> rustra::Result<#output_type> {
            #(#state_bindings)*
            #inner_invocation
        }

        #capability_const

        #platforms_const

        #errors_const

        #devices_const

        #[doc(hidden)]
        fn #register_ident(__rustra_input: #input_type) -> rustra::Result<#output_type> {
            #register_call
        }

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

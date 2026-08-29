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

fn command_doc_comment(func: &ItemFn) -> String {
    func.attrs
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
        .collect::<Vec<_>>()
        .join("\n")
}

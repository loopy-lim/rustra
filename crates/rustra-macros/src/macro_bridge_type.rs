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

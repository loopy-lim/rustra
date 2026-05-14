use proc_macro::TokenStream;
use proc_macro2::TokenStream as TokenStream2;
use quote::quote;
use syn::{
    GenericArgument, Ident, ItemFn, LitStr, PathArguments, ReturnType, Token, Type, parse::Parse,
    parse::ParseStream, parse_macro_input,
};

struct CommandAttr {
    name: Option<String>,
}

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

struct RegisterInput {
    builder: syn::Expr,
    commands: Vec<Ident>,
}

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

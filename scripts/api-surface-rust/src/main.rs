//! Conservative source declaration inventory, not rustc visibility or macro expansion.
use quote::ToTokens;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
use syn::{Attribute, ImplItem, Item, TraitItem, Visibility, visit_mut::VisitMut};

type Surface = BTreeMap<String, Vec<String>>;
struct RemoveDocs;
impl VisitMut for RemoveDocs {
    fn visit_attributes_mut(&mut self, attrs: &mut Vec<Attribute>) {
        attrs.retain(|a| !a.path().is_ident("doc"));
    }
}
fn tokens(value: &impl ToTokens) -> String {
    value.to_token_stream().to_string()
}
fn public(vis: &Visibility) -> bool {
    matches!(vis, Visibility::Public(_))
}
fn attrs(value: &[Attribute]) -> String {
    value
        .iter()
        .filter(|a| !a.path().is_ident("doc"))
        .map(tokens)
        .collect::<Vec<_>>()
        .join(" ")
}
fn test_only(value: &[Attribute]) -> bool {
    value.iter().any(|a| {
        a.path().is_ident("cfg")
            && a.parse_args::<syn::Path>()
                .is_ok_and(|p| p.is_ident("test"))
    })
}
fn add(
    out: &mut Surface,
    scope: &str,
    key: impl std::fmt::Display,
    context: &str,
    value: impl std::fmt::Display,
) {
    out.entry(format!("{scope}::{key}"))
        .or_default()
        .push(format!("{context} {value}").trim().into());
}
struct ModulePaths {
    file: PathBuf,
    module_dir: PathBuf,
    // Explicit #[path] is relative to the file at its root, and to the inline
    // module directory after entering an inline module.
    path_dir: PathBuf,
}

fn source(
    out: &mut Surface,
    file: &Path,
    module_dir: &Path,
    scope: &str,
    context: &str,
    stack: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let canonical =
        fs::canonicalize(file).map_err(|e| format!("Rust source {}: {e}", file.display()))?;
    if stack.contains(&canonical) {
        return Err(format!("Rust module/include cycle: {}", file.display()));
    }
    stack.push(canonical);
    let text = fs::read_to_string(file).map_err(|e| e.to_string())?;
    let mut ast =
        syn::parse_file(&text).map_err(|e| format!("Rust parse {}: {e}", file.display()))?;
    RemoveDocs.visit_file_mut(&mut ast);
    let context = format!("{context} {}", attrs(&ast.attrs));
    let paths = ModulePaths {
        file: file.to_owned(),
        module_dir: module_dir.to_owned(),
        path_dir: file.parent().unwrap().to_owned(),
    };
    items(out, ast.items, &paths, scope, &context, stack)?;
    stack.pop();
    Ok(())
}
fn items(
    out: &mut Surface,
    declarations: Vec<Item>,
    paths: &ModulePaths,
    scope: &str,
    context: &str,
    stack: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let file = &paths.file;
    let module_dir = &paths.module_dir;
    for item in declarations {
        let item_attrs: &[Attribute] = match &item {
            Item::Mod(x) => &x.attrs,
            Item::Fn(x) => &x.attrs,
            Item::Struct(x) => &x.attrs,
            Item::Enum(x) => &x.attrs,
            Item::Union(x) => &x.attrs,
            Item::Trait(x) => &x.attrs,
            Item::Impl(x) => &x.attrs,
            Item::Macro(x) => &x.attrs,
            Item::Use(x) => &x.attrs,
            Item::Type(x) => &x.attrs,
            Item::Const(x) => &x.attrs,
            Item::Static(x) => &x.attrs,
            Item::TraitAlias(x) => &x.attrs,
            Item::ForeignMod(x) => &x.attrs,
            Item::ExternCrate(x) => &x.attrs,
            _ => &[],
        };
        if test_only(item_attrs) {
            continue;
        }
        match item {
            Item::Mod(x) => {
                if x.attrs.iter().any(|a| a.path().is_ident("cfg_attr")) {
                    return Err(format!(
                        "Rust cfg_attr on modules needs explicit collector support: {}",
                        file.display()
                    ));
                }
                let name = x.ident.to_string();
                if public(&x.vis) {
                    add(
                        out,
                        scope,
                        format!("mod:{name}"),
                        context,
                        format!("{} pub mod {name}", attrs(&x.attrs)),
                    );
                }
                let child_scope = format!("{scope}::{name}");
                let child_context = format!("{context} {}", attrs(&x.attrs));
                let explicit = x.attrs.iter().find_map(|a| {
                    if !a.path().is_ident("path") {
                        return None;
                    }
                    if let syn::Meta::NameValue(v) = &a.meta
                        && let syn::Expr::Lit(v) = &v.value
                        && let syn::Lit::Str(s) = &v.lit
                    {
                        return Some(s.value());
                    }
                    None
                });
                if let Some((_, children)) = x.content {
                    let next_dir = explicit
                        .as_ref()
                        .map(|p| paths.path_dir.join(p))
                        .unwrap_or_else(|| module_dir.join(&name));
                    let child_paths = ModulePaths {
                        file: file.clone(),
                        module_dir: next_dir.clone(),
                        path_dir: next_dir,
                    };
                    items(
                        out,
                        children,
                        &child_paths,
                        &child_scope,
                        &child_context,
                        stack,
                    )?;
                } else {
                    let path = if let Some(p) = &explicit {
                        paths.path_dir.join(p)
                    } else {
                        let direct = module_dir.join(format!("{name}.rs"));
                        if direct.exists() {
                            direct
                        } else {
                            module_dir.join(&name).join("mod.rs")
                        }
                    };
                    let next_dir = if explicit.is_some() || path.file_name().unwrap() == "mod.rs" {
                        path.parent().unwrap().to_path_buf()
                    } else {
                        path.with_extension("")
                    };
                    source(out, &path, &next_dir, &child_scope, &child_context, stack)?;
                }
            }
            Item::Use(x) => add(
                out,
                scope,
                format!("use:{}", tokens(&x.tree)),
                context,
                tokens(&x),
            ),
            Item::Fn(x) if public(&x.vis) => add(
                out,
                scope,
                format!("fn:{}", x.sig.ident),
                context,
                format!("{} {} {}", attrs(&x.attrs), tokens(&x.vis), tokens(&x.sig)),
            ),
            Item::Struct(mut x) => {
                let opaque_fields = x.fields.iter().any(|f| !public(&f.vis));
                match &mut x.fields {
                    syn::Fields::Named(f) => {
                        f.named = f
                            .named
                            .clone()
                            .into_iter()
                            .filter(|f| public(&f.vis))
                            .collect()
                    }
                    syn::Fields::Unnamed(f) => {
                        f.unnamed = f
                            .unnamed
                            .clone()
                            .into_iter()
                            .map(|mut f| {
                                if !public(&f.vis) {
                                    f.ty = syn::parse_quote!(_);
                                }
                                f
                            })
                            .collect()
                    }
                    _ => {}
                }
                add(
                    out,
                    scope,
                    format!("struct:{}", x.ident),
                    context,
                    format!("{} opaque_fields={opaque_fields}", tokens(&x)),
                );
            }
            Item::Enum(x) => add(out, scope, format!("enum:{}", x.ident), context, tokens(&x)),
            Item::Union(mut x) => {
                x.fields.named = x
                    .fields
                    .named
                    .into_iter()
                    .filter(|f| public(&f.vis))
                    .collect();
                add(
                    out,
                    scope,
                    format!("union:{}", x.ident),
                    context,
                    tokens(&x),
                );
            }
            Item::Type(x) => add(out, scope, format!("type:{}", x.ident), context, tokens(&x)),
            Item::Const(x) => add(
                out,
                scope,
                format!("const:{}", x.ident),
                context,
                tokens(&x),
            ),
            Item::Static(mut x) if public(&x.vis) => {
                *x.expr = syn::parse_quote!(());
                add(
                    out,
                    scope,
                    format!("static:{}", x.ident),
                    context,
                    tokens(&x),
                );
            }
            Item::Trait(mut x) => {
                for i in &mut x.items {
                    if let TraitItem::Fn(f) = i {
                        f.default = None;
                        f.semi_token = Some(Default::default());
                    }
                }
                add(
                    out,
                    scope,
                    format!("trait:{}", x.ident),
                    context,
                    tokens(&x),
                );
            }
            Item::TraitAlias(x) => add(
                out,
                scope,
                format!("trait_alias:{}", x.ident),
                context,
                tokens(&x),
            ),
            Item::Impl(mut x) => {
                let children = std::mem::take(&mut x.items);
                let header = tokens(&x);
                let impl_scope = format!("{scope}::{}", header);
                // Include trait impl presence even if it has no explicit methods.
                if x.trait_.is_some() {
                    add(out, scope, format!("impl:{header}"), context, &header);
                }
                for i in children {
                    match i {
                        ImplItem::Fn(f) if public(&f.vis) || x.trait_.is_some() => add(
                            out,
                            &impl_scope,
                            format!("fn:{}", f.sig.ident),
                            context,
                            format!("{} {} {}", attrs(&f.attrs), tokens(&f.vis), tokens(&f.sig)),
                        ),
                        ImplItem::Type(t) if public(&t.vis) || x.trait_.is_some() => add(
                            out,
                            &impl_scope,
                            format!("type:{}", t.ident),
                            context,
                            tokens(&t),
                        ),
                        ImplItem::Const(c) if public(&c.vis) || x.trait_.is_some() => add(
                            out,
                            &impl_scope,
                            format!("const:{}", c.ident),
                            context,
                            tokens(&c),
                        ),
                        ImplItem::Macro(m) => add(
                            out,
                            &impl_scope,
                            format!("macro:{}", tokens(&m.mac.path)),
                            context,
                            tokens(&m),
                        ),
                        _ => {}
                    }
                }
            }
            Item::Macro(x) if x.mac.path.is_ident("include") => {
                let path = syn::parse2::<syn::LitStr>(x.mac.tokens).map_err(|e| {
                    format!("Rust include must be a literal in {}: {e}", file.display())
                })?;
                source(
                    out,
                    &file.parent().unwrap().join(path.value()),
                    module_dir,
                    scope,
                    &format!("{context} {}", attrs(&x.attrs)),
                    stack,
                )?;
            }
            // Invocation expansion is opaque, but pin invocations as well as macro exports.
            Item::Macro(x)
                if x.ident.is_none()
                    || x.attrs.iter().any(|a| a.path().is_ident("macro_export")) =>
            {
                add(
                    out,
                    scope,
                    format!(
                        "macro:{}",
                        x.ident
                            .as_ref()
                            .map(ToString::to_string)
                            .unwrap_or_else(|| tokens(&x.mac.path))
                    ),
                    context,
                    tokens(&x),
                );
            }
            Item::ExternCrate(x) if public(&x.vis) => add(
                out,
                scope,
                format!("extern:{}", x.ident),
                context,
                tokens(&x),
            ),
            Item::ForeignMod(x) => add(
                out,
                scope,
                format!("foreign:{}", tokens(&x.abi)),
                context,
                tokens(&x),
            ),
            Item::Verbatim(x) => {
                return Err(format!(
                    "unsupported Rust declaration in {}: {x}",
                    file.display()
                ));
            }
            _ => {}
        }
    }
    Ok(())
}
fn run() -> Result<Surface, String> {
    let root = PathBuf::from(std::env::args().nth(1).ok_or("expected repository root")?);
    let mut out = Surface::new();
    for name in ["rustra", "rustra-macros"] {
        let src = root.join("crates").join(name).join("src");
        source(
            &mut out,
            &src.join("lib.rs"),
            &src,
            name,
            "",
            &mut Vec::new(),
        )?;
    }
    for values in out.values_mut() {
        values.sort();
        values.dedup();
    }
    Ok(out)
}
fn main() {
    match run() {
        Ok(out) => println!("{}", serde_json::to_string(&out).unwrap()),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

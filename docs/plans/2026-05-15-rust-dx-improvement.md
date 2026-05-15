# Rust DX Improvement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current verbose Rust API with a tRPC-style minimal API where users define functions and get automatic Input/Output struct generation, registration, and TypeScript codegen.

**Architecture:** The `#[command]` proc macro detects parameter patterns (scalar vs struct) and generates handler wrappers + metadata constants. A new `build!()` macro uses a naming convention to wire everything together. `#[derive(BridgeType)]` consolidates 4 derives into one.

**Tech Stack:** Rust proc macros (syn, quote), serde, schemars, serde_json

---

### Task 1: Add `#[derive(BridgeType)]` macro

**Files:**
- Modify: `crates/rustra-macros/src/lib.rs`
- Modify: `crates/rustra/src/lib.rs` (prelude, re-export)
- Test: `crates/rustra/tests/public_authoring_api_tests.rs`

**Step 1: Write the failing test**

Add to `crates/rustra/tests/public_authoring_api_tests.rs`:

```rust
#[test]
fn bridge_type_derive_replaces_four_derives() {
    use rustra::BridgeType;

    #[derive(Debug, BridgeType)]
    struct BridgedInput {
        pub name: String,
        pub age: Option<u32>,
    }

    // Verify it serializes with camelCase
    let input = BridgedInput { name: "test".into(), age: Some(25) };
    let json = serde_json::to_value(&input).unwrap();
    assert_eq!(json["name"], "test");
    assert_eq!(json["age"], 25);
    // Verify it has no snake_case keys
    assert!(json.get("age").is_some());

    // Verify round-trip deserialization
    let de: BridgedInput = serde_json::from_value(json).unwrap();
    assert_eq!(de.name, "test");
    assert_eq!(de.age, Some(25));

    // Verify JsonSchema generation works
    let schema = schemars::schema_for!(BridgedInput);
    let schema_json = serde_json::to_value(&schema).unwrap();
    assert!(schema_json["schema"].is_object());
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p rustra bridge_type_derive_replaces_four_derives`
Expected: FAIL — `BridgeType` not found

**Step 3: Implement `BridgeType` derive macro**

Add to `crates/rustra-macros/src/lib.rs`:

```rust
/// Derive macro that combines `Debug + Serialize + Deserialize + JsonSchema`
/// and adds `#[serde(rename_all = "camelCase")]` automatically.
///
/// ```rust,ignore
/// #[derive(BridgeType)]
/// struct MyInput { pub name: String, pub age: Option<u32> }
/// ```
#[proc_macro_derive(BridgeType, attributes(bridge))]
pub fn bridge_type_derive(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as syn::DeriveInput);

    let name = &input.ident;
    let generics = &input.generics;
    let (impl_generics, ty_generics, where_clause) = generics.split_for_impl();

    // Check for #[bridge(rename_all = "...")] override
    let rename_all = input.attrs.iter()
        .find(|attr| attr.path().is_ident("bridge"))
        .and_then(|attr| {
            let mut rename = String::from("camelCase");
            let _ = attr.parse_nested_meta(|meta| {
                if meta.path.is_ident("rename_all") {
                    let value: LitStr = meta.value()?.parse()?;
                    rename = value.value();
                }
                Ok(())
            });
            Some(rename)
        })
        .unwrap_or_else(|| "camelCase".to_string());

    let serde_rename = format!("rename_all = \"{rename_all}\"");

    let expanded = quote! {
        #[derive(Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
        #[serde(#serde_rename)]
        #input

        // Re-export nothing extra — the derives handle everything
    };

    expanded.into()
}
```

Note: The approach above re-emits the struct with additional derives. However, proc-macro derives can't add other derives to the same item. We need a different approach — use a helper attribute macro instead, or emit the struct with the derives inline.

**Revised approach — use an attribute macro:**

Replace the derive with an attribute macro `#[bridge_type]` that wraps the struct:

Actually, let's keep it as a derive but take a different approach. The derive can't add other derives, but we CAN generate a newtype or a wrapper. However, the simplest working approach is:

The `BridgeType` derive emits the Serialize/Deserialize/JsonSchema impl blocks directly via `schemars::JsonSchema` derive helper. But that's complex.

**Simplest working approach:**

Since we can't add derives from within a derive, we'll use the fact that `BridgeType` is a marker derive that triggers a proc-macro to re-emit the struct with the correct derives. But Rust doesn't allow this.

**Actual working approach:**

We'll create `#[bridge_type]` as an **attribute macro** (not a derive). This lets us rewrite the struct with additional derives:

```rust
#[proc_macro_attribute]
pub fn bridge_type(_attr: TokenStream, item: TokenStream) -> TokenStream {
    let mut input = parse_macro_input!(item as syn::DeriveInput);

    // Add derives: Debug, Serialize, Deserialize, JsonSchema
    let additional: Vec<syn::Path> = vec![
        syn::parse_quote!(Debug),
        syn::parse_quote!(serde::Serialize),
        syn::parse_quote!(serde::Deserialize),
        syn::parse_quote!(schemars::JsonSchema),
    ];

    for path in additional {
        input.attrs.push(syn::Attribute {
            pound_token: syn::token::Pound::default(),
            style: syn::AttrStyle::Outer,
            bracket_token: syn::token::Bracket::default(),
            meta: syn::Meta::Path(path),
        });
    }

    // Add #[serde(rename_all = "camelCase")] unless overridden
    let has_rename = input.attrs.iter().any(|attr| {
        attr.path().is_ident("serde") && attr.tokens.to_string().contains("rename_all")
    }) || input.attrs.iter().any(|attr| {
        attr.path().is_ident("bridge") && attr.tokens.to_string().contains("rename_all")
    });

    if !has_rename {
        input.attrs.push(syn::parse_quote!(#[serde(rename_all = "camelCase")]));
    }

    quote! { #input }.into()
}
```

**Update test to use attribute syntax:**

```rust
#[test]
fn bridge_type_replaces_four_derives() {
    #[rustra::bridge_type]
    struct BridgedInput {
        pub name: String,
        pub age: Option<u32>,
    }
    // ... same assertions
}
```

**Step 4: Update re-exports in `crates/rustra/src/lib.rs`**

```rust
pub use rustra_macros::bridge_type;
```

Add to prelude:
```rust
pub use crate::bridge_type;
```

**Step 5: Run test to verify it passes**

Run: `cargo test -p rustra bridge_type_replaces_four_derives`
Expected: PASS

**Step 6: Commit**

```bash
git add crates/rustra-macros/src/lib.rs crates/rustra/src/lib.rs crates/rustra/tests/
git commit -m "feat(macros): add #[bridge_type] attribute macro"
```

---

### Task 2: Enhance `#[command]` macro — scalar params support

**Files:**
- Modify: `crates/rustra-macros/src/lib.rs`

**Step 1: Write the failing test**

Add to `crates/rustra/tests/public_authoring_api_tests.rs`:

```rust
#[test]
fn command_macro_accepts_scalar_params_with_scalar_return() {
    use rustra::prelude::*;

    #[command]
    fn add_numbers(a: i64, b: i64) -> i64 {
        a + b
    }

    // The generated handler should be callable
    let pkg = rustra::build("test.scalar")
        .register(add_numbers)
        .done();

    let result: i64 = pkg.invoke("addNumbers", json!({ "a": 2, "b": 3 })).unwrap();
    assert_eq!(result, 5);
}

#[test]
fn command_macro_accepts_scalar_params_with_result_return() {
    use rustra::prelude::*;

    #[command]
    fn divide(a: i64, b: i64) -> Result<i64> {
        if b == 0 {
            Err(RustraError::invalid_args("division by zero"))
        } else {
            Ok(a / b)
        }
    }

    let pkg = rustra::build("test.scalar")
        .register(divide)
        .done();

    let result: i64 = pkg.invoke("divide", json!({ "a": 10, "b": 2 })).unwrap();
    assert_eq!(result, 5);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p rustra command_macro_accepts_scalar_params`
Expected: FAIL — `#[command]` rejects functions with != 1 params

**Step 3: Rewrite `#[command]` macro**

Replace the `command` proc-macro in `crates/rustra-macros/src/lib.rs`:

```rust
#[proc_macro_attribute]
pub fn command(attr: TokenStream, item: TokenStream) -> TokenStream {
    let attr = parse_macro_input!(attr as CommandAttr);
    let func = parse_macro_input!(item as ItemFn);

    let fn_name = &func.sig.ident;
    let command_name = attr.name.unwrap_or_else(|| {
        let raw = fn_name.to_string();
        snake_to_lower_camel(raw.trim_end_matches("_command"))
    });
    let meta_ident = Ident::new(
        &format!("__RUstra_meta_{}", fn_name),
        proc_macro2::Span::call_site(),
    );

    // Detect param mode
    let inputs: Vec<_> = func.sig.inputs.iter().collect();

    if inputs.is_empty() {
        return syn::Error::new_spanned(
            &func.sig,
            "#[command] function must have at least one input parameter",
        )
        .to_compile_error()
        .into();
    }

    let expanded = if inputs.len() == 1 {
        // Struct param mode — current behavior
        expand_struct_param_command(&func, &command_name, &meta_ident)
    } else {
        // Scalar param mode — generate Input struct + handler
        expand_scalar_param_command(&func, &command_name, &meta_ident)
    };

    expanded.into()
}

fn expand_struct_param_command(
    func: &ItemFn,
    command_name: &str,
    meta_ident: &Ident,
) -> TokenStream2 {
    let fn_name = &func.sig.ident;
    let handler_ident = Ident::new(
        &format!("__rustra_{}_handler", fn_name),
        proc_macro2::Span::call_site(),
    );

    let input_type = match &func.sig.inputs[0] {
        syn::FnArg::Typed(pat_type) => &*pat_type.ty,
        _ => panic!("unreachable"),
    };

    let output_type = match &func.sig.output {
        ReturnType::Type(_, ty) => extract_result_inner(ty)
            .unwrap_or_else(|| quote! { #ty }),
        _ => quote! { () },
    };

    quote! {
        #func

        #[allow(non_upper_case_globals, dead_code)]
        const #meta_ident: &str = #command_name;

        #[allow(dead_code)]
        fn #handler_ident(__input: #input_type) -> rustra::Result<#output_type> {
            #fn_name(__input)
        }

        #[allow(dead_code)]
        const _: () = {
            fn _assert_bounds<
                __I: rustra::__private::CommandInput,
                __O: rustra::__private::CommandOutput,
            >() {}
            fn _check() { _assert_bounds::<#input_type, #output_type>(); }
        };
    }
}

fn expand_scalar_param_command(
    func: &ItemFn,
    command_name: &str,
    meta_ident: &Ident,
) -> TokenStream2 {
    let fn_name = &func.sig.ident;

    // Build Input struct fields from function params
    let mut field_names = Vec::new();
    let mut field_types = Vec::new();
    let mut field_access = Vec::new();

    for (i, arg) in func.sig.inputs.iter().enumerate() {
        match arg {
            syn::FnArg::Typed(pat_type) => {
                let name = match &*pat_type.pat {
                    syn::Pat::Ident(ident) => ident.ident.clone(),
                    _ => Ident::new(&format!("arg{}", i), proc_macro2::Span::call_site()),
                };
                let ty = &*pat_type.ty;
                field_names.push(name.clone());
                field_types.push(quote! { pub #name: #ty });
                field_access.push(name);
            }
            _ => {}
        }
    }

    let pascal_name = snake_to_upper_camel(&fn_name.to_string());
    let input_struct_name = Ident::new(
        &format!("__{}Input", pascal_name),
        proc_macro2::Span::call_site(),
    );
    let handler_ident = Ident::new(
        &format!("__rustra_{}_handler", fn_name),
        proc_macro2::Span::call_site(),
    );

    // Determine output type and wrapping
    let (output_type, handler_body) = match &func.sig.output {
        ReturnType::Type(_, ty) => {
            if let Some(inner) = extract_result_inner(ty) {
                // Returns Result<O> — delegate directly
                (inner.clone(), quote! { #fn_name(#(#field_access),*) })
            } else {
                // Returns bare T — wrap in Ok
                let ty = ty;
                (quote! { #ty }, quote! { Ok(#fn_name(#(#field_access),*)) })
            }
        }
        _ => {
            // Returns nothing
            (quote! { () }, quote! { #fn_name(#(#field_access),*); Ok(()) })
        }
    };

    let access = &field_access;

    quote! {
        #func

        #[allow(non_snake_case, dead_code)]
        #[derive(Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
        #[serde(rename_all = "camelCase")]
        struct #input_struct_name {
            #(#field_types),*
        }

        #[allow(non_upper_case_globals, dead_code)]
        const #meta_ident: &str = #command_name;

        #[allow(dead_code)]
        fn #handler_ident(__input: #input_struct_name) -> rustra::Result<#output_type> {
            let #input_struct_name { #(#access),* } = __input;
            #handler_body
        }

        #[allow(dead_code)]
        const _: () = {
            fn _assert_bounds<
                __I: rustra::__private::CommandInput,
                __O: rustra::__private::CommandOutput,
            >() {}
            fn _check() { _assert_bounds::<#input_struct_name, #output_type>(); }
        };
    }
}
```

Add the `snake_to_upper_camel` helper:

```rust
fn snake_to_upper_camel(name: &str) -> String {
    name.split('_')
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                None => String::new(),
                Some(first) => first.to_ascii_uppercase().to_string() + &chars.as_str().to_ascii_lowercase(),
            }
        })
        .collect()
}
```

**Step 4: Run test to verify it passes**

Run: `cargo test -p rustra command_macro_accepts_scalar_params`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/rustra-macros/src/lib.rs crates/rustra/tests/
git commit -m "feat(macros): support scalar params in #[command] macro"
```

---

### Task 3: Add `rustra::build()` API and `.register()` + `.generate_to()`

**Files:**
- Modify: `crates/rustra/src/lib.rs`

**Step 1: Write the failing test**

```rust
#[test]
fn build_api_registers_and_generates_in_one_chain() {
    #[command]
    fn greet(name: String) -> String {
        format!("Hello, {name}!")
    }

    let dir = tempfile::tempdir().unwrap();
    rustra::build("test.greet")
        .register(greet)
        .generate_to(dir.path())
        .unwrap();

    assert!(dir.path().join("types.ts").exists());
    assert!(dir.path().join("commands.ts").exists());
    assert!(dir.path().join("schema.json").exists());
    assert!(dir.path().join("contract.ts").exists());

    let types_ts = fs::read_to_string(dir.path().join("types.ts")).unwrap();
    assert!(types_ts.contains("GreetInput"));
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p rustra build_api_registers_and_generates`
Expected: FAIL — `rustra::build` not found

**Step 3: Implement `build()`, `.register()`, `.generate_to()`, `.done()`**

Add to `crates/rustra/src/lib.rs`:

```rust
/// Creates a new [`PackageBuilder`] with the given package ID.
///
/// Shorthand for `Package::builder(id)`.
pub fn build(id: impl Into<String>) -> PackageBuilder {
    Package::builder(id)
}
```

Add to `impl PackageBuilder`:

```rust
/// Registers a `#[command]` function by auto-inferring its command name.
///
/// Works with both scalar-param and struct-param command functions.
pub fn register<I, O, F>(self, handler: F) -> Self
where
    I: DeserializeOwned + JsonSchema + 'static,
    O: Serialize + JsonSchema + 'static,
    F: Fn(I) -> crate::Result<O> + Send + Sync + 'static,
{
    let name = command_name_from_handler::<F>();
    self.command(name, handler)
}

/// Builds the package and generates TypeScript, writing all files to the given directory.
pub fn generate_to(self, output_dir: impl AsRef<Path>) -> crate::Result<()> {
    let package = self.build();
    let generated = package.generate_typescript()?;
    generated.write_to_dir(output_dir)
}

/// Builds the package without generating TypeScript.
pub fn done(self) -> Package {
    self.build()
}
```

Update prelude to include `build`:

```rust
pub mod prelude {
    pub use crate::{build, GeneratedPackage, Package, PackageBuilder, Result, RustraError, command, register};
    pub use schemars::JsonSchema;
    pub use serde::{Deserialize, Serialize};
}
```

**Step 4: Run test to verify it passes**

Run: `cargo test -p rustra build_api_registers_and_generates`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/rustra/src/lib.rs crates/rustra/tests/
git commit -m "feat(api): add build().register().generate_to() chain"
```

---

### Task 4: Improve error messages with `#[diagnostic::on_unimplemented]`

**Files:**
- Modify: `crates/rustra/src/lib.rs` (`__private` module)

**Step 1: Update `__private` module**

```rust
pub mod __private {
    use schemars::JsonSchema;
    use serde::{Serialize, de::DeserializeOwned};

    #[diagnostic::on_unimplemented(
        message = "`{Self}` cannot be used as a command parameter",
        label = "command parameters require Serialize + Deserialize + JsonSchema",
        note = "add `#[rustra::bridge_type]` to `{Self}`"
    )]
    pub trait CommandInput: DeserializeOwned + JsonSchema + 'static {}
    impl<T: DeserializeOwned + JsonSchema + 'static> CommandInput for T {}

    #[diagnostic::on_unimplemented(
        message = "`{Self}` cannot be used as a command return type",
        label = "command return types require Serialize + JsonSchema",
        note = "add `#[rustra::bridge_type]` to `{Self}`"
    )]
    pub trait CommandOutput: Serialize + JsonSchema + 'static {}
    impl<T: Serialize + JsonSchema + 'static> CommandOutput for T {}
}
```

**Step 2: Verify it compiles**

Run: `cargo build -p rustra`
Expected: PASS (no runtime test — this is a compile-time diagnostic improvement)

**Step 3: Commit**

```bash
git add crates/rustra/src/lib.rs
git commit -m "feat(api): add descriptive error messages for trait bounds"
```

---

### Task 5: Update existing tests to new API

**Files:**
- Modify: `crates/rustra/tests/public_authoring_api_tests.rs`

**Step 1: Update test file**

Replace all test functions that use the old API (`Package::builder()`, `register!()`) with the new API (`rustra::build()`, `.register()`). Key changes:

- `Package::builder("...")` → `rustra::build("...")`
- `.command_fn(fn)` / `.command("name", fn)` → `.register(fn)`
- `register!(Package::builder("..."), fn1, fn2).build()` → `rustra::build("...").register(fn1).register(fn2).done()`
- `pkg.generate_typescript()?.write_to_dir(dir)` → replace with `rustra::build("...").register(fn).generate_to(dir)`

Where tests need just the Package for invocation, use `.done()` instead of `.build()`.

Keep struct definitions using `#[derive(Debug, Serialize, Deserialize, JsonSchema)]` in tests that specifically test backward compatibility or internal schema behavior, but update the registration patterns.

**Step 2: Run all tests**

Run: `cargo test -p rustra`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add crates/rustra/tests/
git commit -m "test: update tests to new build().register() API"
```

---

### Task 6: Update examples to new API

**Files:**
- Modify: `examples/calculator/src/lib.rs` (or equivalent)
- Modify: `examples/basic.rs` (if exists)
- Modify: any other example Rust files

**Step 1: Update calculator example**

Replace:
```rust
// Old
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct AddNumbersInput { pub a: i64, pub b: i64 }
// ... etc

fn main() -> Result<()> {
    let pkg = register!(Package::builder("examples.calculator"), add_numbers).build();
    let generated = pkg.generate_typescript()?;
    generated.write_to_dir("generated")?;
    Ok(())
}
```

With:
```rust
// New
#[command]
fn add_numbers(a: i64, b: i64) -> i64 { a + b }

#[command]
fn multiply(a: i64, b: i64) -> i64 { a * b }

fn main() -> Result<()> {
    rustra::build("examples.calculator")
        .register(add_numbers)
        .register(multiply)
        .generate_to("generated")?
}
```

**Step 2: Build and test the example**

Run: `cargo build -p calculator && cargo test -p calculator`
Expected: PASS

**Step 3: Commit**

```bash
git add examples/
git commit -m "feat(examples): migrate calculator to new API"
```

---

### Task 7: Remove deprecated `register!` macro

**Files:**
- Modify: `crates/rustra-macros/src/lib.rs`
- Modify: `crates/rustra/src/lib.rs` (remove `register` re-export)

**Step 1: Remove `register!` proc macro**

Delete the `register` function and `RegisterInput` struct from `crates/rustra-macros/src/lib.rs`.

Remove from `crates/rustra/src/lib.rs`:
```rust
pub use rustra_macros::register;
```

Remove from prelude:
```rust
// Remove `register` from the prelude pub use line
```

**Step 2: Verify no remaining references**

Run: `grep -r "register!" crates/ examples/ --include="*.rs"`
Expected: No results (except maybe comments)

**Step 3: Run all tests**

Run: `cargo test --workspace`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add crates/ examples/
git commit -m "chore: remove deprecated register! macro"
```

---

### Task 8: Update docs and doc comments

**Files:**
- Modify: `crates/rustra/src/lib.rs` (module-level doc)
- Modify: `crates/rustra-macros/src/lib.rs` (macro doc comments)

**Step 1: Update module-level doc example**

Replace the old example in `crates/rustra/src/lib.rs` with:

```rust
//! ## 빠른 예제
//!
//! ```rust
//! use rustra::prelude::*;
//!
//! #[command]
//! fn add_numbers(a: i64, b: i64) -> i64 {
//!     a + b
//! }
//!
//! fn main() -> Result<()> {
//!     rustra::build("example.calculator")
//!         .register(add_numbers)
//!         .generate_to("../generated")?
//! }
//! ```
```

**Step 2: Run doc tests**

Run: `cargo test --doc -p rustra`
Expected: PASS

**Step 3: Commit**

```bash
git add crates/
git commit -m "docs: update examples to new API in doc comments"
```

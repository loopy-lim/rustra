# Runtime Command Registry Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `Package` mutably add/remove/replace commands at runtime (debug builds), while staying frozen-by-default in release builds.

**Architecture:** Single `Package` type retained. Internals move from `Arc<BTreeMap>` to `Arc<RwLock<RegistryState>>` + `Arc<AtomicBool> frozen`. New public mutation API (`register`/`register_fn`/`replace`/`unregister`/`freeze`/`is_frozen`). `command_id` is monotonic and retired-on-remove (never reused). Mode split via `cfg!(debug_assertions)`: debug → mutable, release → frozen. Mutation methods always compile; they return `Err("registry.frozen")` when frozen.

**Tech Stack:** Rust 2024, `std::sync::{Arc, RwLock, atomic::AtomicBool}`, existing `schemars`/`serde_json`/`rkyv`/`postcard` machinery. Tests: integration tests in `crates/rustra/tests/`, white-box `#[cfg(test)]` mod in `lib.rs`.

**Design doc:** `docs/plans/2026-07-04-runtime-command-registry-design.md`

---

## Reference: exact locations in `crates/rustra/src/lib.rs`

| Item | Lines | Change |
|------|-------|--------|
| `Package` struct | 167-172 | restructure fields |
| `PackageBuilder` struct | 174-178 | unchanged |
| `Command` struct | 228-243 | unchanged |
| `invoke` | 269-277 | delegate (minor) |
| `invoke_json` | 282-288 | read-lock + clone-out |
| `resolve_command_id` | 291-293 | return `Option<String>` |
| `invoke_rkyv_v2` | 303-330 | read-lock + clone-out |
| `generate_typescript` | 333-346 | hold one read lock |
| `schema` / `generate_types_ts` / `generate_commands_ts` | 348-452 | take `&RegistryState` |
| `command` | 475-546 | extract body → `build_command` |
| `build` | 549-560 | construct `RegistryState` + frozen |

---

## Task 1: Extract `build_command` helper (pure refactor)

**Files:**
- Modify: `crates/rustra/src/lib.rs` (inside `impl PackageBuilder`, around line 475-546)

**Step 1: Add a free function `build_command`** above `impl PackageBuilder` (after the `Command` Debug impl, ~line 254). Move the Command-construction body (currently lib.rs:481-538) into it:

```rust
/// Build a `Command` from a typed handler. Shared by builder-time and runtime registration.
fn build_command<I, O, F>(command_id: u16, handler: F) -> Command
where
    I: DeserializeOwned + JsonSchema + 'static,
    O: Serialize + JsonSchema + 'static,
    F: Fn(I) -> crate::Result<O> + Send + Sync + 'static,
{
    let (input_schema, input_defs) = schema_value::<I>();
    let (output_schema, output_defs) = schema_value::<O>();
    let mut definitions = input_defs;
    if let (Value::Object(obj), Value::Object(other)) = (&mut definitions, output_defs) {
        for (key, value) in other {
            obj.insert(key, value);
        }
    }
    let (rkyv_v2_decoder, input_tier) = build_rkyv_v2_decoder(&input_schema);
    let output_tier3 = is_output_tier3(&output_schema);
    let is_tier3 = input_tier == Tier::Tier3 || output_tier3;
    let rkyv_v2_decoder = if is_tier3 && input_tier != Tier::Tier3 {
        build_tier3_json_decoder()
    } else {
        rkyv_v2_decoder
    };
    let rkyv_v2_response_encoder = build_rkyv_v2_response_encoder(&output_schema, is_tier3);

    let handler = Arc::new(handler);
    let handler_bin = handler.clone();
    let rkyv_v2_handler: Option<BinHandler> = Some(Arc::new(move |payload: &[u8]| {
        if payload.len() < 2 {
            return Err(RustraError::invalid_args("rkyv v2: payload too short"));
        }
        let input: I = postcard::from_bytes(&payload[2..])
            .map_err(|e| RustraError::invalid_args(format!("postcard decode: {e}")))?;
        let output = handler_bin(input)?;
        let out_bytes = postcard::to_allocvec(&output)
            .map_err(|e| RustraError::internal(format!("postcard encode: {e}")))?;
        let mut buf = vec![0u8; 8 + out_bytes.len()];
        buf[0] = 1; // ok = true
        buf[8..8 + out_bytes.len()].copy_from_slice(&out_bytes);
        Ok(buf)
    }));

    Command {
        command_id,
        input_type: short_type_name::<I>(),
        output_type: short_type_name::<O>(),
        input_schema,
        output_schema,
        definitions,
        invoke: Arc::new(move |params| {
            let input = serde_json::from_value::<I>(params).map_err(RustraError::invalid_args)?;
            let output = handler(input)?;
            serde_json::to_value(output).map_err(RustraError::internal)
        }),
        rkyv_v2_handler,
        rkyv_v2_decode: rkyv_v2_decoder,
        rkyv_v2_encode_response: rkyv_v2_response_encoder,
        rkyv_v2_tier3: is_tier3,
    }
}
```

**Step 2: Slim `PackageBuilder::command`** (lib.rs:475-546) to:

```rust
pub fn command<I, O, F>(mut self, name: impl Into<String>, handler: F) -> Self
where
    I: DeserializeOwned + JsonSchema + 'static,
    O: Serialize + JsonSchema + 'static,
    F: Fn(I) -> crate::Result<O> + Send + Sync + 'static,
{
    let name = name.into();
    if self.commands.contains_key(&name) {
        panic!("duplicate command registration: '{name}'");
    }
    let command = build_command::<I, O, F>(self.next_command_id, handler);
    self.commands.insert(name, command);
    self.next_command_id += 1;
    self
}
```

**Step 3: Verify refactor (no behavior change)**

Run: `cargo test -p rustra --test public_authoring_api_tests`
Expected: PASS (all existing tests green).

**Step 4: Commit**

```bash
git add crates/rustra/src/lib.rs
git commit -m "refactor(rustra): extract build_command helper from PackageBuilder::command"
```

---

## Task 2: Introduce `RegistryState` + `RwLock` internals (pure refactor)

**Files:**
- Modify: `crates/rustra/src/lib.rs` (struct defs, `build`, all read methods, codegen methods)

**Step 1: Change imports** at top of lib.rs — add:

```rust
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;
```

**Step 2: Replace `Package` struct** (lib.rs:167-172) with:

```rust
#[derive(Clone)]
pub struct Package {
    id: String,
    state: Arc<RwLock<RegistryState>>,
    frozen: Arc<AtomicBool>,
}

struct RegistryState {
    commands: BTreeMap<String, Command>,
    id_to_name: BTreeMap<u16, String>,
    next_command_id: u16,
}
```

Remove the old `#[derive(Clone, Debug)]` on Package; add a manual `Debug` impl (Step 5).

**Step 3: Update `build`** (lib.rs:549-560):

```rust
pub fn build(self) -> Package {
    let id_to_name: BTreeMap<u16, String> = self
        .commands
        .iter()
        .map(|(name, cmd)| (cmd.command_id, name.clone()))
        .collect();
    Package {
        id: self.id,
        state: Arc::new(RwLock::new(RegistryState {
            commands: self.commands,
            id_to_name,
            next_command_id: self.next_command_id,
        })),
        frozen: Arc::new(AtomicBool::new(!cfg!(debug_assertions))),
    }
}
```

**Step 4: Rewrite read methods** to lock + clone-out the `Command` (avoids holding the lock during handler execution → prevents reentrancy deadlock):

```rust
pub fn invoke_json(&self, name: &str, params: Value) -> crate::Result<Value> {
    let command = {
        let state = self.state.read().unwrap();
        state
            .commands
            .get(name)
            .ok_or_else(|| RustraError::command_not_found(name))?
            .clone()
    };
    (command.invoke)(params)
}

pub fn resolve_command_id(&self, id: u16) -> Option<String> {
    self.state
        .read()
        .unwrap()
        .id_to_name
        .get(&id)
        .cloned()
}

pub fn invoke_rkyv_v2(&self, payload: &[u8]) -> crate::Result<Vec<u8>> {
    if payload.len() < 2 {
        return Err(RustraError::invalid_args("rkyv v2: payload too short"));
    }
    let command_id = u16::from_le_bytes([payload[0], payload[1]]);
    let command = {
        let state = self.state.read().unwrap();
        let name = state
            .id_to_name
            .get(&command_id)
            .ok_or_else(|| RustraError::command_not_found(format!("id:{command_id}")))?;
        state
            .commands
            .get(name)
            .ok_or_else(|| RustraError::command_not_found(name))?
            .clone()
    };

    if let Some(ref handler) = command.rkyv_v2_handler {
        return handler(payload);
    }
    if !command.rkyv_v2_tier3 && payload.len() < 8 {
        return Err(RustraError::invalid_args("rkyv v2: payload too short"));
    }
    let params = (command.rkyv_v2_decode)(payload)?;
    let result = (command.invoke)(params)?;
    Ok((command.rkyv_v2_encode_response)(&result))
}
```

`invoke` (typed, lib.rs:269-277) is unchanged — it delegates to `invoke_json`.

**Step 5: Convert codegen methods** (`schema`, `generate_types_ts`, `generate_commands_ts`) to take `&RegistryState`, and lock once in `generate_typescript`:

```rust
pub fn generate_typescript(&self) -> crate::Result<GeneratedPackage> {
    let state = self.state.read().unwrap();
    let schema_value = Self::schema(&state);
    let schema_json = serde_json::to_string_pretty(&schema_value).map_err(RustraError::internal)?;
    let contract_hash = contract_hash(&schema_json);
    let types_ts = Self::generate_types_ts(&state);
    let commands_ts = Self::generate_commands_ts(&state);
    Ok(GeneratedPackage { schema_json, types_ts, commands_ts, contract_hash })
}

fn schema(state: &RegistryState) -> Value { /* iterate state.commands instead of self.commands */ }
fn generate_types_ts(state: &RegistryState) -> String { /* same */ }
fn generate_commands_ts(state: &RegistryState) -> String { /* same */ }
```

(Mechanical: replace every `self.commands` → `state.commands` inside those three fns, and change their signatures from `&self` to `state: &RegistryState`.)

**Step 6: Add manual `Debug` for `Package`** (replace the derived one):

```rust
impl std::fmt::Debug for Package {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let state = self.state.read().unwrap();
        f.debug_struct("Package")
            .field("id", &self.id)
            .field("frozen", &self.frozen.load(Ordering::Relaxed))
            .field("command_count", &state.commands.len())
            .finish()
    }
}
```

**Step 7: Update any caller of `resolve_command_id`** (it now returns `Option<String>` not `Option<&str>`). Grep:

```bash
grep -rn "resolve_command_id" crates/ examples/
```
Expected: only `invoke_rkyv_v2` (internal, already rewritten) and possibly `crates/rustra/src/ffi.rs`. If ffi.rs uses it, `.as_deref()` or adjust to owned.

**Step 8: Verify refactor**

Run: `cargo build -p rustra && cargo test --workspace`
Expected: PASS (all existing tests + examples' tests green; behavior unchanged).

**Step 9: Commit**

```bash
git add crates/rustra/src/lib.rs crates/rustra/src/ffi.rs
git commit -m "refactor(rustra): back Package with RwLock<RegistryState> (no behavior change)"
```

---

## Task 3 (TDD): `freeze()` / `is_frozen()` + debug-default mutable

**Files:**
- Modify: `crates/rustra/src/lib.rs` (add methods on `impl Package`)
- Test: `crates/rustra/tests/public_authoring_api_tests.rs`

**Step 1: Write failing tests** (append to integration test file):

```rust
#[test]
#[cfg(debug_assertions)]
fn debug_build_is_mutable_by_default() {
    let pkg = Package::builder("test.freeze").build();
    assert!(!pkg.is_frozen(), "debug build should be mutable by default");
    pkg.freeze();
    assert!(pkg.is_frozen());
}

#[test]
#[cfg(not(debug_assertions))]
fn release_build_is_frozen_by_default() {
    let pkg = Package::builder("test.freeze").build();
    assert!(pkg.is_frozen(), "release build should be frozen by default");
}
```

**Step 2: Run → verify failure**

Run: `cargo test -p rustra --test public_authoring_api_tests freeze`
Expected: FAIL — `no method named is_frozen/freeze found`.

**Step 3: Implement** on `impl Package`:

```rust
/// 런타임 mutation을 영구적으로 비활성화한다. (debug에서 prod 동작 시뮬레이션용)
/// release 빌드에서는 build() 시점에 이미 동결되어 있다.
pub fn freeze(&self) {
    self.frozen.store(true, Ordering::Release);
}

/// 패키지가 동결되어 런타임 mutation이 불가능한지 여부.
pub fn is_frozen(&self) -> bool {
    self.frozen.load(Ordering::Acquire)
}

fn ensure_mutable(&self) -> crate::Result<()> {
    if self.is_frozen() {
        Err(RustraError::custom(
            "registry.frozen",
            "package is frozen; runtime mutation disabled",
        ))
    } else {
        Ok(())
    }
}
```

**Step 4: Run → verify pass (debug)**

Run: `cargo test -p rustra --test public_authoring_api_tests freeze`
Expected: `debug_build_is_mutable_by_default` PASS; release test skipped.

**Step 5: Run release variant**

Run: `cargo test --release -p rustra --test public_authoring_api_tests freeze`
Expected: `release_build_is_frozen_by_default` PASS.

**Step 6: Commit**

```bash
git add crates/rustra/src/lib.rs crates/rustra/tests/public_authoring_api_tests.rs
git commit -m "feat(rustra): add freeze()/is_frozen() (debug mutable, release frozen)"
```

---

## Task 4 (TDD): `register()` adds a command at runtime

**Files:**
- Modify: `crates/rustra/src/lib.rs`
- Test: `crates/rustra/tests/public_authoring_api_tests.rs`

**Step 1: Write failing test** (append):

```rust
#[test]
fn runtime_register_adds_command() {
    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct EchoInput { msg: String }
    #[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct EchoOutput { echoed: String }

    #[command]
    fn echo(input: EchoInput) -> Result<EchoOutput> {
        Ok(EchoOutput { echoed: input.msg })
    }

    let pkg = Package::builder("test.runtime").build(); // empty
    pkg.register("echo", echo).unwrap();

    let out: EchoOutput = pkg.invoke("echo", EchoInput { msg: "hi".into() }).unwrap();
    assert_eq!(out, EchoOutput { echoed: "hi".into() });

    let generated = pkg.generate_typescript().unwrap();
    assert!(generated.commands_ts.contains("export function echo"));
}
```

**Step 2: Run → verify failure**

Run: `cargo test -p rustra --test public_authoring_api_tests runtime_register`
Expected: FAIL — `no method named register`.

**Step 3: Implement** on `impl Package`:

```rust
/// 런타임에 명령을 등록한다. 같은 이름이면 핸들러를 덮어쓴다(stable command_id 유지).
/// 동결 상태면 `registry.frozen` 에러.
pub fn register<I, O, F>(&self, name: &str, handler: F) -> crate::Result<()>
where
    I: DeserializeOwned + JsonSchema + 'static,
    O: Serialize + JsonSchema + 'static,
    F: Fn(I) -> crate::Result<O> + Send + Sync + 'static,
{
    self.ensure_mutable()?;
    let name = name.to_string();
    let mut state = self.state.write().unwrap();
    let command_id = match state.commands.get(&name).map(|c| c.command_id) {
        Some(existing) => existing, // replace: keep stable id
        None => {
            let id = state.next_command_id;
            state.next_command_id = state
                .next_command_id
                .checked_add(1)
                .ok_or_else(|| RustraError::custom(
                    "registry.id_exhausted",
                    "command_id u16 space exhausted (65535 commands)",
                ))?;
            id
        }
    };
    let command = build_command::<I, O, F>(command_id, handler);
    state.commands.insert(name.clone(), command);
    state.id_to_name.insert(command_id, name);
    Ok(())
}
```

**Step 4: Run → verify pass**

Run: `cargo test -p rustra --test public_authoring_api_tests runtime_register`
Expected: PASS.

**Step 5: Commit**

```bash
git add crates/rustra/src/lib.rs crates/rustra/tests/public_authoring_api_tests.rs
git commit -m "feat(rustra): runtime register() with stable command_id"
```

---

## Task 5 (TDD): `register()` replaces existing name (idempotent, stable id)

**Files:**
- Modify: `crates/rustra/tests/public_authoring_api_tests.rs` (test only — `register` already handles this)

**Step 1: Write failing test** (append):

```rust
#[test]
fn register_replaces_existing_with_stable_id() {
    #[command] fn v1(_i: AddNumbersInput) -> Result<AddNumbersOutput> {
        Ok(AddNumbersOutput { value: 1 })
    }
    #[command] fn v2(_i: AddNumbersInput) -> Result<AddNumbersOutput> {
        Ok(AddNumbersOutput { value: 2 })
    }

    let pkg = Package::builder("test.replace").build();
    pkg.register("cmd", v1).unwrap();
    let id_before = pkg.state_id_for_test("cmd"); // see Task 5 note below
    // second register with same name → replaces handler, keeps id
    pkg.register("cmd", v2).unwrap();
    let id_after = pkg.state_id_for_test("cmd");
    assert_eq!(id_before, id_after, "command_id must stay stable on replace");

    let out: AddNumbersOutput = pkg.invoke("cmd", AddNumbersInput { a: 0, b: 0 }).unwrap();
    assert_eq!(out.value, 2, "replaced handler should be in effect");
}
```

> **Note on `state_id_for_test`:** the integration test cannot read private `command_id`. Replace the id-stability assertion with a behavioral proxy OR add a `#[cfg(test)]` white-box test inside `lib.rs` (see Task 8 pattern). For the integration test, drop the id assertion and keep only the behavioral replacement check. Keep the id-stability check as a white-box test in Task 8.

**Step 2: Simplify integration test** to behavioral-only (remove the two `state_id_for_test` lines):

```rust
#[test]
fn register_replaces_existing_handler() {
    #[command] fn v1(_i: AddNumbersInput) -> Result<AddNumbersOutput> {
        Ok(AddNumbersOutput { value: 1 })
    }
    #[command] fn v2(_i: AddNumbersInput) -> Result<AddNumbersOutput> {
        Ok(AddNumbersOutput { value: 2 })
    }
    let pkg = Package::builder("test.replace").build();
    pkg.register("cmd", v1).unwrap();
    pkg.register("cmd", v2).unwrap();
    let out: AddNumbersOutput = pkg.invoke("cmd", AddNumbersInput { a: 0, b: 0 }).unwrap();
    assert_eq!(out.value, 2);
}
```

**Step 3: Run → verify pass** (register already implements replace)

Run: `cargo test -p rustra --test public_authoring_api_tests register_replaces`
Expected: PASS.

**Step 4: Commit**

```bash
git add crates/rustra/tests/public_authoring_api_tests.rs
git commit -m "test(rustra): register() replaces existing handler"
```

---

## Task 6 (TDD): `register_fn()` derives name from handler

**Files:**
- Modify: `crates/rustra/src/lib.rs`
- Test: `crates/rustra/tests/public_authoring_api_tests.rs`

**Step 1: Write failing test** (append):

```rust
#[test]
fn runtime_register_fn_derives_name() {
    let pkg = Package::builder("test.register_fn").build();
    pkg.register_fn(add_numbers).unwrap();
    let out: AddNumbersOutput = pkg.invoke("addNumbers", AddNumbersInput { a: 5, b: 7 }).unwrap();
    assert_eq!(out.value, 12);
}
```

**Step 2: Run → verify failure**

Run: `cargo test -p rustra --test public_authoring_api_tests runtime_register_fn`
Expected: FAIL — `no method named register_fn`.

**Step 3: Implement** on `impl Package`:

```rust
/// `#[command]` 함수를 이름 자동 추론으로 런타임 등록한다.
pub fn register_fn<I, O, F>(&self, handler: F) -> crate::Result<()>
where
    I: DeserializeOwned + JsonSchema + 'static,
    O: Serialize + JsonSchema + 'static,
    F: Fn(I) -> crate::Result<O> + Send + Sync + 'static,
{
    let name = command_name_from_handler::<F>();
    self.register::<I, O, F>(&name, handler)
}
```

**Step 4: Run → verify pass**

Run: `cargo test -p rustra --test public_authoring_api_tests runtime_register_fn`
Expected: PASS.

**Step 5: Commit**

```bash
git add crates/rustra/src/lib.rs crates/rustra/tests/public_authoring_api_tests.rs
git commit -m "feat(rustra): runtime register_fn() with name inference"
```

---

## Task 7 (TDD): `replace()` errors when name is missing

**Files:**
- Modify: `crates/rustra/src/lib.rs`
- Test: `crates/rustra/tests/public_authoring_api_tests.rs`

**Step 1: Write failing test** (append):

```rust
#[test]
fn replace_missing_command_errors() {
    let pkg = Package::builder("test.replace_missing").build();
    let err = pkg.replace("nope", add_numbers).unwrap_err();
    assert_eq!(err.code(), "command.not_found");
}
```

**Step 2: Run → verify failure**

Run: `cargo test -p rustra --test public_authoring_api_tests replace_missing`
Expected: FAIL — `no method named replace`.

**Step 3: Implement** on `impl Package`:

```rust
/// 기존 명령의 핸들러를 교체한다. 이름이 없으면 `command.not_found`.
pub fn replace<I, O, F>(&self, name: &str, handler: F) -> crate::Result<()>
where
    I: DeserializeOwned + JsonSchema + 'static,
    O: Serialize + JsonSchema + 'static,
    F: Fn(I) -> crate::Result<O> + Send + Sync + 'static,
{
    self.ensure_mutable()?;
    let mut state = self.state.write().unwrap();
    let command_id = state
        .commands
        .get(name)
        .map(|c| c.command_id)
        .ok_or_else(|| RustraError::command_not_found(name))?;
    let command = build_command::<I, O, F>(command_id, handler);
    state.commands.insert(name.to_string(), command);
    Ok(())
}
```

**Step 4: Run → verify pass**

Run: `cargo test -p rustra --test public_authoring_api_tests replace_missing`
Expected: PASS.

**Step 5: Commit**

```bash
git add crates/rustra/src/lib.rs crates/rustra/tests/public_authoring_api_tests.rs
git commit -m "feat(rustra): runtime replace() (errors if missing)"
```

---

## Task 8 (TDD): `unregister()` + retired-id-never-reused (white-box)

**Files:**
- Modify: `crates/rustra/src/lib.rs` (add `unregister` + inline `#[cfg(test)]` white-box mod)
- Test: `crates/rustra/tests/public_authoring_api_tests.rs` (public behavior)

**Step 1: Write failing public test** (append):

```rust
#[test]
fn unregister_removes_command() {
    let pkg = Package::builder("test.unregister").build();
    pkg.register("cmd", add_numbers).unwrap();
    let _: AddNumbersOutput = pkg.invoke("cmd", AddNumbersInput { a: 1, b: 1 }).unwrap();
    pkg.unregister("cmd").unwrap();
    let err = pkg.invoke::<_, AddNumbersOutput>("cmd", AddNumbersInput { a: 1, b: 1 }).unwrap_err();
    assert_eq!(err.code(), "command.not_found");
    // unregistering again → not_found
    let err2 = pkg.unregister("cmd").unwrap_err();
    assert_eq!(err2.code(), "command.not_found");
}
```

**Step 2: Run → verify failure**

Run: `cargo test -p rustra --test public_authoring_api_tests unregister_removes`
Expected: FAIL — `no method named unregister`.

**Step 3: Implement** on `impl Package`:

```rust
/// 명령을 제거한다. command_id는 retired(재사용 금지).
pub fn unregister(&self, name: &str) -> crate::Result<()> {
    self.ensure_mutable()?;
    let mut state = self.state.write().unwrap();
    let removed = state
        .commands
        .remove(name)
        .ok_or_else(|| RustraError::command_not_found(name))?;
    state.id_to_name.remove(&removed.command_id);
    // NOTE: next_command_id is NOT decremented — retired ids are never reused.
    Ok(())
}
```

**Step 4: Add white-box tests for id retirement + exhaustion** in an inline module at the bottom of `lib.rs` (these can access private `RegistryState`):

```rust
#[cfg(test)]
mod runtime_registry_tests {
    use super::*;

    fn empty_pkg() -> Package {
        Package::builder("test.wb").build()
    }

    #[test]
    fn unregistered_id_is_never_reused() {
        let pkg = empty_pkg();
        #[command] fn c1(_: TestIn) -> Result<TestOut> { Ok(TestOut { v: 0 }) }
        #[command] fn c2(_: TestIn) -> Result<TestOut> { Ok(TestOut { v: 0 }) }
        #[command] fn c3(_: TestIn) -> Result<TestOut> { Ok(TestOut { v: 0 }) }

        pkg.register("c1", c1).unwrap();
        pkg.register("c2", c2).unwrap();
        let id_c2 = pkg.state.read().unwrap().commands.get("c2").unwrap().command_id;
        pkg.unregister("c2").unwrap();
        pkg.register("c3", c3).unwrap();
        let id_c3 = pkg.state.read().unwrap().commands.get("c3").unwrap().command_id;
        assert_ne!(id_c2, id_c3, "retired id must not be reused");
        assert_eq!(id_c2, 2);
        assert_eq!(id_c3, 3);
    }

    #[test]
    fn register_errors_when_id_space_exhausted() {
        let pkg = empty_pkg();
        {
            let mut st = pkg.state.write().unwrap();
            st.next_command_id = u16::MAX; // one slot left: u16::MAX itself
        }
        #[command] fn c1(_: TestIn) -> Result<TestOut> { Ok(TestOut { v: 0 }) }
        #[command] fn c2(_: TestIn) -> Result<TestOut> { Ok(TestOut { v: 0 }) }
        // u16::MAX is still allocatable
        pkg.register("c1", c1).unwrap();
        // next allocation overflows → id_exhausted
        let err = pkg.register("c2", c2).unwrap_err();
        assert_eq!(err.code(), "registry.id_exhausted");
    }

    #[derive(Debug, Serialize, Deserialize, JsonSchema)]
    struct TestIn { _v: i64 }
    #[derive(Debug, Serialize, Deserialize, JsonSchema)]
    struct TestOut { v: i64 }
}
```

**Step 5: Run → verify pass**

Run: `cargo test -p rustra`
Expected: PASS — both integration `unregister_removes_command` and the two white-box tests.

**Step 6: Commit**

```bash
git add crates/rustra/src/lib.rs crates/rustra/tests/public_authoring_api_tests.rs
git commit -m "feat(rustra): runtime unregister() with retired-id guarantee + exhaustion guard"
```

---

## Task 9 (TDD): frozen blocks all mutation

**Files:**
- Modify: `crates/rustra/tests/public_authoring_api_tests.rs` (test only)

**Step 1: Write failing test** (append):

```rust
#[test]
#[cfg(debug_assertions)]
fn frozen_blocks_mutation() {
    let pkg = Package::builder("test.frozen_mutation").build();
    pkg.register("cmd", add_numbers).unwrap();
    pkg.freeze();

    let e1 = pkg.register("other", add_numbers).unwrap_err();
    assert_eq!(e1.code(), "registry.frozen");
    let e2 = pkg.unregister("cmd").unwrap_err();
    assert_eq!(e2.code(), "registry.frozen");
    let e3 = pkg.replace("cmd", add_numbers).unwrap_err();
    assert_eq!(e3.code(), "registry.frozen");

    // invoke still works when frozen
    let out: AddNumbersOutput = pkg.invoke("cmd", AddNumbersInput { a: 1, b: 2 }).unwrap();
    assert_eq!(out.value, 3);
}
```

**Step 2: Run → verify pass** (mutation methods already check `ensure_mutable`)

Run: `cargo test -p rustra --test public_authoring_api_tests frozen_blocks`
Expected: PASS.

**Step 3: Commit**

```bash
git add crates/rustra/tests/public_authoring_api_tests.rs
git commit -m "test(rustra): frozen registry rejects all mutation"
```

---

## Task 10: Docs — README + architecture

**Files:**
- Modify: `README.md` (add a "런타임 명령 레지스트리" subsection under "Rust: 명령 정의")
- Modify: `docs/architecture.md` (add a "런타임 명령 레지스트리 (dev/prod)" section)

**Step 1: Add to README.md** after the "패키지를 빌드하고 TypeScript 코드 생성" block (~line 116), a new subsection:

```markdown
## 런타임 명령 레지스트리 (dev/prod)

`Package`는 debug 빌드에서 런타임에 명령을 추가/교체/삭제할 수 있다. release 빌드에서는
`build()` 시점에 자동 동결되어 불변이 된다.

```rust
let pkg = rustra::build!("my.pkg", add_numbers).done();

// debug 빌드에서만 동작. release에서는 registry.frozen 에러.
pkg.register("double", |i: NumIn| Ok(NumOut { value: i.x * 2 }))?;
pkg.unregister("addNumbers")?;
pkg.freeze(); // 명시적 봉인 (prod 동작 시뮬레이션)
```

- 동적으로 등록된 명령은 이름 기반 JSON 경로(`engine.invoke('name', ...)`)로 호출된다.
- `command_id`는 단조 증가하며, 삭제 시 재사용되지 않는다.
```

**Step 2: Add to docs/architecture.md** a new section before "## 계약 불변식" (~line 356):

```markdown
## 런타임 명령 레지스트리 (dev/prod)

`Package` 내부는 `Arc<RwLock<RegistryState>>` + `Arc<AtomicBool> frozen` 이다.

- **debug 빌드** (`debug_assertions`): `build()` 후에도 mutable. `register`/`register_fn`/`replace`/`unregister` 로 런타임 변경 가능.
- **release 빌드**: `build()` 시점 `frozen = true` 로 자동 동결. mutation 시도는 `RustraError { code: "registry.frozen" }` 반환.

불변식:
1. `command_id` (u16)는 단조 증가. `unregister` 시 retired 되어 **재사용 금지**.
2. 읽기(`invoke_*`, `generate_typescript`)는 읽기 잠금, mutation은 쓰기 잠금. 핸들러 실행 중엔 잠금을 hold 하지 않는다(clone-out) → 재진입 교착 방지.
3. 동적 등록 명령은 codegen schema에 ID가 노출되지 않으므로 **이름/JSON 경로**로만 호출. 정적 등록 명령은 rkyv V2 바이너리 fast-path 유지.
```

**Step 3: Verify docs build/links**

Run: `cargo test --doc -p rustra` (doc-tests still pass)
Expected: PASS.

**Step 4: Commit**

```bash
git add README.md docs/architecture.md
git commit -m "docs: runtime command registry (dev mutable / prod frozen)"
```

---

## Task 11: Full verification & lint

**Step 1: Full workspace test (debug)**

Run: `cargo test --workspace`
Expected: ALL PASS.

**Step 2: Release-mode freeze behavior**

Run: `cargo test --release -p rustra`
Expected: `release_build_is_frozen_by_default` PASS; mutation tests that rely on debug-mutability should be `#[cfg(debug_assertions)]`-gated so they're absent/ignored in release.

**Step 3: Clippy + fmt**

Run: `cargo clippy --all-targets -- -D warnings`
Expected: no warnings.

Run: `cargo fmt --all -- --check`
Expected: clean (if not, run `cargo fmt --all` and re-check).

**Step 4: TypeScript lint (if any generated/example TS touched)** — only if examples changed. Skip if untouched.

Run: `npm run lint` (optional, only if TS files changed)

**Step 5: Final commit if fmt touched anything**

```bash
git add -A
git commit -m "style: rustfmt after runtime command registry"
```

---

## Done criteria

- [ ] `Package` supports `register`/`register_fn`/`replace`/`unregister`/`freeze`/`is_frozen`.
- [ ] debug builds mutable; release builds frozen at `build()`.
- [ ] `command_id` never reused after `unregister`; u16 exhaustion guarded.
- [ ] All existing tests pass unchanged (no regressions).
- [ ] New tests pass in both debug and `--release`.
- [ ] `cargo clippy -- -D warnings` clean; `cargo fmt --check` clean.
- [ ] README + architecture docs updated.

# Dynamic Commands on rkyv V2 (Tier 3) + Live Schema — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make runtime-registered (dynamic) commands callable via the **same rkyvV2 engine** as static commands, with a **live schema** query so TS can discover dynamic commands' id/types. Dev-only DX; prod (release/frozen) unaffected.

**Architecture:** Dynamic commands are forced to **Tier 3 (JSON-in-binary)** at registration (`rkyv_v2_handler = None`, JSON decoder). The TS `createRkyvV2Engine` falls back to Tier 3 for any command absent from the static codec registry, using the `commandId` from a live-schema query (`rustra_ffi_get_schema`). Static commands keep their fast postcard path; prod has no dynamic commands (frozen).

**Tech Stack:** Rust (`crates/rustra`), TypeScript (`packages/types`), JSI/C++ (`RustraJSIBridge.cpp`), RN example. Tests: Rust integration, TS unit (mock native), RN sim.

**Design doc:** `docs/plans/2026-07-04-dynamic-rkyv-path-design.md`

**Branch:** `feat/rn-dynamic-registry-demo` (has RN plumbing for sim verification).

---

## Wire formats (reference)

- **Tier 3 request**: `[command_id: u16 LE @0][json_string @2]`
- **Tier 3 success response**: `[ok: u8 @0 = 1][pad 3B][json_len: u32 LE @4][json @8]`
- **rkyv V2 error response** (`encode_rkyv_v2_error`): `[ok: u8 @0 = 0][pad to @8][err_len: u16 LE @8][err_utf8 @10]`

---

## Task 1: `build_command` force_tier3 + `register`/`register_fn` use it

**Files:**
- Modify: `crates/rustra/src/lib.rs` (`build_command` ~line 257, `register`/`register_fn` ~line 340)

**Step 1: Write failing test** (append to `runtime_registry_tests` mod in `crates/rustra/src/lib.rs`):

```rust
    #[test]
    #[cfg(debug_assertions)]
    fn dynamic_command_invokable_via_rkyv_v2_tier3() {
        let pkg = empty_pkg();
        pkg.register("echo", echo).unwrap();
        // command_id 1 — Tier 3 wire: [id:u16 LE @0][json @2]
        let json = br#"{"v":7}"#;
        let mut payload = vec![0u8; 2 + json.len()];
        payload[0..2].copy_from_slice(&1u16.to_le_bytes());
        payload[2..].copy_from_slice(json);
        let resp = pkg.invoke_rkyv_v2(&payload).unwrap();
        // success tier3: [ok:1 @0][pad3][json_len:u32 LE @4][json @8]
        assert_eq!(resp[0], 1);
        let len = u32::from_le_bytes(resp[4..8].try_into().unwrap()) as usize;
        let out: serde_json::Value = serde_json::from_slice(&resp[8..8 + len]).unwrap();
        assert_eq!(out["v"], 7);
    }
```

Add (alongside `c1`/`c2`/`c3` in the mod) an `echo` handler + types:
```rust
    #[derive(Debug, Serialize, Deserialize, JsonSchema)]
    struct EchoIn { v: i64 }
    #[derive(Debug, Serialize, Deserialize, JsonSchema)]
    struct EchoOut { v: i64 }
    fn echo(input: EchoIn) -> Result<EchoOut> { Ok(EchoOut { v: input.v }) }
```

**Step 2: Run → verify failure**

Run: `cargo test -p rustra dynamic_command_invokable_via_rkyv_v2_tier3`
Expected: FAIL — dynamic command's `rkyv_v2_handler` is `Some` (postcard), so Tier 3 JSON payload fails to decode.

**Step 3: Implement** — add `force_tier3: bool` to `build_command`:

```rust
fn build_command<I, O, F>(command_id: u16, handler: F, force_tier3: bool) -> Command
where
    I: DeserializeOwned + JsonSchema + 'static,
    O: Serialize + JsonSchema + 'static,
    F: Fn(I) -> crate::Result<O> + Send + Sync + 'static,
{
    // ... (input_schema, output_schema, definitions unchanged) ...
    let (rkyv_v2_decoder, input_tier) = build_rkyv_v2_decoder(&input_schema);
    let output_tier3 = is_output_tier3(&output_schema);
    let is_tier3 = force_tier3 || input_tier == Tier::Tier3 || output_tier3;
    let rkyv_v2_decoder = if force_tier3 || (is_tier3 && input_tier != Tier::Tier3) {
        build_tier3_json_decoder()
    } else {
        rkyv_v2_decoder
    };
    let rkyv_v2_response_encoder = build_rkyv_v2_response_encoder(&output_schema, is_tier3);

    let handler = Arc::new(handler);
    // force_tier3 → No postcard fast handler; fall through to Tier 3 JSON decode.
    let rkyv_v2_handler: Option<BinHandler> = if force_tier3 {
        None
    } else {
        let handler_bin = handler.clone();
        Some(Arc::new(move |payload: &[u8]| {
            if payload.len() < 2 {
                return Err(RustraError::invalid_args("rkyv v2: payload too short"));
            }
            let input: I = postcard::from_bytes(&payload[2..])
                .map_err(|e| RustraError::invalid_args(format!("postcard decode: {e}")))?;
            let output = handler_bin(input)?;
            let out_bytes = postcard::to_allocvec(&output)
                .map_err(|e| RustraError::internal(format!("postcard encode: {e}")))?;
            let mut buf = vec![0u8; 8 + out_bytes.len()];
            buf[0] = 1;
            buf[8..8 + out_bytes.len()].copy_from_slice(&out_bytes);
            Ok(buf)
        }))
    };

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

Update callers:
- `PackageBuilder::command`: `build_command::<I, O, F>(self.next_command_id, handler, false)` (static → not forced).
- `Package::register`: `build_command::<I, O, F>(command_id, handler, true)` (dynamic → Tier 3).
- `Package::register_fn`: calls `register` (inherits true).
- `Package::replace`: `build_command::<I, O, F>(command_id, handler, false)` (keep schema-derived; static codec stays valid).

**Step 4: Run → verify pass**

Run: `cargo test -p rustra`
Expected: PASS (new test + all existing).

**Step 5: Commit**

```bash
git add crates/rustra/src/lib.rs
git commit -m "feat(rustra): force Tier 3 for dynamic commands (rkyv V2 path)"
```

---

## Task 2: `Package::live_schema()` public

**Files:**
- Modify: `crates/rustra/src/lib.rs` (add public method; reuse private `schema(id, state)`)

**Step 1: Write failing test** (append to `runtime_registry_tests`):

```rust
    #[test]
    #[cfg(debug_assertions)]
    fn live_schema_includes_dynamic_command() {
        let pkg = empty_pkg();
        pkg.register("echo", echo).unwrap();
        let s = pkg.live_schema();
        let cmds = s["commands"].as_array().unwrap();
        let echo_entry = cmds.iter().find(|c| c["name"] == "echo").unwrap();
        assert_eq!(echo_entry["commandId"], 1);
        assert!(echo_entry["inputSchema"]["properties"]["v"]["type"] == "integer");
    }
```

**Step 2: Run → verify failure** (`no method named live_schema`)

**Step 3: Implement** — add to `impl Package`:

```rust
/// 현재 등록된 모든 명령의 라이브 스키마를 반환한다 (정적 + 동적).
/// 읽기 전용이므로 debug/release 모두에서 사용 가능.
pub fn live_schema(&self) -> Value {
    let state = self.state.read().unwrap();
    Self::schema(&self.id, &state)
}
```

**Step 4: Run → verify pass**: `cargo test -p rustra live_schema`

**Step 5: Commit**: `git commit -m "feat(rustra): Package::live_schema() public"`

---

## Task 3: `rustra_ffi_get_schema` FFI

**Files:**
- Modify: `crates/rustra/src/ffi.rs`

**Step 1: Write failing test** (append to `mod tests` in ffi.rs):

```rust
    #[test]
    fn ffi_get_schema_returns_json() {
        let pkg = Package::builder("test.schema")
            .command("add", |args: serde_json::Value| {
                Ok::<_, crate::RustraError>(serde_json::json!(1))
            })
            .build();
        pkg.register_ffi();
        let mut out_len: usize = 0;
        let ptr = unsafe { rustra_ffi_get_schema(&mut out_len) };
        assert!(!ptr.is_null());
        let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) };
        let v: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        assert_eq!(v["packageId"], "test.schema");
        assert!(v["commands"].as_array().unwrap().iter().any(|c| c["name"] == "add"));
        unsafe { rustra_ffi_free(ptr, out_len) };
    }
```

**Step 2: Run → verify failure** (`rustra_ffi_get_schema not found`)

**Step 3: Implement** — add to ffi.rs (after `rustra_ffi_free`):

```rust
/// 현재 등록된 패키지의 라이브 스키마를 JSON 바이트로 반환한다.
/// 반환 버퍼는 `rustra_ffi_free` 로 해제. read-only (debug/release 모두).
///
/// # Safety
/// `out_len` must be a valid write pointer. Caller must free with `rustra_ffi_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_get_schema(out_len: *mut usize) -> *mut u8 {
    match get_package() {
        Some(pkg) => {
            let json = serde_json::to_vec(&pkg.live_schema()).unwrap_or_else(|_| b"{}".to_vec());
            alloc_response(json, out_len)
        }
        None => alloc_response(b"{}".to_vec(), out_len),
    }
}
```

**Step 4: Run → verify pass**: `cargo test -p rustra ffi_get_schema`

**Step 5: Commit**: `git commit -m "feat(rustra): rustra_ffi_get_schema FFI for live schema"`

---

## Task 4: JSI bridge — expose `getSchema`

**Files:**
- Modify: `examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.cpp`

**Step 1: Implement** — add to `RustraHostObject` constructor (after the `noop` block, before closing `}`):

```cpp
  // live schema query → rustra_ffi_get_schema
  {
    extern "C" uint8_t* rustra_ffi_get_schema(size_t* out_len);
    auto propNameId = PropNameID::forAscii(rt, "getSchema");
    auto hostFn = Function::createFromHostFunction(
      rt, propNameId, 0,
      [](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        size_t out_len = 0;
        uint8_t* data = rustra_ffi_get_schema(&out_len);
        if (!data) {
          throw JSError(rt, "RustraJSI: getSchema returned null");
        }
        auto returnValue = createArrayBuffer(rt, data, out_len);
        rustra_ffi_free(data, out_len);
        return returnValue;
      });
    cache_["getSchema"] = std::make_unique<CachedFunction>(
      CachedFunction{std::move(propNameId), std::move(hostFn)});
  }
```

Also declare `getSchema` in the `RustraNative` TS type (Task 5 covers TS).

**Step 2: Verify compile** — rebuild debug iOS lib + app (covered in Task 7 sim run). For now: `cargo build -p rustra` (ensures Rust side compiles). The C++ compiles at the iOS build step.

**Step 3: Commit**: `git commit -m "feat(rn-jsi): expose getSchema (live schema) to JS"`

---

## Task 5: TS — `getLiveSchema` + rkyvV2 engine Tier 3 fallback

**Files:**
- Modify: `packages/types/src/index.ts` (add `getLiveSchema`; extend `createRkyvV2Engine`; add `getSchema` to a native type)

**Step 1: Write failing test** — check `packages/types/package.json` for the test runner (vitest/jest). Add `packages/types/src/index.test.ts` (or per existing convention):

```ts
import { describe, it, expect } from 'vitest'; // adjust to actual runner
import { createRkyvV2Engine } from './index';

describe('createRkyvV2Engine Tier 3 fallback', () => {
  it('calls dynamic command via Tier 3 when no static codec', async () => {
    // live schema: echo → commandId 1
    const schema = new TextEncoder().encode(
      JSON.stringify({ packageId: 't', commands: [{ name: 'echo', commandId: 1 }] }),
    );
    // success tier3 response: [ok:1][pad3][json_len:u32@4][json@8]
    const json = new TextEncoder().encode(JSON.stringify({ v: 7 }));
    const resp = new Uint8Array(8 + json.length);
    resp[0] = 1;
    new DataView(resp.buffer).setUint32(4, json.length, true);
    resp.set(json, 8);

    const native = {
      invokeRkyvV2: (payload: ArrayBuffer) => {
        // verify request: [id:u16@0]=1, then json
        const dv = new DataView(payload);
        expect(dv.getUint16(0, true)).toBe(1);
        return resp.buffer.slice(0) as ArrayBuffer;
      },
      getSchema: () => schema.buffer.slice(0) as ArrayBuffer,
    };
    const registry = new Map(); // empty → forces Tier 3
    const engine = createRkyvV2Engine(native as any, registry);
    const out = await engine.invoke<{ v: number }>('echo', { v: 7 });
    expect(out.v).toBe(7);
  });
});
```

**Step 2: Run → verify failure** (`getSchema not on type` / no fallback).

**Step 3: Implement** — in `packages/types/src/index.ts`:

Add a native type with `getSchema` (extend `RkyvV2Native` usage via a new optional param, or a broader type). Simplest: change `createRkyvV2Engine` to accept `native: RkyvV2Native & { getSchema(): ArrayBuffer }`:

```ts
export type RkyvV2SchemaNative = {
  invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer;
  getSchema(): ArrayBuffer;
};

export type LiveSchemaEntry = {
  commandId: number;
  inputSchema?: unknown;
  outputSchema?: unknown;
};

/** 런타임에 live schema 를 조회한다 (동적 명령의 commandId/types 포함). */
export function getLiveSchema(native: { getSchema(): ArrayBuffer }): Map<string, LiveSchemaEntry> {
  const bytes = native.getSchema();
  const json = new TextDecoder().decode(new Uint8Array(bytes));
  const parsed = JSON.parse(json) as { commands?: Array<{ name: string; commandId: number; inputSchema?: unknown; outputSchema?: unknown }> };
  const map = new Map<string, LiveSchemaEntry>();
  for (const c of parsed.commands ?? []) {
    map.set(c.name, { commandId: c.commandId, inputSchema: c.inputSchema, outputSchema: c.outputSchema });
  }
  return map;
}

// Tier 3 wire helpers
function encodeTier3Request(commandId: number, args: unknown): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(args ?? {}));
  const buf = new Uint8Array(2 + json.length);
  new DataView(buf.buffer).setUint16(0, commandId, true);
  buf.set(json, 2);
  return buf.buffer;
}

function decodeTier3Response(bytes: ArrayBuffer): { ok: boolean; result?: unknown; error?: string } {
  const u = new Uint8Array(bytes);
  if (u[0] === 1) {
    const len = new DataView(bytes).getUint32(4, true);
    const json = new TextDecoder().decode(u.slice(8, 8 + len));
    return { ok: true, result: JSON.parse(json) };
  }
  const errLen = new DataView(bytes).getUint16(8, true);
  const err = new TextDecoder().decode(u.slice(10, 10 + errLen));
  return { ok: false, error: err };
}
```

Replace `createRkyvV2Engine` with a version that accepts `RkyvV2SchemaNative` and falls back:

```ts
export function createRkyvV2Engine(
  native: RkyvV2SchemaNative,
  registry: Map<string, RkyvV2Codec<any, any>>,
): EngineClient {
  let schemaCache: Map<string, LiveSchemaEntry> | null = null;
  const liveSchema = () => (schemaCache ??= getLiveSchema(native));

  return {
    invoke<T>(command: string, args?: unknown): Promise<T> {
      const codec = registry.get(command);
      if (codec) {
        const resultBytes = native.invokeRkyvV2(codec.encode(args));
        const response = codec.decode(resultBytes);
        if (!response.ok) throw new Error(response.error ?? 'RkyvV2 invoke failed');
        return Promise.resolve(response.result as T);
      }
      // Tier 3 fallback for dynamic (non-codegen) commands
      const entry = liveSchema().get(command);
      if (!entry) {
        throw new Error(`RkyvV2: no codec and not in live schema for "${command}"`);
      }
      schemaCache = null; // invalidate after a dynamic call (state may have changed)
      const resp = decodeTier3Response(native.invokeRkyvV2(encodeTier3Request(entry.commandId, args)));
      if (!resp.ok) throw new Error(resp.error ?? 'RkyvV2 (tier3) invoke failed');
      return Promise.resolve(resp.result as T);
    },
  };
}
```

**Compatibility note:** Existing callers pass `RkyvV2Native` (no `getSchema`). Add `getSchema?` optional to `RkyvV2SchemaNative` or keep `getSchema` required and update adapters. Simplest: make `getSchema` required and update the example's `createFastEngine` wiring (Task 6). Non-RN adapters (node/bun) that don't expose getSchema → the fallback throws only for dynamic commands (static path still works), so add `getSchema?` optional to be safe:

```ts
export type RkyvV2SchemaNative = {
  invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer;
  getSchema?(): ArrayBuffer;
};
```
and guard `liveSchema()` with `if (!native.getSchema) throw ...`.

**Step 4: Run → verify pass**: `npm test --workspace @rustra/types` (or the package's test cmd).

**Step 5: Commit**: `git commit -m "feat(types): rkyvV2 engine Tier 3 fallback + getLiveSchema"`

---

## Task 6: Example — dynamic command via single rkyvV2 engine + live schema

**Files:**
- Modify: `examples/react-native-calculator/DynamicRegistryApp.tsx`

**Step 1: Implement** — add a section that uses the **rkyvV2 engine** (not JSON engine) for a dynamic command and displays the live schema:

```ts
import { createRkyvV2Engine, getLiveSchema } from "@rustra/types";
// ...
// after installRustraJSI():
const rkyvEngine = createRkyvV2Engine(getRustraNative() as any, rkyvV2Registry_static_empty_or_imported);
// register a dynamic command via the control command (JSON path, one-off):
await call("rustraRegistryDemo", { op: "registerAvg" });
const schema = getLiveSchema(getRustraNative() as any);
const avgEntry = schema.get("average");
log(`live schema: 'average' commandId=${avgEntry?.commandId}`);
// call it via the SAME rkyvV2 engine (Tier 3 fallback):
const avg = await rkyvEngine.invoke<{ average: number; count: number }>("average", { numbers: [10, 20, 30, 40] });
log(`rkyvV2 engine.invoke('average') → average=${avg.average} count=${avg.count}`);
```

(Exact integration depends on how `rkyvV2Registry` is imported; if the static registry isn't needed, pass an empty `Map`.)

**Step 2: Rebuild** — `RUSTRA_PROFILE=debug ./build-rust-ios.sh` then `npx expo run:ios --device "iPhone 17"`.

**Step 3: Verify on sim** — screenshot + OCR; expect a line showing the dynamic command called via the rkyvV2 engine + its commandId from live schema.

**Step 4: Commit**: `git commit -m "feat(rn-example): dynamic command via single rkyvV2 engine + live schema"`

---

## Task 7: Verification + docs

**Step 1: Full Rust suite**: `cargo test --workspace` → all pass.
**Step 2: Release sanity**: `cargo test --release -p rustra` → mutation tests compiled out; static + schema tests pass.
**Step 3: Clippy/fmt**: `cargo clippy -p rustra --all-targets -- -D warnings`; `rustfmt` touched files.
**Step 4: Docs**: append a "Dynamic commands → rkyv V2 (Tier 3) + live schema" subsection to `docs/architecture.md` and `README.md`.
**Step 5: Commit**: `git commit -m "docs: dynamic commands on rkyv V2 + live schema"`

---

## Done criteria

- [ ] Dynamic commands (runtime `register`) invokable via `invoke_rkyv_v2` (Tier 3 wire) — Rust test.
- [ ] `Package::live_schema()` + `rustra_ffi_get_schema` work; JSI exposes `getSchema`.
- [ ] `createRkyvV2Engine` Tier 3 fallback for non-codegen commands — TS unit test.
- [ ] RN sim: dynamic command called via the single rkyvV2 engine + live schema commandId shown.
- [ ] Static commands unaffected (fast postcard path); prod (release/frozen) unaffected.
- [ ] `cargo test --workspace`, `--release -p rustra`, clippy, fmt all clean.

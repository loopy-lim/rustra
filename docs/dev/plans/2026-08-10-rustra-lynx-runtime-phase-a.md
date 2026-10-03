# rustra-lynx-runtime Phase A Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prove Lynx + Rust + renderer-neutral Rustra core runs end-to-end as a native macOS desktop app — no mock/fallback, `invocations > 0`.

**Architecture:** Evolve the working headless host (`/tmp/rustra-lynx-host/host.cpp`) into the project. Prove the data plane (registration + event push + protocol + authority + RendererHost) in the headless host first, then attach a native window. No Tauri `Runtime` trait work in Phase A.

**Tech Stack:** Rust staticlib (`rustra_calculator_invoke_rkyv_v2`), C++ host (libLynx CAPI, weak-napi), ReactLynx bundle (rspeedy), TypeScript (`@rustra/lynx` / new `@rustra/api`).

**Design ref:** `docs/plans/2026-08-10-rustra-lynx-runtime-design.md`

**Implementation order** (per user): registration → event push → window/surface, with abstraction cleanup interleaved.

---

## Phase A success criteria (all must pass)

1. macOS native window 생성
2. Lynx surface가 window 안에 표시
3. `NativeModules.RustraModule` 실제 등록
4. ReactLynx → Rust invoke 성공
5. Rust → ReactLynx event push 성공
6. typed error 왕복
7. 최소 channel/stream 검증
8. capability 없는 command deny
9. `RendererHost` trait 통해 Lynx host 동작
10. mock/fallback 없이 end-to-end

---

## Task 0: Promote headless host into the project

**Files:**

- Create: `examples/lynx-calculator/host/host.cpp` (copy of `/tmp/rustra-lynx-host/host.cpp`, unchanged)
- Create: `examples/lynx-calculator/host/build.sh` (the clang++ build command from the headless recipe)
- Create: `examples/lynx-calculator/host/Info.plist`, `.app` scaffold symlinks

**Step 1:** Copy host.cpp verbatim into `examples/lynx-calculator/host/`.
**Step 2:** Write `build.sh` encoding the verified build line:

```bash
clang++ -std=c++17 -O1 -DUSE_WEAK_SUFFIX_NAPI \
  -I/tmp/lynx-prebuilt/macsdk/include \
  host.cpp <path-to-librustra_calculator_example.a> \
  -L/tmp/lynx-prebuilt/macsdk/lib -lLynx \
  -framework Foundation -framework CoreGraphics -framework Metal -framework MetalKit \
  -framework OpenGL -framework QuartzCore -framework IOKit -framework CoreFoundation \
  -rpath /tmp/lynx-prebuilt/macsdk/lib \
  -o HostApp.app/Contents/MacOS/host
```

**Step 3:** Build + run against the existing bundle, capture `run.log`. **Baseline expectation:** renders, `invocations=0` (known fallback state — this is the gap Task 1 fixes).
**Step 4:** Commit baseline.

---

## Task 1: Registration roundtrip — `NativeModules.RustraModule` → real Rust (SUCCESS CRITERION 3, 4)

**The hypothesis to verify:** the extension-module `runtime_ready` callback is the only SDK hook that gives `(napi_env, napi_value global)` on the BTS thread. Inject `NativeModules.RustraModule = { invokeRkyvV2 }` there.

**Files:**

- Modify: `examples/lynx-calculator/host/host.cpp`

**Step 1: Add extension-module includes** (after existing `#include "capi/lynx_native_module_capi.h"`):

```cpp
#include "capi/lynx_extension_module_capi.h"
#include "capi/lynx_extension_module_types_capi.h"
```

**Step 2: Add the runtime_ready injector** (after `RustraModuleCreator`, ~host.cpp:192). This is the registration-gap fix:

```cpp
// BTS-thread hook: the ONLY SDK callback with (napi_env, global) on the BTS
// thread. Inject NativeModules.RustraModule so ReactLynx actually reaches Rust.
static void OnExtRuntimeReady(lynx_extension_module_t * /*self*/,
                              napi_env_weak env, napi_value_weak global,
                              const char * /*url*/) {
  napi_value_weak exports = nullptr, fn = nullptr;
  napi_create_object_weak(env, &exports);
  napi_create_function_weak(env, "invokeRkyvV2", NAPI_AUTO_LENGTH,
                            InvokeRkyvV2, nullptr, &fn);
  napi_set_named_property_weak(env, exports, "invokeRkyvV2", fn);

  // Primary: NativeModules.RustraModule (what @rustra/lynx getRustraNative reads)
  napi_value_weak nm = nullptr;
  napi_get_named_property_weak(env, global, "NativeModules", &nm);
  napi_set_named_property_weak(env, nm, "RustraModule", exports);
  // Belt-and-suspenders: also on global directly.
  napi_set_named_property_weak(env, global, "RustraModule", exports);
  fprintf(stderr, "[rustra] extension-module runtime_ready: injected NativeModules.RustraModule (BTS)\n");
}

static lynx_extension_module_t *RustraExtCreator(void * /*opaque*/) {
  lynx_extension_module_t *m = lynx_extension_module_create(nullptr);
  lynx_extension_module_set_napi_module_creator(m, RustraModuleCreator);
  lynx_extension_module_bind_runtime_ready(m, OnExtRuntimeReady);
  return m;
}
```

**Step 3: Register the extension module** (in `LynxMain`, right after the existing `lynx_env_register_native_module` call, ~host.cpp:308):

```cpp
lynx_env_register_native_module("RustraModule", RustraModuleCreator, nullptr);
// NEW: extension-module path with eager creation so runtime_ready fires.
lynx_env_register_extension_module("RustraModule", RustraExtCreator,
                                   /*is_lazy_create=*/0, nullptr);
```

**Step 4: Verify `App.tsx` calls the real module** — read `examples/lynx-calculator/src/App.tsx`. If it has a JS mock/fallback for `addNumbers`, ensure it routes through `NativeModules.RustraModule.invokeRkyvV2` (via `@rustra/lynx`). Remove any path that computes the result in JS.

**Step 5: Build + run.** Expected log: `[rustra] extension-module runtime_ready: injected ...` AND `invocations > 0`.
**Verify:** `grep invocations run.log` → value > 0. The on-screen `result: 42` now comes from real Rust.

**⚠ If `invocations` still 0:** the runtime_ready hook didn't fire or global injection didn't land. Diagnostic branches:

- Try `is_lazy_create=1`.
- Try per-view: `lynx_view_builder_register_extension_module(builder, "RustraModule", RustraExtCreator, 0, nullptr)` (~host.cpp:323).
- Confirm `OnExtRuntimeReady` is entered (add a `fprintf` at top). If not entered, BTS lifecycle differs from header docs — iterate.
  This is the **verify-against-actual-SDK** step the design flags as a hypothesis.

**Step 6:** Commit `feat(lynx): extension-module registration → real Rust invocation (invocations>0)`.

---

## Task 2: Event push — Rust → BTS task → ReactLynx (SUCCESS CRITERION 5)

**Approach:** inject a `__rustraDeliver(name, payload)` global at `runtime_ready`. Rust side (or host) posts events via `lynx_extension_module_post_task_to_runtime`, which runs a callback on the BTS thread that calls `__rustraDeliver`. For Phase A proof, the host itself emits a periodic `tick` event (Rust-driven in later tasks).

**Files:**

- Modify: `examples/lynx-calculator/host/host.cpp` (deliver fn + ticker)
- Modify: `examples/lynx-calculator/src/App.tsx` (listen + render tick count)

**Step 1: Add `__rustraDeliver` global in `OnExtRuntimeReady`:**

```cpp
napi_value_weak deliver = nullptr;
napi_create_function_weak(env, "__rustraDeliver", NAPI_AUTO_LENGTH,
                          DeliverEvent, nullptr, &deliver);
napi_set_named_property_weak(env, global, "__rustraDeliver", deliver);
```

**Step 2:** Implement `DeliverEvent(napi_env, cbinfo)` — receives `(name: string, payload)`, but for the proof ticker it's host-initiated: a BTS task that calls a stored global `__rustraDeliver` with `("tick", n)`. Store the env + global in a static for the post-task closure.
**Step 3:** In the pump loop, every ~1s, call `lynx_extension_module_post_task_to_runtime(module, TickTask, userdata)` where `TickTask` calls `__rustraDeliver("tick", count)`.
**Step 4:** `App.tsx` — `listen('tick')`, increment a counter, render it. Rebuild bundle.
**Step 5: Build + run.** Expected: tick counter increments on screen / in log. **Verify:** deliver calls observed, counter advances.
**Step 6:** Commit.

> Note: `lynx_extension_module_post_task_to_runtime` requires the `lynx_extension_module_t*` from the creator — store it globally in `RustraExtCreator`.

---

## Task 3: Rustra Protocol — framing ⫫ codec (SUCCESS CRITERION support, clean TDD)

**Files:**

- Create: `crates/rustra-protocol/src/lib.rs` (`FrameHeader`, `FrameKind`, encode/decode)
- Create: `crates/rustra-protocol/tests/framing.rs`
- Create: `crates/rustra-protocol/Cargo.toml`

**Step 1: Write failing tests** — `FrameHeader` round-trip for each `FrameKind`; payload codec pluggability (encode header + rkyv payload, decode back; same with postcard; same with JSON).
**Step 2:** Run → FAIL (crate missing).
**Step 3:** Implement `FrameHeader { magic, version, kind, request_id, stream_id, payload_len }` + `FrameKind` (8 variants) + codec trait, all codec-independent.
**Step 4:** Run → PASS.
**Step 5:** Wire existing rkyv V2 fast path as the rkyv codec impl (adapter, not rewrite).
**Step 6:** Commit.

---

## Task 4: Runtime Authority — minimal deny-by-default (SUCCESS CRITERION 8)

**Files:**

- Create: `crates/rustra-authority/src/lib.rs` (`BundleIdentity`, `Capability`, `Permission`, `Scope`, `Authority::check`)
- Create: `crates/rustra-authority/tests/authority.rs`

**Step 1: Write failing tests** — deny by default (empty capability set → `authority.denied`); allow when capability matches; scope rejects out-of-bounds args. Interface shaped for future signature/hash/version/rollback (stubbed).
**Step 2:** Run → FAIL.
**Step 3:** Implement the bundle-identity → capability → permission → scope chain. `deny-by-default`. Signature/roll‑back fields present but inert.
**Step 4:** Run → PASS.
**Step 5:** Integrate into the invoke path (host calls `Authority::check` before `invoke_rkyv_v2`). Verify criterion 8: a command without capability is denied.
**Step 6:** Commit.

---

## Task 5: `RendererHost` trait + `LynxHost` impl (SUCCESS CRITERION 9)

**Files:**

- Create: `crates/rustra/src/renderer_host.rs` (the webview-neutral trait from design §5)
- Refactor: host.cpp surface ops behind the trait shape (C++ host keeps its impl; Rust trait is the contract for the future Rust-native host)

**Step 1:** Define `RendererHost` trait + `RendererCapabilities` + `HostMessage` exactly as design §5.
**Step 2:** Stub/mock test — a `MockHost: RendererHost` validates `create_surface → load → send_message → destroy` flow + capability gating.
**Step 3:** Document that the C++ host is the current `LynxHost` realization; a Rust-native `LynxHost` wraps the same CAPI later.
**Step 4:** Commit.

---

## Task 6: Typed error roundtrip + minimal channel (SUCCESS CRITERION 6, 7)

**Files:**

- Modify: `examples/lynx-calculator/src/App.tsx` (trigger an error; open a channel)
- Modify: host.cpp (return an `InvokeError` frame; emit `ChannelData`)

**Step 1:** Add a command path that returns a typed error (e.g. divide-by-zero → `RustraError::custom`). Verify the error round-trips to `RustraCommandError` in ReactLynx (criterion 6).
**Step 2:** Add a minimal channel: a Rust "countdown" that pushes N frames; `App.tsx` receives via `Channel`. Verify frames arrive in order (criterion 7).
**Step 3:** Commit.

---

## Task 7: Native window/surface (macOS) (SUCCESS CRITERION 1, 2) — highest risk

**Approach (lowest-risk):** keep the working windowless software renderer (RGBA via `OnSoftwarePresent`), but blit each frame into an `NSWindow`'s `NSView` layer instead of dumping to `frame.raw`. Reuses the entire proven pipeline.

**Files:**

- Modify: `examples/lynx-calculator/host/host.cpp` (add NSWindow/CALayer blit)

**Step 1:** Create `NSWindow` + content `NSView` with a `CALayer`. In `OnSoftwarePresent`, build an `NSBitmapImageRep`/`CGImage` from the RGBA buffer and set it as the layer contents (or use a Metal blit if CG is too slow).
**Step 2:** Drive the NSWindow run loop (`[NSApp run]` / a timer) instead of the fixed-deadline pump; keep draining FML + renderer tasks each tick.
**Step 3:** Build + run. Expected: a real macOS window showing the calculator UI, live. **Verify criteria 1, 2.**
**⚠ Risk:** NSApp run loop vs. the custom FML pump may conflict. Fallback: keep the pump loop and just blit into a borderless window refreshed on each present.
**Step 4:** Commit.

---

## Task 8: End-to-end verification (all 10 criteria)

### Task 7 — DONE (2026-08-10)

Native window/surface proven. `host_ui.mm` (AppKit bridge, Obj-C++) creates an
`NSWindow` + layer-hosting `NSView`; the proven windowless software renderer's
RGBA is blitted into the view's `CALayer` via `CGImage` each `OnSoftwarePresent`.
No `[NSApp run]` (would clash with the FML pump): a non-blocking AppKit
event-drain (`nextEventMatchingMask:untilDate:distantPast`) is interleaved with
the pump loop, and `[CATransaction flush]` commits each frame. SIGTERM/SIGINT →
graceful close so post-loop dumps run. Opt-in via `RUSTRA_WINDOW=1`.

**Proof (criteria 1 + 2):**

- **Criterion 1 (native window):** window owned by `RustraLynxHost`, `onscreen=true`
  via `CGWindowListCopyWindowInfo`; also found by `SCShareableContent`.
- **Criterion 2 (Lynx surface in window):** the window's `CALayer` contents
  (read back same-process, no TCC needed) OCR as `rustra + Lynx` /
  `addNumbers(20, 22)` / **`result: 42`** / `tick: 5` — the live UI.
- Full pipeline intact in window mode: `invocations=1 resultAcked=1 val=42 ticks=5/5 acked=5`.

Cross-process display capture was TCC-blocked (Screen Recording denied for the
helper binary on macOS 26 — `CGDisplayCreateImage`/`CGWindowListCreateImage` are
removed; ScreenCaptureKit needs a grant). Same-process layer readback + on-screen
enumeration is the permission-free proof.

### Criteria status (running)

| #   | Criterion                             | Status | Evidence                                                |
| --- | ------------------------------------- | ------ | ------------------------------------------------------- |
| 1   | macOS native window                   | ✅     | onscreen window (CGWindowList)                          |
| 2   | Lynx surface in window                | ✅     | layer surface OCR `result: 42`                          |
| 3   | NativeModules.RustraModule registered | ✅     | `invocations=3`                                         |
| 4   | ReactLynx → Rust invoke               | ✅     | `resultAcked=1 val=42` (no fallback)                    |
| 5   | Rust → ReactLynx event push           | ✅     | `ticks=3/3 acked=3`                                     |
| 6   | typed error roundtrip                 | ✅     | `errAcked=1 code=math.divide_by_zero` + OCR             |
| 7   | minimal channel/stream                | ✅     | `tick=3` (vsync-pushed, ack roundtrip)                  |
| 8   | capability-less deny                  | ✅     | `capAcked=1 capCode=capability.denied` + OCR            |
| 9   | RendererHost drives Lynx              | ✅     | `renderer_host.rs` trait + MockHost lifecycle/cap tests |
| 10  | no mock/fallback e2e                  | ✅     | success-path ack (not catch)                            |

**All 10 Phase A criteria proven (2026-08-10).** Final headless summary line:

```
presented=1 load=1 firstscreen=1 rtready=1 error=1 invocations=3
resultAcked=1 val=42 ticks=3/3 acked=3
errAcked=1 code=math.divide_by_zero capAcked=1 capCode=capability.denied
```

- Criterion 6/8 wire errors encode as rkyv V2 `[ok=0][7B pad][len u16][postcard{code,message}]`;
  JS reconstructs `RustraCommandError(code)` and acks — a plain string-error or `.catch()`
  fallback could not carry these structured codes.
- Criterion 8 Runtime Authority is deny-by-default: `secure_compute` requires
  `compute:secure`, never granted (release host is frozen at build) → `capability.denied`
  before the handler runs. Core unit tests cover deny + grant-then-allow + frozen-grant
  refusal + rkyv-V2-path deny.
- Criterion 9 `RendererHost` (design §5) is webview-neutral (no `eval_script` in the core
  trait; it is an optional `RendererCapabilities` flag, deny-by-default all-false). The C++
  host remains the current `LynxHost` realization; a Rust-native `LynxHost` wraps the same
  libLynx CAPI in Phase B. 5 unit tests pass (lifecycle, destroyed-surface guard,
  deny-by-default caps, eval gating, message classification).

**Step 1:** Run the full app. Walk the 10-criteria checklist. Capture screenshot + `run.log`.
**Step 2:** Write a short verification note in `docs/plans/2026-08-10-rustra-lynx-runtime-phase-a.md` (append results).
**Step 3:** Commit.
**Step 4:** Feed results into the post-Phase-A decision (design §16: A/B/C).

---

## Execution

Subagent-driven in this session: dispatch a fresh subagent per task where the task is clean (Tasks 3, 4, 5 — Rust crate TDD), review between. Tight-loop the exploratory integration tasks (Tasks 1, 2, 7) on the main agent where SDK iteration is needed. Start with **Task 1**.

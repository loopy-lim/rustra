# rustra-lynx-runtime — Design (revised 2026-08-10)

> **Goal:** `ReactLynx + Rust + Tauri-like application model` 로 desktop/mobile을 공통 커버하는
> renderer-neutral runtime/framework. React Native / WebView에 의존하지 않는다.

## 설계 원칙

1. **Tauri는 Rustra Core의 부모 abstraction이 아니라 재사용 소스다.**
   Tauri application model은 `compatibility / reuse` 경로로 Rustra Core에 들어온다.
   Tauri compatibility는 목표 중 하나이되, **Rustra 내부 설계의 기준점은 아니다.**
2. **가장 오래 살아남을 3개 abstraction** — `Rustra Protocol`, `RendererHost`, `Runtime Authority`.
   이 세 가지는 Tauri/Wry/Lynx 버전 변화와 무관하게 안정적이어야 한다.
3. **재사용 우선순위:** `reuse > adapter > fork > rewrite`.
   단, "Tauri Core를 수정 없이 재사용할 수 있다"고 처음부터 가정하지 않는다.
   컴포넌트별 renderer coupling을 조사한 뒤 분류한다(§7).
4. **WebView semantics가 Lynx core를 오염시키지 않는다.**
   `RendererHost`는 webview-neutral이며, JS eval 등은 optional capability로 둔다.
5. **`@rustra/api`는 Rustra 고유 API다.** Tauri API 변화에 끌려다니지 않는다.
   Tauri 호환은 별도 adapter package(`@rustra/tauri-compat`)로 분리(§8).
6. **deny-by-default.** Bundle identity 중심 security principal(§10).

---

## 1. Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│  ReactLynx bundle (.lynx.bundle)                                │
│    @rustra/api   invoke · listen · once · Channel<T>            │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│  Rustra Protocol                                                │
│    framing (codec-independent, versioned) + payload codec       │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│  Rustra Core   (renderer-neutral)                               │
│    Commands · State · Events · Resources · Plugins              │
│    Runtime Authority  (deny-by-default, bundle-identity)        │
└──────────────────────────┬──────────────────────────────────────┘
                           │  trait RendererHost (webview-neutral)
                ┌──────────▼──────────┐
                │   Lynx host         │   Wry (back-compat, optional)
                └─────────────────────┘

  Tauri application model ──(compatibility / reuse)──▶ Rustra Core
  (설계 기준점이 아님. adapter/reuse 경로로만 진입)
```

Lynx renderer는 Wry의 하위 구현이 아니다. 두 renderer 모두 `RendererHost` trait의 구현체일 뿐이다.
Lynx를 Tauri `Runtime` peer로 구현할 수 있는지(`tauri-runtime-lynx`)는 **Phase A 이후 검증 항목**이며,
현재 Tauri Runtime contract가 WebView-shaped이므로 shim/adapter 없이는 보장하지 않는다(§16).

---

## 2. 세 long-lived abstraction

| Abstraction           | 역할                                                              | 안정성 근거                                |
| --------------------- | ----------------------------------------------------------------- | ------------------------------------------ |
| **Rustra Protocol**   | transport-neutral IPC 계약. framing(독립 versioning) + codec 분리 | 어떤 renderer/transport든 동일 바이트 계약 |
| **RendererHost**      | renderer-neutral surface 추상. webview 표현 없음                  | Lynx/Wry/미래 renderer 모두 동일 trait     |
| **Runtime Authority** | bundle identity 중심 deny-by-default 권한 결정                    | Tauri window/webview capability와 무관     |

이 세 가지가 Tauri/Wry churn을 흡수하는 완충층이다. Tauri 호환은 이 추상 **위**에 adapter로 올라간다.

---

## 3. Component boundaries

| 컴포넌트               | 위치                                          | 역할                                                   | 비고                   |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------ | ---------------------- |
| `@rustra/api`          | `packages/api/`(신규)                         | Rustra-native public API(`invoke/listen/once/Channel`) | Tauri 비종속(§8)       |
| Rustra Protocol        | `crates/rustra-protocol`(신규)                | framing + codec 분리, versioning                       | §4                     |
| Rustra Core            | `crates/rustra`(확장)                         | command authoring + app model + Authority              | Tauri 재사용 검토(§7)  |
| `RendererHost` trait   | `crates/rustra`                               | renderer-neutral surface 추상                          | §5                     |
| `Runtime Authority`    | `crates/rustra-authority`(신규)               | bundle identity → capability → permission → scope      | §10                    |
| Lynx native host       | `examples/lynx-*/modules` + macOS host binary | libLynx CAPI 임베드 + extension module 등록            | headless host.cpp 진화 |
| `@rustra/tauri-compat` | `packages/tauri-compat/`(신규, optional)      | Tauri API → Rustra API/Core adapter                    | 필요 시(§8)            |

**경계 원칙:** Rustra Protocol은 transport를 모른다(바이트 프레임만). `RendererHost`는 Tauri를 모른다(surface 연산만).
Tauri application model 재사용은 Rustra Core **내부** 구현 디테일이며, 밖으로 새어나오지 않는다.

---

## 4. Rustra Protocol (framing ⫫ codec)

```text
Rustra Protocol
      │
      ├── framing      (codec-independent, 독립 versioning)
      │
      └── payload codec
             ├── rkyv         (zero-copy fast path — 기존 안정 경로 재사용)
             ├── postcard     (compact, no_std 친화)
             └── JSON fallback (Tier 3 동적 명령)
```

### Frame header (codec-independent, versioned)

```rust
struct FrameHeader {
    magic: u32,        // protocol sentinel
    version: u16,      // framing version (codec과 독립)
    kind: FrameKind,
    request_id: u64,   // invoke 요청 식별 (ok/error 매칭)
    stream_id: u64,    // channel/stream 식별 (0 = 요청/단발)
    payload_len: u32,
}

enum FrameKind {
    Invoke,        // JS → Rust
    InvokeOk,      // Rust → JS (응답)
    InvokeError,   // Rust → JS (에러 응답)
    Event,         // Rust → JS (broadcast push)
    ChannelOpen,
    ChannelData,
    ChannelClose,
    ChannelError,
}
```

- **framing은 codec과 독립적으로 versioning**한다. payload는 협상된 codec(rkyv/postcard/JSON)으로 encode/decode.
- **기존 rkyv V2 fast path**(`[cmd_id u16][postcard Input] → [ok u8][pad][postcard Output]`)는 안정적으로 재사용 가능하면
  protocol의 rkyv/postcard codec 구현체로 흡수한다. 단, framing과 codec은 반드시 분리된 레이어.
- **Phase A에서는 correctness를 performance보다 우선**해도 된다. fast path 최적화는 실증 이후.
- **codec 협상:** 초기 handshake(또는 compile-time registry)으로 static 명령 = rkyv/postcard, 동적 명령 = JSON(Tier 3)을 유지.

---

## 5. RendererHost (webview-neutral)

WebView 표현(`eval_script` 등)을 제거하고, 모든 renderer가 만족하는 surface 연산만 노출한다.
JS/BTS 코드 실행이 정말 필요하면 **optional capability**로 둔다.

```rust
pub trait RendererHost: Send + 'static {
    type Surface;
    type Bundle;

    fn create_surface(&self, options: SurfaceOptions) -> Result<Self::Surface>;
    fn load(&self, surface: &Self::Surface, bundle: Self::Bundle) -> Result<()>;
    fn send_message(&self, surface: &Self::Surface, message: HostMessage) -> Result<()>;
    fn resize(&self, surface: &Self::Surface, size: Size) -> Result<()>;
    fn set_visibility(&self, surface: &Self::Surface, visible: bool) -> Result<()>;
    fn destroy(&self, surface: Self::Surface) -> Result<()>;

    fn capabilities(&self) -> RendererCapabilities;
}

pub struct RendererCapabilities {
    pub evaluate_script: bool,   // Lynx: true (BTS JS eval), 순수 present-only renderer: false
    pub navigation: bool,        // 기본 false
    pub cookies: false,
    pub browser_history: false,
    pub devtools: false,
}

pub enum HostMessage {
    InvokeResponse { request_id, payload },   // invoke 응답을 renderer로
    Event { name, payload },                  // event push를 renderer로
    ChannelFrame { stream_id, frame },
}
```

- `LynxHost: RendererHost<Surface = LynxSurface, Bundle = LynxBundle>` — libLynx CAPI 구현.
- `WryHost: RendererHost<Surface = ..., Bundle = WebUrl>` — back-compat webview 경로.
- `evaluate_script` capability가 true인 renderer만 JS eval 기반 init/eval을 사용한다.
  Lynx는 `runtime_ready` 훅에서 BTS JS eval이 가능하므로 true.

---

## 6. NativeModule registration (Phase A **가설** — 검증 대상)

> ⚠️ 아래 경로는 구현 우선 방향이지, **실제 SDK 검증 전까지 보장된 구조로 문서화하지 않는다.**

연구에서 식별된 방향(host.cpp의 native-module 경로가 `NativeModules`에 도달하지 못하는 갭의 수정처):

```text
[MAIN, view 생성 전]
  lynx_env_register_extension_module("RustraModule", creator, is_lazy_create=false, opaque)
    creator:
      lynx_extension_module_create → set_napi_module_creator(exports 빌드)
                                  → bind_runtime_ready(OnRuntimeReady)
[BTS, runtime_ready]
  OnRuntimeReady(module, napi_env, napi_value global, url):
    napi_create_function(invokeRkyvV2) → exports
    napi_create_function(__rustraDeliver) → global   // event push 진입점
    napi_get_named_property(global, "NativeModules") → set "RustraModule" = exports
```

근거: `runtime_ready`가 SDK 전체에서 유일하게 BTS thread에서 live `napi_env` + global을 함께 준다
(`lynx_extension_module_capi.h:105`). weak-napi ABI(`-DUSE_WEAK_SUFFIX_NAPI`) 필수.

**Phase A 첫 번째 성공 기준 (mock/fallback 인정 없음):**

```text
ReactLynx → NativeModules.RustraModule → native/CAPI → Rust → native/CAPI → ReactLynx
```

전체 왕복이 실제로 일어나야 하며, **`invocations > 0`을 반드시 확인**한다.

---

## 7. Tauri reuse boundary (컴포넌트별 coupling 분류)

"무수정 재사용"을 가정하지 않는다. 리서치 기반 1차 분류(Phase A 진행 중 정밀화):

### 7.1 재사용 후보 (renderer-neutral — 적극 검토)

| Tauri 영역                                       | module                 | coupling                          | 분류                                 |
| ------------------------------------------------ | ---------------------- | --------------------------------- | ------------------------------------ |
| command routing (`#[tauri::command]`)            | `ipc/command.rs`       | renderer-neutral (bytes in/out)   | **reuse** (후보)                     |
| state (`State<T>`, `Manager`)                    | `state.rs`             | `Arc<RwLock<TypeMap>>`            | **reuse** (후보)                     |
| events (`Emitter`/`Listener`) Rust-listener path | `event/mod.rs`         | neutral path 존재                 | **reuse** (JS-fanout path는 adapter) |
| resources                                        | resources table        | renderer-neutral                  | **reuse** (후보)                     |
| ACL / capabilities / permissions / scopes        | `tauri-utils/acl`      | pure data, dispatch 전 enforce    | **reuse** (후보)                     |
| updater / signature                              | `tauri-plugin-updater` | pure Rust(minisign), desktop-only | **reuse** (앱 바이너리 서명 한정)    |
| plugin command routing (`extend_api`)            | `plugin.rs`            | renderer-neutral                  | **reuse** (후보)                     |

### 7.2 WebView identity 누출 지점 (adapter 대상)

| Tauri 영역                                                                        | 왜 adapter/fork                          | 분류                                                     |
| --------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| webview lifecycle (`WebviewDispatch`)                                             | ~30 메서드, 4개만 의미 있고 나머지 no-op | **fork**(신규 `LynxWebviewDispatcher`) 또는 Phase B shim |
| page load / `navigate`                                                            | bundle load로 재정의                     | **adapter**                                              |
| navigation policy                                                                 | `.lynx.bundle` URL = identity            | **adapter**                                              |
| window/webview capability identity                                                | bundle-identity 모델로 재정의(§10)       | **adapter**                                              |
| plugin lifecycle hooks (`on_navigation`, `on_page_load`, `initialization_script`) | webview 전용 옵션                        | **adapter**(생략 또는 매핑)                              |
| event JS-fanout path (`eval_script`)                                              | BTS push(`__rustraDeliver`)로 교체       | **adapter**                                              |
| asset/HTML fetch (`tauri://`)                                                     | bundle resolver로 교체                   | **adapter**                                              |

### 7.3 분류 기준

`reuse`(그대로) > `adapter`(래핑/매핑) > `fork`(변형 복사) > `rewrite`(신규 구현).
각 컴포넌트는 Phase A 구현 중 실제 coupling을 다시 검증해 위 표를 확정한다.
**Rustra Core의 public 표면에는 Tauri 타입이 새어나오지 않는다.**

---

## 8. `@rustra/api` (Rustra-native) ⫫ `@rustra/tauri-compat`

```text
공식 API:  import { invoke, listen, Channel } from "@rustra/api";   ← Rustra 고유, Tauri 비종속

Tauri 호환 필요 시:
  Tauri API ──▶ @rustra/tauri-compat(adapter) ──▶ Rustra API/Core
```

- `@rustra/api`는 Tauri API 변화에 끌려다니지 않는다.
- 기존 `@rustra/tauri` 패키지는 `@rustra/tauri-compat` 방향으로 재정렬하거나, webview back-compat 경로(`WryHost`)로 둔다.
- `invoke/listen/once/Channel` 시그니처는 Rustra Protocol 기준으로 정의.

---

## 9. Security model (bundle-identity 중심, deny-by-default)

Tauri window/webview capability 모델을 복사하지 않는다. **Lynx bundle identity**를 보안 주체로 삼는다.

```text
Signed Lynx Bundle
        │
        ▼
Bundle Identity      ← "Who is calling?"
        │
        ▼
Capabilities         ← 허용 command/scope 선언
        │
        ▼
Permissions          ← "May it call?" (per-command allow/deny)
        │
        ▼
Scopes               ← "With which arguments?" (fs path, url 경계)
        │
        ▼
Command
```

- **Phase A:** 서명 전체를 구현하지 않아도 된다. 단, 인터페이스는 향후 확장을 수용하도록 설계.
  최소 capability manifest 1개(`calculator:add`)로 dispatch 전 deny-by-default 게이트 동작을 증명.
- **확장 인터페이스(향후):** signature(ed25519/minisign) · hash verification · capability manifest(embed) ·
  version · rollback protection · trusted bundle identity.
- 모두 `Runtime Authority` 뒤에 추가되며, Rustra Protocol은 불변이다.

---

## 10. Error model

기존 `RustraError { code, message, retryable? }` 확장. 모든 에러는 `InvokeError`/`ChannelError` 프레임으로 왕복.

- **신규 코드:** `authority.denied` · `authority.bundle_invalid` · `authority.bundle_expired`(rollback) ·
  `transport.disconnected` · `protocol.bad_frame` · `protocol.bad_magic` · `protocol.unsupported_version`.
- 기존 코드 유지: `command.not_found` · `command.invalid_args` · `internal` · `transport.*` · custom.
- TS: `RustraCommandError`(`code`, `message`, `retryable`)로 모든 경로 통일.

---

## 11. Lifecycle (macOS Phase A)

```text
host main:
  base::UIThread::Init(main)                          // FML pump 바인딩(headless 레시피)
  lynx_env_new
  lynx_env_register_extension_module("RustraModule", creator, eager=false... 실제값 검증)
  NSWindow 생성 → content view 아래 Lynx surface child mount
  RendererHost.create_surface() → load(.lynx.bundle)
  lynx_view_enter_foreground                          // 첫 present에서 콘텐츠
  message loop: RunExpiredTasksNow 매 틱              // FML pump
  runtime_ready(BTS): NativeModules 주입 + __rustraDeliver 바인딩
  ... invoke/event 왕복 ...
  background → destroy → extension module unref
```

headless host 레시피(FML pump · RGBA present · `.app` bundle 필수)가 그대로 적용된다.

---

## 12. Phase A 범위 (macOS only, 최소 실증)

**목적:** "Tauri Runtime 구현 성공"이 아니라
**"Lynx + Rust + renderer-neutral Rustra application core가 native desktop app으로 end-to-end 동작함을 증명."**

Tauri `Runtime`/`WebviewDispatch` trait을 만족시키기 위한 억지 WebView shim이 필요해지면 **Phase A에서는 하지 않는다.**

### 구현 순서

1. **registration 왕복** — `NativeModules.RustraModule` → real Rust invocation. `invocations > 0` 확인.
2. **event push** — Rust → BTS runtime task(`post_task_to_runtime`) → `__rustraDeliver` → ReactLynx event.
3. **native window/surface** — macOS NSWindow + Lynx surface child mount + 렌더링.
4. **protocol/authority/RendererHost 정리** — 위 실증 결과를 §4/§5/§9 abstraction에 반영.

### 필수 성공 조건 (전부 충족 시 Phase A 통과)

1. macOS native window 생성
2. Lynx surface가 실제 window 안에 표시
3. `NativeModules.RustraModule` 실제 등록
4. ReactLynx → Rust invoke 성공
5. Rust → ReactLynx event push 성공
6. typed error 왕복
7. 최소 channel/stream 검증
8. capability 없는 command deny
9. `RendererHost` trait을 통해 Lynx host 동작
10. mock/fallback 없이 end-to-end 성공

예제 규모: `addNumbers(a, b)` + 주기적 `tick` event 수준으로 작게 유지.

---

## 13. macOS implementation (Phase A 상세)

host.cpp(`/tmp/rustra-lynx-host/host.cpp`)를 프로젝트 내 `examples/lynx-calculator/host/`로 승격 후 windowed host로 진화:

1. **registration gap 폐쇄(§6)** — extension-module 경로 + `runtime_ready`에서 명시 주입. JS fallback 제거.
2. **windowed surface** — `NSWindow` + content view 아래 Lynx surface(NSView/Metal). headless의 `OnSoftwarePresent`/pump를 NSWindow 런루프와 통합.
3. **IPC 완전 경로** — invoke(기존 rkyv) + event push(`post_task_to_runtime` + `__rustraDeliver`).
4. **최소 Authority** — capability manifest 1개, dispatch 전 체크, deny-by-default.
5. **빌드** — `clang++ -std=c++17 -DUSE_WEAK_SUFFIX_NAPI ... -lLynx <rust_staticlib.a>`(headless 레시피). `.app` bundle 구조 필수.

성공: calculator UI가 NSWindow에 표시 + `addNumbers` 진짜 Rust 호출 + Rust→Lynx `tick` event + capability 없는 호출 거부.

---

## 14. 플랫폼 follow-up

- **Windows:** libLynx Windows SDK 가용성이 선행(현재 macOS만 검증). `WinRendererHost`(HWND → child surface) +
  Windows message loop pump. 우선순위: macOS ▸ mobile ▸ Windows(Lynx Windows 지원 상태 의존).
- **iOS:** `UIViewController` root view를 Lynx surface로 swap. Obj-C `RustraModule`(기존 템플릿) + extension-module 등록.
- **Android:** Activity content view → Lynx surface, Kotlin `RustraModule` + JNI(기존 템플릿). `cargo-ndk`.
- 모바일은 desktop Phase A + 종착지 결정 이후. Tauri mobile plugin 구조는 renderer-neutral이므로 adapter 교체로 재사용 가능(§7).

---

## 15. Testing strategy

| 레이어              | 테스트                                                                              |
| ------------------- | ----------------------------------------------------------------------------------- |
| Rust framing/codec  | `FrameHeader` encode/decode, `FrameKind` round-trip, codec(rkyv/postcard/JSON)별    |
| Authority 단위      | deny-by-default, capability 매핑, (확장) 서명/해시 검증                             |
| `RendererHost` 모킹 | trait 모킹으로 invoke/event/pump 검증(실제 Lynx 없이)                               |
| Bridge TS 단위      | 모킹 native로 invoke/listen/channel/error 왕복                                      |
| macOS E2E           | NSWindow + libLynx + 진짜 Rust 호출(`invocations>0`), event push, typed error, deny |
| 보안                | capability 없는 호출 거부, (확장) 서명 변조 시 `authority.bundle_invalid`           |

---

## 16. Phase A 이후 결정 (3후보 비교)

Phase A 실증 결과로 아래 3안을 비교한다. **이 문서 시점에서는 미확정.**

| 후보                                      | 설명                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **A. `tauri-runtime-lynx`**               | Tauri `Runtime`/`WebviewDispatch` compat를 shim해 runtime peer화. WebView-shaped contract라 shim 비용 발생 |
| **B. 독립 `rustra-runtime-lynx`**         | Tauri runtime contract와 분리된 독립 runtime                                                               |
| **C. Rustra Core + Tauri compat adapter** | renderer-neutral Rustra Core 유지 + Tauri app ecosystem을 adapter/reuse. **(현 시점 유력 후보)**           |

비교 기준: Tauri/Wry churn · Tauri plugin 재사용률 · Lynx semantics 왜곡 · 코드량 · maintenance cost ·
Android/iOS 확장성 · Windows 확장성 · performance · security · developer experience.

Phase A의 `RendererHost`/`Rustra Protocol`/`Runtime Authority` 추상은 세 안 모두에 재사용되므로,
어떤 안을 택해도 Phase A 투자가 살아있다.

---

## 참고(리서치 출처)

- Tauri: `tauri 2.11.1`, `tauri-runtime 2.11.1`, `wry 0.55.1`, `tao 0.35.2`. License `Apache-2.0 OR MIT`(`tao`는 Apache-2.0).
  `Runtime` trait: `tauri-runtime-2.11.1/src/lib.rs:402-516`. `WebviewDispatch`: `:519-646`.
  `Window`(webview 없음) 증명: `tauri-2.11.1/src/window/mod.rs:352-454`. raw handle: `ns_window()`/`ns_view()`/`hwnd()`.
- Lynx SDK: `/tmp/lynx-prebuilt/macsdk/include/capi/`. extension-module: `lynx_extension_module_capi.h:105`(`runtime_ready`가 global 제공).
  registration: `lynx_env_register_extension_module`(lynx_env_capi.h:39-41). push: `lynx_extension_module_post_task_to_runtime`(:132).
- rustra 현황: `crates/rustra/src/lib.rs` — `tauri_support`(`:122-156`, request/response only), `invoke_rkyv_v2`(`:401-432`).
  **emit/listen/channel 없음(신규 추가)**. rkyv wire: `[cmd_id u16][postcard In] → [ok u8][pad][postcard Out]`.
  FFI: `rustra_calculator_invoke_rkyv_v2`(examples/calculator/src/lib.rs:972-992), `rustra_ffi_*`(crates/rustra/src/ffi.rs).

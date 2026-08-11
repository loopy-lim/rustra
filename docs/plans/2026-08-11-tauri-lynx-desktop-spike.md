# Tauri × Lynx Desktop Spike Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** macOS에서 Tauri desktop window 안에 Lynx(ReactLynx) surface가 구동되고 rustra rkyv 명령이 왕복하는지 증명한다 (1차 성공 기준: design `2026-08-11-tauri-lynx-desktop-design.md` §5).

**Architecture:** Lynx desktop C++ API의 형태(NSView 제공 vs windowless RGBA)가 미확정이므로, Phase 0에서 가이드/헤더로 형태를 확인해 **경로 A(안정 C++ API)** 와 **경로 B(현 `host.cpp` windowless RGBA blit)** 중 하나를 선택한다. 이후 `examples/lynx-tauri-spike/` Tauri crate에서 rustra staticlib + Lynx desktop engine을 링크하고, Tauri window의 raw-window-handle에 Lynx surface를 올린다. rustra rkyv 왕복은 현 `host.cpp`의 N-API `RustraModule.invokeRkyvV2` + extension-module BTS 주입 패턴을 그대로 재사용한다.

**Tech Stack:** Rust + Tauri 2(`raw-window-handle`), C++/Objective-C++(Lynx desktop engine + NSView), N-API(Lynx NativeModule), ReactLynx + rspeedy(프론트), rustra rkyv V2 FFI(staticlib). macOS arm64 우선(로컬 Lynx SDK 4.0.1 `/tmp/lynx-prebuilt/macsdk`).

**참조 자산(재사용):**

- `examples/lynx-calculator/host/host.cpp` — windowless renderer + FML 펌프 + RustraModule N-API + extension-module BTS 주입 + vsync 이벤트.
- `examples/lynx-calculator/host/host_ui.mm` — NSWindow/CALayer RGBA blit.
- `examples/lynx-calculator/host/build.sh` — Lynx SDK 링크 빌드.
- `examples/tauri-calculator/src-tauri/` — Tauri crate 구조.
- `crates/rustra/src/lib.rs:131`(`tauri_support`) — 단, 본 스파이크는 JSON IPC가 아닌 rkyv 직접 FFI 경로를 쓴다.
- `examples/lynx-calculator/src/App.tsx` — ReactLynx + `@rustra/lynx` 엔진 설정(스파이크용으로 단순화).

---

## ⚠️ 스파이크 성격 (executing-plans 시 유의)

본 plan은 **탐색적 스파이크**다. Phase 0 결과(Lynx desktop API 형태)에 따라 Phase 2의 코드가 A/B로 갈린다. 그래서:

- Phase 0은 반드시 먼저 실행하고 결론을 Task 0.4에 기록한다.
- Phase 2는 Task 0.4 결론에 따라 **A 경로 또는 B 경로 중 하나만** 실행한다.
- 각 Task 끝의 "검증"이 곧 성공 기준 체크다. 전통적 단위 테스트보다 실행-후-상태-확인 스크립트가 주 검증 수단이다(Lynx 렌더링은 비주얼/RGBA).

---

## Phase 0 — Lynx desktop C++ API 조사 (경로 결정)

### Task 0.1: Lynx SDK desktop 헤더/가이드 형태 확인

**Files:**

- Read: `/tmp/lynx-prebuilt/macsdk/include/capi/*.h` (목록)
- Read: `/tmp/lynx-prebuilt/macsdk/include/` 최상위(LynxView 등 네이티브 뷰 헤더 존재 여부)
- Web: `https://lynxjs.org/guide/start/integrate-with-existing-apps.html` (macOS/desktop 섹션)

**Step 1: desktop API 형태 조사**

```sh
ls /tmp/lynx-prebuilt/macsdk/include/ 2>/dev/null
ls /tmp/lynx-prebuilt/macsdk/include/capi/ 2>/dev/null | head -40
```

확인 항목:

- (a) `LynxView`/`LynxViewPlatform` 같은 **네이티브 NSView 제공** 헤더가 있는가? → 경로 A 후보.
- (b) `lynx_windowless_renderer_*.h` 만 있는가? → 경로 B 확정(host.cpp 방식).
- (c) Lynx 3.7 "render inside desktop apps" C++ API의 진입점 심볼.

**Step 2: 공식 가이드 desktop 섹션 확인**

fetcher로 `integrate-with-existing-apps.html` 의 macOS/Windows 탭 확인 (iOS는 이미 확인: `LynxView`가 `UIView` 서브클래스 → contentView 추가 패턴). desktop도 동일 "네이티브 뷰 추가" 패턴인지, 아니면 windowless인지.

### Task 0.2: Tauri 2 raw-window-handle + 네이티브 뷰 임베딩 가능성 확인

**Web:** Tauri 2 `Window::with_webview` / `raw-window-handle` / iOS/Android를 제외한 desktop에서 **NSView content에 네이티브 서브뷰를 추가**하거나 **custom rendering**으로 전환하는 공식 패턴을 확인. `tauri::WindowEvent`/메인 루프 점유 여부(Lynx FML 펌프와의 공존).

### Task 0.3: 경로 A/B 빌드 가능성 스모크 (각각 1회 빌드 시도)

**Step 1: 경로 B(현 host.cpp 자산)가 여전히 빌드되는지 확인** — 기반 신호.

```sh
cd examples/lynx-calculator
cargo build --release -p rustra-calculator-example
RUSTRA_WINDOW=1 ./host/build.sh   # HostApp.app 빌드
```

예상: 빌드 성공 (Phase A에서 이미 검증). 실패 시 로컬 SDK 상태 재확인.

**Step 2: 경로 A 후보 심볼이 SDK에 있는지**

Task 0.1에서 찾은 NSView/desktop 뷰 진입점 심볼을 `nm`/헤더로 확인.

### Task 0.4: 경로 결정 기록

**File:** `docs/plans/2026-08-11-tauri-lynx-desktop-spike-result.md` (새 파일)

기록 내용:

- 채택 경로: **A** 또는 **B** (또는 둘 다 불가 → design §5 fallback "별도 자식 윈도우")
- 근거: Task 0.1~0.3 증거
- Phase 2에서 실행할 Task(2.A 또는 2.B) 명시
- host.cpp에서 재사용할 블록 / 폐기할 블록 명시

**Step: 커밋**

```sh
git add docs/plans/2026-08-11-tauri-lynx-desktop-spike-result.md
git commit -m "docs(spike): Phase 0 Lynx desktop API 조사 + 경로 A/B 결정"
```

---

## Phase 1 — 스파이크 스캐폴드 (경로 무관 공통)

### Task 1.1: ReactLynx 프론트 (단순화)

**Files:**

- Create: `examples/lynx-tauri-spike/package.json` (`@lynx-js/react`, `@lynx-js/rspeedy`, `@rustra/lynx`, `@rustra/types`, `@rustra/calculator` → `examples/calculator` generated 참조)
- Create: `examples/lynx-tauri-spike/lynx.config.ts` (`examples/lynx-calculator/lynx.config.ts` 복사)
- Create: `examples/lynx-tauri-spike/src/index.tsx` (엔트리)
- Create: `examples/lynx-tauri-spike/src/App.tsx` — `addNumbers({a:20,b:22})` 호출 + 결과 표시 + `ackResult` 왕복만 남긴 단순 버전 (`examples/lynx-calculator/src/App.tsx`에서 tick/divide/secureCompute 제거)
- Create: `examples/lynx-tauri-spike/src/typing.d.ts` (`NativeModules.RustraModule` 타입)

**Step 1: App.tsx 단순화**

```tsx
import { useEffect, useState } from '@lynx-js/react';
import { addNumbers } from '../../calculator/generated/commands.js';
import { createFastEngine, configure, getRustraNative } from '@rustra/lynx';
import { rkyvV2Registry } from '../../calculator/generated/rkyv-registry.js';

try {
  configure(createFastEngine(getRustraNative(), { rkyvV2Codecs: rkyvV2Registry }));
} catch {}

export function App() {
  const [result, setResult] = useState<number | null>(null);
  useEffect(() => {
    addNumbers({ a: 20, b: 22 })
      .then((out) => {
        setResult(out.value);
        (getRustraNative() as any).ackResult?.(out.value);
      })
      .catch(() => setResult(-1));
  }, []);
  return <text>result: {result ?? '…'}</text>;
}
```

**Step 2: 빌드**

```sh
cd examples/lynx-tauri-spike && npm install && npm run build
```

예상: `dist/index.lynx.bundle` 생성.

**Step 3: 커밋**

```sh
git add examples/lynx-tauri-spike
git commit -m "feat(spike): ReactLynx 프론트 단순화 (addNumbers rkyv)"
```

### Task 1.2: Tauri crate 스캐폴드

**Files:**

- Create: `examples/lynx-tauri-spike/src-tauri/Cargo.toml`
- Create: `examples/lynx-tauri-spike/src-tauri/tauri.conf.json`
- Create: `examples/lynx-tauri-spike/src-tauri/build.rs`
- Create: `examples/lynx-tauri-spike/src-tauri/src/main.rs`
- Modify: `Cargo.toml` (workspace `members` 에 `examples/lynx-tauri-spike/src-tauri` 추가)

**Step 1: Cargo.toml** — rustra staticlib + Tauri 2 + Lynx SDK 링크는 build.rs가 아닌 C++ 호스트 쪽에서(`build.sh` 패턴). 우선 Rust는 Tauri 셸 + rustra 패키지만.

```toml
[package]
name = "rustra-lynx-tauri-spike"
edition = "2021"
version = "0.1.0"
publish = false

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
rustra-calculator-example = { path = "../../calculator" }
tauri = { version = "2", features = [] }
raw-window-handle = "0.6"
```

**Step 2: tauri.conf.json** — `examples/tauri-calculator/src-tauri/tauri.conf.json` 복사 후 title/identifier만 교체. `withGlobalTauri`는 불필요(Lynx가 UI). window 크기 390×844(lynx-calculator host와 동일).

**Step 3: main.rs** — window 생성 + raw-window-handle 획득까지(Phase 2에서 Lynx 연결).

```rust
// Phase 1: window 생성 + RWH 획득 로그. Lynx 결합은 Phase 2.
fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            let handle = window.window_handle().unwrap();
            println!("[spike] window raw-handle: {:?}", handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri app");
}
```

**Step 4: 빌드**

```sh
cargo build -p rustra-lynx-tauri-spike
```

예상: Tauri window 바이너리 빌드. (아직 Lynx 미연결)

**Step 5: 커밋**

```sh
git add examples/lynx-tauri-spike/src-tauri Cargo.toml
git commit -m "feat(spike): Tauri desktop crate 스캐폴드 + raw-window-handle"
```

---

## Phase 2 — Lynx surface 통합 (Task 0.4 결론에 따라 A 또는 B 하나만)

> executing-plans 시: Task 0.4 가 A면 **Task 2.A** 실행, B면 **Task 2.B** 실행. 둘 다 불가 판정이면 design §5 fallback으로 plan 정정 후 중단.

### Task 2.A (경로 A — Lynx desktop C++ API NSView 삽입)

**Files:**

- Create: `examples/lynx-tauri-spike/src-tauri/src/lynx_desktop.mm` (Objective-C++: Lynx NSView 생성)
- Modify: `examples/lynx-tauri-spike/src-tauri/src/main.rs` (RWH → NSView 획득 → Lynx NSView 서브뷰 추가)
- Create: `examples/lynx-tauri-spike/build-lynx-host.sh` (`host/build.sh` 기반, Tauri 바이너리에 Lynx SDK 정적/동적 링크)

**Step 1: Lynx desktop API로 NSView 생성** — Task 0.1에서 확인한 진입점 사용. iOS `LynxView`(UIView 서브클래스)의 desktop 대응이 NSView 서브클래스라 가정.

```objc
// lynx_desktop.mm (의사코드 — 실제 심볼은 Task 0.1 결과로 채움)
// LynxEnv init + LynxView(NSView) 생성 + bundle 로드 + contentView 에 addSubview
extern "C" void* rustra_spike_create_lynx_view(void* parent_nsview, const char* bundle_path) {
    // LynxEnv 초기화, LynxView 생성, [parent addSubview:lynxView], loadTemplate
    // ... Task 0.1에서 확정한 Lynx desktop C++/ObjC API
}
```

**Step 2: main.rs에서 Tauri NSView에 삽입**

```rust
mod lynx_desktop; // extern "C" fn
// setup 안에서:
//   nsview = raw_window_handle(NSView) 획득
//   lynx_desktop::rustra_spike_create_lynx_view(nsview, bundle_path)
//   FML 펌프를 Tauri 메인 루프에 통합 (RunEvent::Ready 시 펌프, 또는 별도 스레드)
```

**Step 3: 빌드 + 실행**

```sh
./examples/lynx-tauri-spike/build-lynx-host.sh && cargo run -p rustra-lynx-tauri-spike
```

**Step 4: 검증(성공 기준 1,2)** — window 오픈 + ReactLynx 뷰 렌더링(비검정 RGBA). 스크린샷 또는 `RUSTRA_LAYER_PNG` 덤프.

### Task 2.B (경로 B fallback — windowless RGBA blit into Tauri window)

**Files:**

- Create: `examples/lynx-tauri-spike/src-tauri/src/lynx_host.cpp` (`examples/lynx-calculator/host/host.cpp` 발췌: windowless renderer + FML 펌프 + present 콜백)
- Create: `examples/lynx-tauri-spike/src-tauri/src/lynx_blit.mm` (`host_ui.mm`의 CALayer blit를 **Tauri window의 NSView content**로 재타겟)
- Modify: `main.rs` (windowless renderer present 콜백 → Tauri NSView CALayer blit)
- Create: `build-lynx-host.sh` (`host/build.sh` 기반)

**Step 1: host.cpp에서 windowless renderer 블록 이식** — `LynxMain()`의 env init + windowless renderer + view build + pump loop를 Tauri `setup`/메인 루프로 옮김. 단 `rustra_ui_init`(자체 NSWindow 생성) 대신 Tauri NSView를 blit 타깃으로.

**Step 2: Tauri NSView CALayer blit** — `host_ui.mm`의 `rustra_ui_blit`을 Tauri window의 `contentView.layer`를 향하도록 변경. RWH로 NSView 획득.

**Step 3: FML 펌프를 Tauri 루프에 공통** — Tauri `RunEvent` 기반 펌프(또는 백그라운드 스레드에서 `pump_fml_message_loop()` 주기 호출). host.cpp의 `resolve_liblynx_symbols()`(Mach-O 오프셋) 재사용 — ABI 부채 인정(결과 보고에 명시).

**Step 4: 빌드 + 실행 + 검증** — Task 2.A Step 3-4와 동일.

**Step 5: 커밋** (A/B 공통)

```sh
git add examples/lynx-tauri-spike/src-tauri
git commit -m "feat(spike): Lynx surface → Tauri window 통합 (경로 X)"
```

---

## Phase 3 — rustra rkyv 왕복 (성공 기준 3)

### Task 3.1: RustraModule N-API + extension-module BTS 주입 (host.cpp 재사용)

**Files:**

- Modify: `lynx_host.cpp`/`lynx_desktop.mm` (경로에 따라)
- 재사용 블록: `host.cpp` 의 `InvokeRkyvV2`, `RustraModuleCreator`, `InstallRustraNative`, `OnExtRuntimeAttach/Ready`, `RustraExtCreator`, `lynx_env_register_native_module`/`register_extension_module`

**Step 1: invokeRkyvV2 → rustra_calculator_invoke_rkyv_v2 staticlib FFI 연결** — `extern "C"` FFI 선언 + `register_native_module("RustraModule", ...)`. host.cpp 블록을 사본으로 가져와 Tauri 호스트에 링크.

**Step 2: rustra staticlib 링크 확인**

```sh
cargo build --release -p rustra-calculator-example   # librustra_calculator_example.a
./build-lynx-host.sh                                  # host 가 .a 링크
```

**Step 3: 검증(성공 기준 3)** — 실행 후 stderr `[rustra] invokeRkyvV2: in=.. out=.. ok=1` + `ackResult(42)` 왕복 확인. host.cpp의 ack 카운터 패턴 재사용.

### Task 3.2: FML 펌프 + vsync 를 Tauri 루프에 통합 (이벤트 푸시 검증, optional)

> 성공 기준 3(addNumbers 왕복)에 필수는 아님. 시간 허용 시 tick 왕복까지.

**Step:** host.cpp의 vsync ticker(`VsyncTickCb` + `lynx_vsync_observer_request_animation_frame`)를 Tauri 루프에서 구동. `subscribeTick` → ack 왕복 확인.

**Step: 커밋**

```sh
git add examples/lynx-tauri-spike/src-tauri
git commit -m "feat(spike): rustra rkyv 왕복 (RustraModule N-API + ack)"
```

---

## Phase 4 — 검증 + 결과 보고

### Task 4.1: 성공 기준 체크 스크립트

**File:** Create `examples/lynx-tauri-spike/verify.sh`

**Step 1: 스크립트**

```sh
#!/usr/bin/env bash
set -euo pipefail
# 1) window 오픈 + 2) RGBA 캡처 비검정 + 3) rustra 결과=42 ack
cargo run -p rustra-lynx-tauri-spike 2>&1 | tee /tmp/spike.log
grep -q "ok=1" /tmp/spike.log              # 성공 기준 3 (rkyv ok)
# 성공 기준 1,2: window 가 떠 있고 RGBA 가 비검정 — RUSTRA_LAYER_PNG 덤프로 확인
test -f /tmp/spike-layer.png
echo "[spike] PASS: 성공 기준 1/2/3 충족"
```

**Step 2: 실행 + PASS 확인**

```sh
RUSTRA_LAYER_PNG=/tmp/spike-layer.png ./examples/lynx-tauri-spike/verify.sh
```

### Task 4.2: 결과 보고 + design 반영

**Files:**

- Create: `docs/plans/2026-08-11-tauri-lynx-desktop-spike-result.md` (Task 0.4에서 시작했으면 갱신)
- Modify: `docs/plans/2026-08-11-tauri-lynx-desktop-design.md` (§6 미해결 리스크 1,2 해소 여부 반영)

**기록 내용:**

- 채택 경로(A/B) + 성공 기준 1-4 각각 PASS/FAIL
- host.cpp 재사용/폐기 블록 최종 정리
- 남은 리스크: Windows 바이너리 입수, ABI 부채(경로 B 채택 시), 모바일 확장
- Phase 2(Android)로 가기 위한 전제 조건

**Step: 커밋**

```sh
git add docs/plans/2026-08-11-tauri-lynx-desktop-spike-result.md docs/plans/2026-08-11-tauri-lynx-desktop-design.md
git commit -m "docs(spike): 데스크톱 스파이크 결과 보고 + design 반영"
```

---

## 완료 조건 (1차 성공 기준 — design §5)

- [ ] 성공 기준 1: Tauri desktop window 오픈
- [ ] 성공 기준 2: window에 ReactLynx 뷰 렌더링 (RGBA 비검정)
- [ ] 성공 기준 3: ReactLynx → addNumbers → rkyv → 결과 42 ack 왕복
- [ ] 성공 기준 4: 경로 A 또는 B 확정 + 결과 보고서 작성

통과 시 design §7 Phase 2(Android) impl plan으로 진행. 실패 시 design §5 fallback(별도 자식 윈도우)으로 정정.

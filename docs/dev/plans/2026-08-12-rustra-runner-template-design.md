# rustra runner 템플릿 설계 (Phase 5)

- **상태:** Design. design §4(3계층 + capability 추상)·§5(재사용 runner) 의 구체화.
- **날짜:** 2026-08-12
- **근거 스파이크:** 데스크톱(`2026-08-11-tauri-lynx-desktop-spike-result.md`, macOS 7/7),
  모바일(`2026-08-11-lynx-mobile-spike-result.md`, iOS+Android 7/7), Windows(`2026-08-12-lynx-windows-phase4.md`).
- **목표:** "실제 다른 프로젝트" 에 복사-수정-빌드할 수 있는 4플랫폼 runner 템플릿.

---

## 1. 검증된 사실 (템플릿의 기반)

스파이크 3종(macOS/iOS/Android 런타임 7/7, Windows 입수·분석) 이 증명한 것:

1. **단일 ReactLynx 번들**이 4플랫폼 셸에서 로드된다(`loadTemplate`/`renderTemplateUrl`/`SetParent`).
2. **단일 Rust rkyv V2 백엔드**가 4플랫폼에서 동일 와이어 포맷(9/52/95 바이트)으로 동작한다.
3. **NativeModule 패턴**만 플랫폼별: Obj-C `RustraModule<LynxModule>` / Kotlin `com.lynx.jsbridge.LynxModule` /
   C++ N-API(desktop host). 모두 동일 `invokeRkyvV2(ByteArray)` 인터페이스.
4. **Rust 패키지 등록**은 Apple 만 자동(`__mod_init_func`); Windows(PE)/Android(ELF) 는 명시 init 필수.
5. **capability(authority)**: rustra 의 `require_capability` + deny-by-default 가 rkyv 경로로 플랫폼 중립 동작(`capability.denied`).

→ 템플릿은 **"공유: ReactLynx app + Rust backend + rkyv wire / 플랫폼별: NativeModule 셸 + init + 빌드"**
구조로 확정한다.

## 2. 디렉토리 레이아웃

```
runner/template/
├── README.md                     # instantiation 가이드 (create-runner.sh)
├── create-runner.sh              # 템플릿 복사 + 식별자 치환 스크립트
├── app/                          # ▶ 공유: 단일 ReactLynx UI (1벌)
│   ├── src/App.tsx               #   rustra client 로 command 호출
│   ├── lynx.config.ts            #   rspeedy 설정
│   └── package.json
├── backend/                      # ▶ 공유: 단일 Rust rustra 백엔드 (crate)
│   ├── src/lib.rs                #   #[command] 들 + calculator_package()
│   ├── src/capabilities.rs       #   capability trait 세트 + registry (★신규)
│   └── Cargo.toml
├── desktop/                      # ▶ 플랫폼: Tauri 셸 (macOS now / Windows scaffold)
│   ├── src-tauri/src/main.rs     #   SetParent(NSView|HWND) + FML pump
│   ├── src-tauri/src/lynx_host.{mm,cpp}  #   env init + RustraModule N-API + bundle load
│   └── src-tauri/Cargo.toml
├── mobile-android/               # ▶ 플랫폼: Android 셸 (Lynx SDK 4.0.1)
│   ├── app/                      #   Activity + RustraApplication(LynxEnv init) + module
│   └── modules/rustra-lynx/      #   RustraModule.kt + JNI(JNI_OnLoad init) + build-rust-android.sh
├── mobile-ios/                   # ▶ 플랫폼: iOS 셸 (CocoaPods)
│   ├── app/                      #   AppDelegate + ViewController + provider
│   └── modules/rustra-lynx/      #   RustraModule.m + build-rust-ios.sh
└── capabilities/                 # ▶ 확장 패턴 문서 + 예제 trait 구현체
    └── README.md
```

각 플랫폼 디렉토리는 대응 스파이크(`examples/lynx-tauri-spike`, `examples/lynx-calculator/{ios,android,modules/rustra-lynx}`)
의 검증된 코드를 정제·추출한 것이다. 스파이크가 "증명" 이라면 템플릿은 "시작점" 이다.

## 3. capability 모델 — 2계층 (★ 핵심 설계)

design §4 의 "capability 추상" 을 2계층으로 분해한다. 둘은 해결하는 문제가 다르다.

### 계층 A — Rust-side authority (이미 증명됨, rustra 자체)

rustra 의 `require_capability("cmd", "scope")` + deny-by-default authority. Rust command 가
권한을 요구할 때 rkyv 경로로 `capability.denied`(out=95) 를 반환한다. **플랫폼 중립, 추가 구현 불필요.**
`secureCompute` 가 이 계층의 예. 템플릿은 이것을 그대로 쓴다.

### 계층 B — Platform-native capability trait (★신규, 템플릿이 정의)

플랫폼 디바이스 API(file/notify/camera)는 Rust 가 직접 못 한다(모바일 샌드박스·권한). 따라서
Rust command 가 **trait 메서드**로 추상하고, 구현체를 플랫폼이 주입한다.

```rust
// backend/src/capabilities.rs
pub trait FileCap: Send + Sync { fn read_file(&self, p: &str) -> Result<Vec<u8>, String>; }
pub trait NotifyCap: Send + Sync { fn notify(&self, title: &str, body: &str) -> Result<(), String>; }

/// 플랫폼이 startup 에 주입하는 capability registry. command 핸들러는 이것으로만 디바이스에 접근.
pub trait CapabilityRegistry: Send + Sync {
    fn file(&self) -> Option<&dyn FileCap> { None }
    fn notify(&self) -> Option<&dyn NotifyCap> { None }
}

static REGISTRY: std::sync::OnceLock<Box<dyn CapabilityRegistry>> = std::sync::OnceLock::new();
pub fn set_registry(r: Box<dyn CapabilityRegistry>) { let _ = REGISTRY.set(r); }
pub fn registry() -> Option<&'static dyn CapabilityRegistry> { REGISTRY.get().map(|b| &**b) }

// command 예 — trait 만 호출, 구현체 모름
#[command]
fn load_config() -> Result<String, String> {
    let cap = registry().and_then(|r| r.file()).ok_or("file capability not provided")?;
    let bytes = cap.read_file("config.json")?;
    Ok(String::from_utf8(bytes)?)
}
```

**플랫폼별 구현체 주입:**

- **Desktop (Tauri):** `DesktopRegistry` 가 `std::fs` (또는 Tauri fs plugin) 으로 `FileCap` 구현.
  Tauri `setup` 단계에서 `rustra_set_registry(Box::new(DesktopRegistry))` 호출. 순수 Rust → 별도 FFI 없음.
- **Mobile (iOS/Android):** `MobileRegistry` 는 Rust → 플랫폼 콜백 브리지로 구현.
  NativeModule 이 startup 에 `rustra_register_file_callback(fn(ptr, len))` 형태의 FFI 콜백을 등록하면,
  `MobileRegistry::read_file` 이 그 콜백을 호출해 Java/Obj-C 파일 API 로 위임. (Android `Context.openFileInput`,
  iOS `NSFileManager`). 이 브리지는 capability 확장 패턴 문서(`capabilities/README.md`)에 명시.

→ 새 capability 추가 = (1) trait 메서드 + Registry 게터, (2) Desktop 구현체, (3) (디바이스면) Mobile 브리지.
ReactLynx 는 코드 그대로(command 만 호출). design §4 "새 capability 추가 = trait 메서드 + 플랫폼 구현체" 구현.

## 4. instantiation 흐름

```sh
./runner/template/create-runner.sh my-app com.example.myapp
# → ../my-app/ 생성: 식별자 치환(my-app, com.example.myapp, My App),
#    backend crate 명 치환, generated/ 클리어(빈 command 로 시작).
cd ../my-app
# 1. Rust command 작성 (backend/src/lib.rs #[command])
# 2. ReactLynx UI 작성 (app/src/App.tsx)
# 3. 빌드:
npm --prefix app run build           # ReactLynx 번들
cargo build -p my-app-backend        # Rust 백엔드 (각 플랫폼 타깃)
# 4. 플랫폼 실행:
./desktop/run.sh                     # macOS: verify.sh 패턴 (SetParent + rkyv 왕복)
./mobile-ios/run.sh                  # iOS 시뮬: verify-ios.sh 패턴
./mobile-android/run.sh              # Android 에뮬: verify-android.sh 패턴
```

`create-runner.sh` 는 (a) 템플릿 복사, (b) `rustra-calculator-example`→`<app>-backend` 등 식별자 치환,
(c) 스파이크 전용 검증 로그(ackResult 등) 제거, (d) generated/ 재생성 유도.

## 5. 템플릿이 제거/정제하는 스파이크 특수물

스파이크는 증명용이므로 템플릿에 넣지 않을 것들:

- `ackResult` / SUMMARY 카운터 — 데스크톱 스파이크 검증 훅. 템플릿의 RustraModule 은 `invokeRkyvV2` 만.
- FML Mach-O 오프셋 하드코딩(0x3ecc 등) — 템플릿엔 `// TODO: FML pump (플랫폼별)` 로 명시 + 가이드.
- spike 전용 로깅(hex dump 등) — 축소.
- `examples/calculator` 의 12개 command — 템플릿은 1개 샘플 command(`greet`)만.

## 6. 검증 게이트 (템플릿 자체의 신뢰성)

템플릿이 "시작점" 이려면 스스로 빌드·런되어야 한다. 각 플랫폼 `run.sh` 는 대응 verify 스크립트 패턴을
재사용: (1) bundle, (2) rust staticlib, (3) 플랫폼 빌드, (4) 런, (5) rkyv 왕복 grep 게이트.
macOS/iOS/Android 는 본 머신에서, Windows 는 Windows 머신에서.

## 7. 범위 (본 Phase 5 산출물)

- `runner/template/` 스캐폴드 (README, create-runner.sh, 각 플랫폼 디렉토리 구조 + 핵심 파일).
- `backend/src/capabilities.rs` (capability trait + registry — ★신규 구현).
- 샘플 `greet` command + 샘플 ReactLynx App.
- Desktop `DesktopRegistry` (std::fs FileCap) 구현체.
- 플랫폼 `run.sh` 게이트 (스파이크 verify 패턴 재사용).
- 각 플랫폼 코드는 대응 스파이크에서 정제 추출 (전체 복사 아닌 핵심 파일 + 포인터).

**Phase 5 는 "구조 + capability 추상 + instantiation + 게이트" 까지.** 각 플랫폼 빌드의 완전한
재검증(스파이크 수준)은 템플릿 사용자가 `run.sh` 로 수행한다. 템플릿의 Rust 백엔드는 `cargo check` 로,
ReactLynx app 은 `npm run build` 로, capability trait 는 단위 테스트로 본 머신 검증한다.

> **갱신(2026-08-14):** §2의 플랫폼 셸 코드(desktop/src-tauri, mobile-{ios,android} 셸)와
> codegen 실경로화, Mobile capability 브리지(`MobileBridge` FFI), NDK 핀(P6) 이
> 후속 계획 `2026-08-14-gap-closure-production-ready-design.md` 로 완성되었다.
> 템플릿은 이제 셸 코드 포함 완전체 — 각 `run.sh` 게이트가 별도 스파이크 없이 동작한다.

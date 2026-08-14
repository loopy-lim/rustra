# rustra runner 템플릿

4플랫폼(macOS desktop / Windows desktop / iOS / Android) **단일 ReactLynx 번들 + 단일 Rust rkyv 백엔드**
앱의 시작점. 스파이크 3종(macOS 7/7 · iOS 7/7 · Android 7/7) 이 증명한 구조를
**플랫폼 셸 코드 포함** 복사-수정-빌드 가능한 템플릿으로 정제했다.

> 검증 근거: `docs/plans/2026-08-11-tauri-lynx-desktop-design.md`,
> `docs/plans/2026-08-11-lynx-mobile-spike-result.md`, `docs/plans/2026-08-12-lynx-windows-phase4.md`,
> 셸 정제 추출: `docs/plans/2026-08-14-gap-closure-production-ready-design.md`

## 구조

```
runner/template/
├── app/                     # ▶ 공유: 단일 ReactLynx UI (1벌). greet("rustra") → "Hello, rustra!"
│   ├── src/{App,index}.tsx
│   ├── generated/           #   codegen 산출물 (gitignore). `npm run codegen` 으로 재생성.
│   ├── lynx.config.ts
│   └── package.json         #   codegen script = ../codegen.sh (dual-path 왕복)
├── backend/                 # ▶ 공유: 단일 Rust rustra 백엔드 (standalone crate)
│   ├── src/lib.rs           #   #[command] greet + template_package() + rustra_template_* FFI
│   ├── src/capabilities.rs  #   ★ capability trait + registry (계층 B) + MobileBridge FFI
│   └── src/bin/generate.rs  #   codegen Rust 절반 (schema/types/commands/contract)
├── codegen.sh               #   dual-path codegen 왕복 (Rust bin → TS CLI)
├── desktop/                 # ▶ 플랫폼: Tauri 셸 (macOS 완전 / Windows 가이드)
│   ├── run.sh               #   macOS 게이트 (bundle→build→run→grep)
│   ├── build-lynx-host.sh   #   backend staticlib + src-tauri + TemplateApp.app 조립
│   ├── verify-windows.ps1   #   Windows 게이트 (Windows 머신)
│   ├── WINDOWS.md           #   Windows 포팅 3포인트 가이드 (FML PE 크럭스 포함)
│   └── src-tauri/           #   main.rs (NSView/HWND 분기) + lynx_desktop.mm + build.rs
├── mobile-ios/              # ▶ 플랫폼: iOS 셸 (CocoaPods + xcodegen)
│   ├── run.sh               #   시뮬 게이트 (번들→staticlib→xcodebuild→simctl→log grep)
│   ├── project.yml / Podfile
│   ├── app/                 #   AppDelegate/ViewController (LynxConfig + RustraModule)
│   └── modules/rustra-lynx/ #   RustraModule.{h,m} + podspec + build-rust-ios.sh
├── mobile-android/          # ▶ 플랫폼: Android 셸 (gradle wrapper 포함)
│   ├── run.sh               #   에뮬 게이트 (번들→NDK staticlib→gradle→logcat grep)
│   ├── gradlew(+wrapper)    #   별도 설치 없이 ./gradlew 실행 가능
│   ├── app/                 #   MainActivity/RustraApplication/DemoTemplateProvider
│   └── modules/rustra-lynx/ #   RustraModule.kt + rustra_jni.cpp + CMakeLists + build-rust-android.sh(NDK 핀)
├── capabilities/            # ▶ capability 확장 패턴 문서 (Mobile 브리지 ABI 포함)
├── create-runner.sh         #   템플릿 → 새 프로젝트 인스턴스화 (복사 + 식별자 치환 + path 재작성).
└── README.md                #   본 파일.
```

**공유(1벌):** ReactLynx app + Rust backend + rkyv V2 wire.
**플랫폼별:** NativeModule 셸(desktop host / iOS RustraModule / Android RustraModule) + init + 빌드.

## 빠른 시작

```sh
# 1. 새 프로젝트 인스턴스화 (rustra-bridge 루트에서)
./runner/template/create-runner.sh my-app com.example.myapp
cd ../my-app

# 2. Rust command 확장 (backend/src/lib.rs #[command]) — greet 외 추가 시.
# 3. codegen → generated/ 재생성 + ReactLynx 번들 빌드
(cd app && npm install && npm run codegen && npm run build)

# 4. 플랫폼 실행 (각 run.sh 이 bundle→rust→셸 빌드 후 rkyv 왕복 게이트)
./desktop/run.sh          # macOS: SetParent NSView + greet rkyv 왕복
./mobile-ios/run.sh       # iOS 시뮬: RustraModule + greet rkyv 왕복
./mobile-android/run.sh   # Android 에뮬: JNI_OnLoad init + greet rkyv 왕복
# Windows: desktop/verify-windows.ps1 (Windows 머신) + desktop/WINDOWS.md
```

## 전제 (각 플랫폼)

| 플랫폼  | 요구                                                                                                                                |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | `LYNX_SDK`(기본 /tmp/lynx-prebuilt/macsdk) — `gh release download 4.0.1 --repo lynx-family/lynx --pattern lynx_sdk_macos_arm64.zip` |
| iOS     | Xcode + xcodegen + CocoaPods + 시뮬레이터(부팅됨)                                                                                   |
| Android | Android SDK + NDK 27.1.12297006 핀 + cargo-ndk + rustup android targets + AVD(`AVD` env, 기본 Medium_Phone_API_36.1)                |
| Windows | MSVC + `LYNX_SDK_WIN` — `desktop/WINDOWS.md` 참조 (FML PE 심볼 = 유일 크럭스)                                                       |

rustup android targets: `rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android`

## 와이어 포맷 (스파이크 7/7 로 증명된 rkyv V2)

```
request  [cmd_id: u16 LE][postcard Input]
response [ok: u8][7B pad][postcard Output]  또는 [ok=0][pad][err]
```

greet 예시: `greet({name:"rustra"})` → `GreetOutput{message:"Hello, rustra!"}`.

## codegen (dual-path)

`generated/` 는 두 codegen 경로를 순서대로 돌아야 최신이 된다 — `npm run codegen`
(=`../codegen.sh`) 이 둘 다 수행한다:

1. **Rust bin** (`cargo run --manifest-path backend/Cargo.toml --bin generate`):
   `types.ts` / `commands.ts` / `contract.ts` / `schema.json`
2. **TS CLI** (`rustra generate --schema generated/schema.json --output generated`):
   `rkyv-codecs.ts` / `rkyv-registry.ts`

in-repo 템플릿은 `packages/cli/dist` 를 자동 탐색한다. 외부 복사본은 `RUSTRA_CLI` env
또는 `npm i -D @rustra/cli` 사용 (`create-runner.sh` 안내 참조).

## 플랫폼 셸 소스

각 플랫폼 셸은 스파이크에서 정제 추출한 실코드다 (핵심 포인트):

| 플랫폼          | 셸 파일                                                | 핵심 포인트                                                      |
| --------------- | ------------------------------------------------------ | ---------------------------------------------------------------- |
| macOS desktop   | `desktop/src-tauri/{src/main.rs, src/lynx_desktop.mm}` | SetParent NSView + 명시 rustra init + FML Mach-O 펌프(오프셋 핀) |
| Windows desktop | 동일(main.rs Win32 분기 포함) + `WINDOWS.md`           | SetParent HWND + 명시 init + **FML PE 심볼 해석(크럭스)**        |
| iOS             | `mobile-ios/{app/, modules/rustra-lynx/}`              | `RustraModule.m` invokeRkyvV2: + staticlib + LynxConfig 등록     |
| Android         | `mobile-android/{app/, modules/rustra-lynx/}`          | `RustraModule.kt` + JNI_OnLoad init + LynxEnv init (3대 갭 해결) |

정제 규칙: 스파이크 검증 훅 중 benchResult/타이밍은 제거, ackResult 는 게이트가
grep 하므로 유지. hex dump 등 디버그 로그는 축소.

## capability (디바이스 API)

2계층 — `capabilities/README.md` 참조:

- **A:** rustra 자체 authority (플랫폼 중립, 추가 구현 불필).
- **B:** platform-native trait + registry (`backend/src/capabilities.rs`).
  - Desktop: `DesktopRegistry` (std::fs FileCap, NotifyCap 정직 에러)
  - Mobile: `MobileBridge` C ABI 콜백 (`rustra_template_register_mobile_registry`) —
    플랫폼이 read_file/notify/free 콜백을 주입하면 `MobileRegistry` 가 위임.

## 템플릿 자체 검증 (본 머신)

- Rust 백엔드: `cargo test --manifest-path runner/template/backend/Cargo.toml` (6 passed) —
  MobileRegistry 위임 경로 포함.
- codegen+bundle: `(cd app && npm install && npm run codegen && npm run build)` → `dist/index.lynx.bundle`.
- 플랫폼 런타임: 각 `run.sh` 게이트 (macOS 본 머신 / iOS·Android 각 머신 / Windows 문서).

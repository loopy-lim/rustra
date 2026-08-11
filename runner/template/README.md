# rustra runner 템플릿

4플랫폼(macOS desktop / Windows desktop / iOS / Android) **단일 ReactLynx 번들 + 단일 Rust rkyv 백엔드**
앱의 시작점. 스파이크 3종(macOS 7/7 · iOS 7/7 · Android 7/7) 이 증명한 구조를 복사-수정-빌드
가능한 템플릿으로 정제했다.

> 검증 근거: `docs/plans/2026-08-11-tauri-lynx-desktop-design.md`,
> `docs/plans/2026-08-11-lynx-mobile-spike-result.md`, `docs/plans/2026-08-12-lynx-windows-phase4.md`

## 구조

```
runner/template/
├── app/                 # ▶ 공유: 단일 ReactLynx UI (1벌). greet("rustra") → "Hello, rustra!"
│   ├── src/{App,index}.tsx
│   ├── generated/       #   codegen 산출물 (gitignore). `npm run codegen` 으로 재생성.
│   ├── lynx.config.ts
│   └── package.json
├── backend/             # ▶ 공유: 단일 Rust rustra 백엔드 (standalone crate, cargo check ✓ + 3 테스트 ✓)
│   ├── src/lib.rs       #   #[command] greet + template_package() + rustra_template_* FFI 심볼
│   └── src/capabilities.rs  #   ★ capability trait + registry (계층 B)
├── desktop/             # ▶ 플랫폼: Tauri 셸 (macOS now / Windows scaffold). run.sh 게이트.
├── mobile-ios/          # ▶ 플랫폼: iOS 셸 (Lynx SDK 4.0.1). run.sh 게이트.
├── mobile-android/      # ▶ 플랫폼: Android 셸 (Lynx SDK 4.0.1). run.sh 게이트.
├── capabilities/        # ▶ capability 확장 패턴 문서 + 예제.
├── create-runner.sh     #   템플릿 → 새 프로젝트 인스턴스화 (복사 + 식별자 치환).
└── README.md            #   본 파일.
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
# Windows: desktop/ 의 verify-windows.ps1 (Windows 머신)
```

## 와이어 포맷 (스파이크 7/7 로 증명된 rkyv V2)

```
request  [cmd_id: u16 LE][postcard Input]
response [ok: u8][7B pad][postcard Output]  또는 [ok=0][pad][err]
```

greet 예시(9/52/95 바이트 시퀀스의 한 형태): `greet({name:"rustra"})` → `GreetOutput{message:"Hello, rustra!"}`.

## 플랫폼 셸 추출 (create-runner.sh 이 안내)

각 플랫폼 디렉토리의 `run.sh` 는 게이트(검증) 역할. **플랫폼 셸 코드 자체**는 대응 스파이크에서
정제 추출한다 (design §7: 전체 복사 아닌 핵심 파일 + 포인터).

| 플랫폼          | 셸 소스(spike)                                                       | 핵심 포인트                                                                                                |
| --------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| macOS desktop   | `examples/lynx-tauri-spike/src-tauri/{main.rs, src/lynx_desktop.mm}` | SetParent NSView + 명시 rustra init + FML Mach-O 펌프                                                      |
| Windows desktop | 동일(spike) + `verify-windows.ps1`                                   | SetParent HWND + 명시 init + **FML PE 심볼 해석(크럭스)** — `docs/plans/2026-08-12-lynx-windows-phase4.md` |
| iOS             | `examples/lynx-calculator/{ios, modules/rustra-lynx/ios/}`           | `RustraModule.m` invokeRkyvV2: + staticlib                                                                 |
| Android         | `examples/lynx-calculator/{android, modules/rustra-lynx/android/}`   | `RustraModule.kt` + JNI_OnLoad init + LynxEnv init (3대 갭)                                                |

## capability (디바이스 API)

2계층 — `capabilities/README.md` 참조:

- **A:** rustra 자체 authority (플랫폼 중립, 추가 구현 불필).
- **B:** platform-native trait + registry (`backend/src/capabilities.rs`). command 는 trait 만,
  구현체는 플랫폼이 startup 에 주입(Desktop=std::fs / Mobile=FFI 콜백 브리지).

## 템플릿 자체 검증 (본 머신)

- Rust 백엔드: `cargo check --manifest-path runner/template/backend/Cargo.toml` ✓
- capability trait: `cargo test --manifest-path runner/template/backend/Cargo.toml` (3 passed) ✓
- ReactLynx app: codegen 후 `npm run build` (사용자 수행).
- 플랫폼 런타임: 각 `run.sh` 게이트 (macOS 본 머신 / iOS·Android·Windows 각 머신).

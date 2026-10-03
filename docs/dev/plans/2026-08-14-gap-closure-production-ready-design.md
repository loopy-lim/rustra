# 갭 클로저 — runner 템플릿 production-ready (mobile+desktop 동시 지원)

- **상태:** 완료 (2026-08-14, 커밋 `3f6939e6` + `080b75c8`).
- **날짜:** 2026-08-14
- **근거 리서치:** `docs/research/2026-08-14-gap-analysis-status.ko.md` (5개 갭 확인).
- **목표:** 리서치가 확인한 5개 갭을 모두 해소하고, `create-runner.sh` 로 만든 프로젝트가
  macOS desktop + iOS + Android 에서 **같은 단일 번들·단일 백엔드**로 구동·검증되는
  production-ready 상태로 만든다.

---

## 해소할 5개 갭 (리서치 결론 → 본 계획의 대응)

| #   | 갭                                                    | 본 계획 Task                                               |
| --- | ----------------------------------------------------- | ---------------------------------------------------------- |
| G1  | 템플릿 플랫폼 셸 부재 (desktop/iOS/Android 셸 코드 X) | Task 1–3: 스파이크에서 정제 추출                           |
| G2  | codegen 스텁 → 템플릿 단독 빌드 불가                  | Task 4: generate bin + CLI 왕복 실경로 + codegen script    |
| G3  | capability 계층 B 미완성 (NotifyCap/Mobile 브리지 X)  | Task 5: MobileRegistry FFI 콜백 브리지 + NotifyCap desktop |
| G4  | P6 Android NDK 핀 부재 + Windows scaffold 부재        | Task 6: build-rust-android.sh NDK 핀 + Windows 포팅 가이드 |
| G5  | 문서 상태 부채 (구 design "구현 대기" 방치 등)        | Task 7: 문서 정리                                          |

## 설계 원칙 (스파이크 검증 사실에서 도출)

스파이크 3종(macOS 7/7 · iOS 7/7 · Android 7/7)이 증명한 구조를 그대로 정제 추출한다.
템플릿은 "증명"이 아니라 "시작점"이므로:

1. **스파이크 특수물 제거** — `ackResult`/`benchResult` 검증 훅, 벤치마크 코드, hex dump,
   SUMMARY 카운터 중 검증 전용은 제거. 단 run.sh 게이트가 grep 하는 로그 라인은 유지.
2. **식별자는 전부 `template` 계열** — `rustra_template_init` / `template.app` /
   `rustra-template-desktop` / `RustraTemplate` / `com.rustra.template`.
   `create-runner.sh` 의 기존 4종 치환 규칙이 그대로 작동해야 한다.
3. **하나의 bundle 산출물, 세 셸이 같이 소비** — `app/dist/index.lynx.bundle`을
   desktop(파일 로드) / iOS(`app/Resources/app.lynx.js` 복사) / Android
   (`assets/main.lynx.bundle` 복사)가 각자 복사해 쓴다 (스파이크 패턴).
4. **Rust staticlib 빌드는 backend crate 기준** — 템플릿 backend 는 독립 workspace
   (`[workspace]` 빌려주기)라 cargo target dir 가 backend/target 이다. 각 빌드 스크립트는
   `--manifest-path backend/Cargo.toml` 로 빌드하고 산출물을 모듈 별 `rust/lib/` 로 배치.
5. **Windows 는 포팅 가이드 + 조건 빌드** — lynx_desktop_win.cpp 작성은 Windows 머신
   확보 전제(P1 FML PE 크럭스). 템플릿엔 `#[cfg(target_os)]` 분기 구조와 포인터만 (정직).

---

## Task 1 — desktop 셸 추출 (`runner/template/desktop/`)

스파이크 `examples/lynx-tauri-spike/src-tauri/` 를 정제:

```
desktop/
├── run.sh                    (기존 게이트 유지, 경로만 실제 셸에 맞춰 수정)
├── build-lynx-host.sh        (신규: backend staticlib + src-tauri 빌드 + TemplateApp.app 조립)
├── verify-windows.ps1        (Windows 머신 게이트 — 스파이크 것 정제 이식)
└── src-tauri/
    ├── Cargo.toml            (tauri 2 + raw-window-handle 0.6 + cc; rustra-template-backend staticlib 링크)
    ├── build.rs              (cc 로 lynx_desktop.mm 컴파일 + Lynx SDK + staticlib 링크)
    ├── tauri.conf.json       (productName Rustra Template, identifier dev.rustra.template)
    ├── Info.plist            (CFBundleExecutable rustra-template-desktop)
    └── src/
        ├── main.rs           (spike main.rs 와 동일 구조: handle 추출 → AppKit/Win32 분기 →
        │                      lynx_template_init/pump/summary extern. 식별자만 template)
        └── lynx_desktop.mm   (spike 414줄에서 정제: bench 관련 제거, ack 는 게이트용 유지,
                               rustra_template_* FFI 로 교체, 심볼명 lynx_template_*)
```

정제 규칙:

- `lynx_desktop.mm`: extern `rustra_template_init/invoke_rkyv_v2/free_buffer` 사용.
  `BenchResult`/`g_invoke_times_ns` 벤치 블록 제거. `ackResult` 는 run.sh 게이트가
  `SUMMARY resultAcked` 를 grep 하므로 **유지** (greet 결과 "Hello" ack).
- `main.rs`: `rustra-lynx-tauri-spike` → `rustra-template-desktop`, extern 은
  `lynx_template_{init,pump,summary}` 로. ack 검증 exit 3 로직 유지 (run.sh 의 pkill wait 정합).
- `build-lynx-host.sh`: spike build-lynx-host.sh 를 template 경로에 맞게 —
  (1) `cargo build --release --manifest-path backend/Cargo.toml`(→ backend/target/release/librustra_template_backend.a),
  (2) src-tauri build (LYNX_SDK 환경 주입), (3) TemplateApp.app 조립
  (binary + LynxResources.bundle symlink + Info.plist). run.sh 가 참조하는 경로
  `$HERE/src-tauri/../../TemplateApp.app/Contents/MacOS/rustra-template-desktop` 에 정확히 맞춤.

**게이트(verify):** `runner/template/desktop/run.sh` — 기존 4단계 grep 게이트 그대로 통과해야 함.
전제: LYNX_SDK(/tmp/lynx-prebuilt/macsdk).

## Task 2 — iOS 셸 추출 (`runner/template/mobile-ios/`)

스파이크 `examples/lynx-calculator/{ios, modules/rustra-lynx/ios}` 를 정제:

```
mobile-ios/
├── run.sh                    (기존 게이트 유지, 아래 실제 구조에 맞게 경로 수정 — verify-ios.sh 패턴 이식)
├── app/
│   ├── AppDelegate.{h,m}    (동일; 주석의 calculator → template)
│   ├── ViewController.{h,m} (동일; loadTemplate app.lynx.js)
│   ├── main.m
│   ├── Info.plist            (bundle id dev.rustra.template)
│   └── Resources/            (번들 복사 대상 — .gitkeep)
├── project.yml               (xcodegen; RustraTemplate, bundleIdPrefix dev.rustra)
└── modules/rustra-lynx/
    ├── build-rust-ios.sh     (spike 것에서 --manifest-path backend/Cargo.toml + lib 이름 치환)
    ├── RustraLynx.podspec    (vendored rust/lib/librustra_template_backend.a)
    ├── RustraModule.{h,m}    (extern rustra_template_* 로 교체)
    └── Podfile               (RustaTemplate target — mobile-ios/Podfile)
```

- `build-rust-ios.sh`: spike 스크립트에서 REPO_ROOT 계산 대신 `MODULE_DIR/../../backend`,
  `-p rustra_template_backend`(crate 하이픈 주의 — manifest-path 단독이면 -p 불필요), 산출
  `backend/target/$TARGET/$PROFILE/librustra_template_backend.a` → `modules/rustra-lynx/ios/rust/lib/`.
- `RustraModule.m`: `rustra_calculator_*` → `rustra_template_*` extern 교체. 로그 `[template-ios]`.
- `run.sh` 재작성: spike verify-ios.sh 의 실제 절차(번들→Resources 복사, staticlib 빌드,
  xcodegen + pod install (없으면), xcodebuild -derivedDataPath build, simctl install/launch,
  log poll, 게이트 grep) 를 template 경로로. 로그 TAG `[template-ios]`.

**게이트(verify):** `runner/template/mobile-ios/run.sh` — iOS 시뮬레이터에서
`loadTemplate bytes>0` / `RustraModule registered` / `rkyv in/out` / `Hello, rustra` 확인.

## Task 3 — Android 셸 추출 (`runner/template/mobile-android/`)

스파이크 `examples/lynx-calculator/{android, modules/rustra-lynx/android}` 를 정제:

```
mobile-android/
├── run.sh                    (기존 게이트 유지, 실제 구조에 맞게 재작성 — verify-android.sh 패턴 이식)
├── gradle/wrapper/           (gradle-wrapper.jar/properties — spike 것 복사, 8.14.3)
├── gradlew
├── gradle.properties
├── settings.gradle.kts       (rootProject RustraTemplate)
├── build.gradle.kts          (AGP 8.7.3 / Kotlin 2.0.21, ndkVersion 27.1.12297006 핀)
└── app/
    ├── build.gradle.kts      (namespace com.rustra.template, cmake path ../../modules/...,
    │                          java.srcDirs ../../modules/rustra-lynx/android/src/main/java)
    └── src/main/
        ├── AndroidManifest.xml
        ├── assets/           (번들 복사 대상 — .gitkeep)
        └── java/com/rustra/template/
            ├── MainActivity.kt     (renderTemplateUrl main.lynx.bundle, TAG template-android)
            ├── RustraApplication.kt (LynxEnv init)
            └── DemoTemplateProvider.kt
└── modules/rustra-lynx/
    ├── build-rust-android.sh  (★Task 6: NDK 핀 포함 재작성)
    └── android/
        ├── CMakeLists.txt     (librustra_template_backend-<triple>.a)
        └── src/main/
            ├── cpp/rustra_jni.cpp   (rustra_template_* extern + JNI_OnLoad init)
            └── java/com/rustra/lynx/RustraModule.kt (TAG template-android)
```

- gradle wrapper 바이너리(jar)는 스파이크에서 복사해 커밋 — 템플릿 사용자가 별도 설치 없이
  `./gradlew` 실행 가능해야 함 (production-ready 요건).
- `local.properties` 는 커밋하지 않고 README 에 안내 (기계 의존).

**게이트(verify):** `runner/template/mobile-android/run.sh` — 에뮬레이터에서
`renderTemplateUrl` / `rkyv in bytes=` / `rkyv out bytes=` / `Hello, rustra` / no error.

## Task 4 — codegen 실경로화 (G2)

- `backend/src/bin/generate.rs` 신규 — calculator main.rs 패턴: `template_package().generate_typescript()?.write_to_dir(<app>/generated)`.
- `app/package.json` codegen script 실구현:
  `"codegen": "npm_run_codegen_rust && node ../../../packages/cli/dist/index.js generate --schema generated/schema.json --output generated"`.
  템플릿이 in-repo 에 있는 동안(복사 전) 에는 `packages/cli/dist` 와 `crates/rustra` path 가
  유효 — 복사 후에는 create-runner.sh 가 절대/상대 경로를 안내(기존 P7 정책 유지).
  in-repo 검증 시 사용할 스크립트를 `runner/template/codegen.sh` 로도 제공:
  `cargo run --manifest-path backend/Cargo.toml --bin generate` + CLI 2종 왕복 (memory: dual-path).
- `App.tsx` import 경로 확인 — `../generated/commands.js`, `../generated/rkyv-registry.js` 그대로.

**게이트(verify):** `cd runner/template/app && npm install && npm run codegen && npm run build`
→ `dist/index.lynx.bundle` 생성 + generated/ 5종 파일 존재.

## Task 5 — capability 계층 B 완성 (G3)

`backend/src/capabilities.rs`:

1. `MobileRegistry` 신규 — FFI 콜백 브리지:
   ```rust
   pub type FileReadCallback = unsafe extern "C" fn(path_ptr: *const u8, path_len: usize,
                                                     out_len: *mut usize) -> *mut u8;  // null=에러
   static FILE_READ_CB: OnceLock<FileReadCallback>
   pub fn set_file_read_callback(cb)
   impl FileCap for MobileRegistry — CB 호출 후 Vec 로 복사, free 는 호출자(플랫폼) 책임 명시
   ```
2. `NotifyCap` 구현체:
   - Desktop: `DesktopRegistry` 의 `notify()` — macOS 임시 구현은 `osascript` 힌트 수준의
     stub 이 아니라, **에러를 정직하게 반환**하는 기본 구현 + Tauri plugin 연결 가이드 주석.
     (플랫폼 셸에 의존하지 않는 순수 Rust 계층 유지)
   - Mobile: NotifyCap 콜백 브리지도 동일 패턴으로 trait + setter 제공.
3. FFI 심볼 노출: `rustra_template_set_file_read_callback` 등 `#[no_mangle]` —
   NativeModule(iOS RustraModule.m / Android JNI)이 startup 에 호출.
4. 샘플 command `read_config`(FileCap 사용) 활성화 + 단위테스트 확장:
   - MobileRegistry CB 주입 → read 성공/실패 경로
   - registry 미주입 시 capability.missing 에러

capabilities/README.md 갱신: 미구현 → 구현됨 (Mobile 브리지 사용법, iOS/Android 등록 코드 예).

**게이트(verify):** `cargo test --manifest-path runner/template/backend/Cargo.toml` — 신규 테스트 포함 전 PASS.

## Task 6 — Android NDK 핀 + Windows 지원 정리 (G4)

- `build-rust-android.sh` (Task 3 파일) 에 verify-android.sh 의 NDK 결정론 로직 이식:
  `NDK_VERSION=${NDK_VERSION:-27.1.12297006}`, `NDK_HOME=$SDK/ndk/$NDK_VERSION` 우선,
  없으면 환경 ANDROID_NDK_HOME fallback, 둘 다 없으면 에러. rustup target 사전 검증.
- `desktop/verify-windows.ps1` 이식 + `desktop/WINDOWS.md` 신규:
  lynx_desktop_win.cpp 포팅 3포인트(SetParent HWND / 명시 init / FML PE 심볼 해석 —
  GetProcAddress → PE 오프셋 fallback 순서), `cargo ndk` 없이 gnu/msvc 크로스컴파일 명령,
  Windows 머신 확보 시 실행 절차. `2026-08-12-lynx-windows-phase4.md` 링크.
- `desktop/src-tauri/src/main.rs` 는 이미 Win32 HWND 분기 포함 (스파이크에서 상속) —
  cfg(target_os) 로 lynx_desktop.mm/win cpp 선택 구조를 build.rs 에 주석 명시.

**게이트(verify):** `shellcheck` 수준 + `cargo check` — Android 스크립트는 본 머신
에뮬레이터 게이트(Task 3)로 실증. Windows 는 문서 게이트(정직: Windows 머신 필요).

## Task 7 — 문서 상태 정리 (G5)

- `docs/plans/2026-05-14-rkyv-command-id-design.md` 헤더: "설계 완료, 구현 대기" →
  "구현 완료(invoke_rkyv_v2, 2026-05 시행)" 갱신 + 근거 링크.
- `2026-08-12-rustra-runner-template-design.md` §7: 셸 추출 완료 상태로 갱신 (본 계획 링크).
- `2026-08-12-cross-platform-problems-review.md`: P6 해소 표시(NDK 핀 이식), P7 은 유지(미발행).
- `runner/template/README.md` 전면 갱신 — 실제 구조와 1:1 (셸 파일 표, codegen 절차,
  capability 브리지 사용법, Windows 절차).
- 루트 `README.md` 프로젝트 구조에 `runner/` 추가.

**게이트(verify):** 문서에 언급된 파일 경로가 실재 (스크립트로 존재 검증).

## Task 8 — 통합 검증 (end-to-end)

in-repo 템플릿 상태로:

1. `cargo test --manifest-path runner/template/backend/Cargo.toml` — 전 PASS.
2. `cd runner/template/app && npm install && npm run codegen && npm run build` — bundle 생성.
3. `bash runner/template/desktop/run.sh` — macOS 게이트 PASS (LYNX_SDK 전제).
4. `bash runner/template/mobile-ios/run.sh` — iOS 시뮬 게이트 PASS.
5. `bash runner/template/mobile-android/run.sh` — Android 에뮬 게이트 PASS.
6. **instantiation 스파크테스트:** `./runner/template/create-runner.sh gap-test com.example.gaptest /tmp/gap-test` →
   식별자 치환 확인(grep) + `cargo check` + `npm install && npm run codegen && npm run build`.
   (path 의존성 문제로 외부 복사본의 cargo 는 rustra path 를 해석 못함 — P7 정책에 따라
   create-runner.sh 가 rustra path 를 **원본 절대경로로 재작성**하는 기능을 추가해 해결.)
7. 기존 회귀: `cargo test --workspace` + `npm run test:packages` + `test:ts:node` — green 유지.

## 완료 기준 (전체)

- [x] T1: desktop/run.sh 게이트 PASS (macOS) — 6/6 PASS (SetParent NSView + greet rkyv 왕복 ack)
- [x] T2: mobile-ios/run.sh 게이트 PASS (iOS 시뮬) — 5/5 PASS (loadTemplate/RustraModule/rkyv in/out)
- [x] T3: mobile-android/run.sh 게이트 PASS (Android 에뮬) — 5/5 PASS (JNI_OnLoad + rkyv 왕복)
- [x] T4: app codegen+build 성공, generated/ 5종 생성
- [x] T5: backend capability 테스트 전 PASS (MobileRegistry 포함) — 테스트 3→6 PASS
- [x] T6: build-rust-android.sh NDK 핀 동작, Windows 문서 완비
- [x] T7: 문서-실제 일치 (경로 검증)
- [x] T8: create-runner.sh 인스턴스가 codegen+build+desktop 게이트 통과 — /tmp 인스턴스 cargo check + codegen + bundle build + desktop 게이트 6/6 PASS
- [x] 기존 워크스페이스 회귀 전부 green — cargo workspace 146/0 · test:packages 24/24 · test:ts:node 32/32 · clippy clean

> **완료 (2026-08-14, 커밋 `3f6939e6` + `080b75c8`)** — 본 머신 검증 수치는
> 커밋 메시지에 기록. 설계 대비 구현 차이: 개별 setter(`rustra_template_set_file_read_callback`)
> 대신 통합 `MobileBridge` + `rustra_template_register_mobile_registry` 단일 FFI로 변경,
> CLI 직접 호출 대신 `codegen.sh` dual-path 위임.

## 리스크

- **iOS xcodegen/pod install 시간** — 첫 run.sh 는 수 분 소요. 스파이크와 동일 절차라 실패율 낙관.
- **gradle wrapper jar 커밋** — Apache 2.0 배포 파일, 커밋 무방(spike 도 커밋됨).
- **Lynx SDK 경로 전제** (/tmp/lynx-prebuilt/macsdk) — LYNX_SDK env 로 오버라이드 가능하게 유지.
- **capability FFI 콜백 ABI** — 문서 + 테스트로 계약 고정. 플랫폼 실장은 iOS/Android 모듈
  시작점 코드로 제공(컴파일은 각 플랫폼 게이트에서).

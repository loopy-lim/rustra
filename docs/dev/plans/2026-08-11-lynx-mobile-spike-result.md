# Lynx Mobile (iOS + Android) Spike — 결과 보고 (Phase A + B 완료)

- **상태:** Phase A(iOS) + Phase B(Android) 완료. **양쪽 모두 PASS.**
- **날짜:** 2026-08-11
- **스파이크 plan:** `docs/plans/2026-08-11-lynx-mobile-spike.md`
- **design:** `docs/plans/2026-08-11-tauri-lynx-desktop-design.md`
- **자동 검증:** `examples/lynx-calculator/ios/verify-ios.sh` (7/7), `examples/lynx-calculator/android/verify-android.sh` (7/7)

> 본 문서는 데스크톱 스파이크(`2026-08-11-tauri-lynx-desktop-spike-result.md`)에서 남겨둔
> "모바일 확장: Android/iOS Lynx SDK 셸 + rustra rkyv NativeModule 신규 작성" 리스크의 해소 결과를 기록한다.

---

## 결론: 단일 ReactLynx 번들 + 단일 rustra rkyv 백엔드가 iOS·Android 모두에서 구동

동일 `index.lynx.bundle`(iOS: `app.lynx.js` 114733B / Android: `main.lynx.bundle` 동일 원본) + 동일 Rust
`rustra_calculator_example` staticlib(`aarch64-apple-ios-sim` / `aarch64-linux-android`)이 각 플랫폼
공식 Lynx SDK 셸 안에서 rkyv V2 fast-path FFI 왕복을 수행했다. **두 플랫폼 모두 9/52/95 바이트 동일 응답 패턴**
(성공 / typed-error / capability.denied) — 와이어 포맷이 플랫폼 중립임이 증명됐다.

| 항목              | iOS                                          | Android                                     |
| ----------------- | -------------------------------------------- | ------------------------------------------- |
| 셸                | CocoaPods `pod 'Lynx'` + `pod 'LynxService'` | Maven `org.lynxsdk.lynx:lynx:4.0.1` (aar)   |
| Rust triple       | `aarch64-apple-ios-sim`                      | `aarch64-linux-android`                     |
| 에뮬/시뮬         | iPhone 17, iOS 26.2                          | `Medium_Phone_API_36.1`, arm64-v8a          |
| NativeModule 언어 | Obj-C (`RustraModule<LynxModule>`)           | Kotlin (`com.lynx.jsbridge.LynxModule`)     |
| 번들 로드         | `loadTemplateFromURL`                        | `renderTemplateUrl("main.lynx.bundle", "")` |
| rkyv 성공 응답    | `out bytes=9` (ok=1, value=42)               | `out bytes=9` (ok=1, value=84=0x54)         |
| typed-error 응답  | `out bytes=52` (math.divide_by_zero)         | `out bytes=52` (math.divide_by_zero)        |
| capability.denied | `out bytes=95` (capability.denied)           | `out bytes=95` (capability.denied)          |
| verify 게이트     | 7/7 PASS                                     | 7/7 PASS                                    |

(인자 a,b 값은 번들이 매 실행 동적으로 생성하므로 런마다 다르다 — iOS 42, Android 84 등.
와이어 구조/바이트 카운트는 플랫폼 무관하게 동일하다.)

---

## Phase A — iOS ✅ (요약, 상세는 plan 문서 Phase A 결과절)

- `verify-ios.sh` 7/7 PASS.
- 결정적 로그: `loadTemplate bytes=114733` → `RustraModule registered` → `rkyv in bytes=4` → `rkyv out bytes=9`(ok=1, 42) → `rkyv out bytes=52`(divide_by_zero) → `rkyv out bytes=95`(capability.denied) → `did invokeMethod: RustraModule.invokeRkyvV2`.
- **해결 갭 — NativeModules 클로저 변수:** ReactLynx 런타임(`lynx_core.js`)은 `globalThis.NativeModules`를 설정하지 않는다. `NativeModules`는 `@lynx-js/runtime-wrapper-webpack-plugin`이 번들 외곽 함수의 위치 인자로 주입하는 클로저 변수. 데스크톱 헤드리스 호스트는 `globalThis.NativeModules` 수동 주입으로 우회, iOS 공식 SDK는 그렇지 않다. `packages/lynx/src/index.ts`의 `getRustraNative()`를 `globalThis.NativeModules`만 보던 것에서 **bare `NativeModules`(typeof 가드) → `globalThis` 폴백** 2경로로 수정해 양쪽을 모두 지원한다.
- 등록: per-view `LynxViewBuilder.config`(LynxConfig + `registerModule:`)로 충분. 글로벌 `LynxEnv prepareConfig:` 불필요.

---

## Phase B — Android ✅

`verify-android.sh` 7/7 PASS. iOS 와 동일 9/52/95 바이트 패턴으로 rkyv V2 wire 가 Android 에서도 그대로 동작.

### 결정적 logcat 증거 (spike-android TAG)

```
spike-android: renderTemplateUrl main.lynx.bundle
spike-android: rkyv in  bytes=4 hex=0100282c
spike-android: rkyv out bytes=9  hex=010000000000000054        ← ok=01, 0x54=84 (40+44)
spike-android: rkyv out bytes=52 hex=...6d6174682e6469766964655f62795f7a65726f...   ← math.divide_by_zero
spike-android: rkyv out bytes=95 hex=...6361706162696c6974792e64656e696564...       ← capability.denied
```

hex 디코딩: `6d6174682e6469766964655f62795f7a65726f` = `math.divide_by_zero`, `6361706162696c6974792e64656e696564` = `capability.denied` (postcard 길이-접두 문자열). 에러 경로 hex: `12` + "ffi.not_registered" + `16` + "package not registered".

### Task B1: Lynx Android SDK 입수 — 성공

사전 조사의 "Maven Central `org.lynxsdk.lynx` numFound:0" 은 `search.maven.org` Solr 인덱스 맹점.
`repo1.maven.org` 의 `maven-metadata.xml` 직접 확인 → **공개 배포 확정**:

- coords: `org.lynxsdk.lynx:lynx:4.0.1` (+ `lynx-jssdk`/`lynx-trace`/`lynx-service-log`/`lynx-service-http`)
- 리포: plain `mavenCentral()` — 커스텀 리포·바이너리 다운로드 불필요.
- design §6 리스크(모바일 SDK 입수) 해소.

### Task B2: 해결한 핵심 갭 3종 (Android 공식 SDK)

#### 갭 1 — LynxEnv 명시 init

Android 는 `renderTemplateUrl` 이전에 `LynxEnv.inst().init(this, null, null, null)` 이 필수(iOS 는
`[LynxEnv sharedInstance]` 로 충분). 생략 시 `errCode 102 "LynxEnv has not been prepared successfully"`.

```kotlin
class RustraApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        LynxEnv.inst().init(this, null, null, null)
    }
}
// AndroidManifest.xml: <application android:name=".RustraApplication" ...>
```

#### 갭 2 — NativeModule API: `com.lynx.jsbridge.*` (NOT `com.lynx.react.bridge.*`)

- 베이스: `com.lynx.jsbridge.LynxModule`(abstract) — **반드시 상속**, `Context` 생성자 필요(프레임워크가 리플렉션 생성).
- 애노테이션: `@LynxMethod`(`com.lynx.jsbridge`) 로 메서드 노출.
- JS 식별자 매핑: Kotlin 메서드명 **그대로**(reflection). iOS 의 `+methodLookup` 사전 매핑이 Android 에는 없다.
- 타입: `ArrayBuffer ↔ ByteArray`.
- 등록: per-view `LynxViewBuilder.registerModule("RustraModule", RustraModule::class.java)` (build 전).

```kotlin
class RustraModule(context: Context) : LynxModule(context) {
    @LynxMethod
    fun invokeRkyvV2(payload: ByteArray): ByteArray { /* JNI → Rust */ }
}
```

#### 갭 3 — Rust 패키지 등록: ELF 에 `__mod_init_func` 없음 → `JNI_OnLoad` 명시 init

Rust crate 는 `#[cfg(target_vendor = "apple")] mod apple_init` 으로 Mach-O `__mod_init_func` constructor 가
라이브러리 로드 시 자동으로 `calculator_package()` 를 FFI 레지스트리에 등록한다. **Android(ELF) 에는
이런 constructor 가 없다** → 패키지 레지스트리가 비어 모든 rkyv 호출이 `out bytes=52`(`ffi.not_registered`) 를 반환.

```cpp
extern "C" jint JNI_OnLoad(JavaVM *, void *) {
  rustra_calculator_init();   // 공개 심볼 — idempotent 패키지 등록
  return JNI_VERSION_1_6;
}
```

`System.loadLibrary("rustra_lynx")` 시 1회 호출. 이후 `out=9`(ok) 로 전환.

### 빌드 스택 & cargo-ndk 메모

AGP 8.7.3, Gradle 8.14.3, Kotlin 2.0.21, compileSdk 35, minSdk 24, ndk `27.1.12297006`, CMake 3.22.1, JDK 17.
cargo-ndk v4: CLI 가 `cargo ndk [OPTIONS] [CARGO_ARGS]...` (cargo 인자는 trailing positional) → `--` 뒤에
cargo 바이너리 경로를 넘기면 안 된다(`-Zscript` 오류). `cargo ndk -t <abi> -- build -p … --lib`.
ABI 매핑: `arm64-v8a` → `aarch64-linux-android` (Rust triple 로 파일명). CMake 는 cpp→rust/lib 까지 **3단계** `../`.

---

## 회귀 확인

`test:packages` 24/24, `test:ts:node` 32/32 통과. Phase A 의 `getRustraNative()` 2경로(bare `NativeModules` →
`globalThis` 폴백) 변경이 데스크톱/Node/타 패키지에 영향 없음 — Node 테스트는 `globalThis` 경로로 통과,
iOS·Android SDK 는 bare 클로저 경로로 동작.

---

## design 문서 반영

- §6 리스크 4(capability NativeModule 모바일 구현): rkyv 왕복 NativeModule 패턴 자체는 iOS·Android 양쪽 검증 완료. capability별(File/Camera/Notify) 구현체는 차기.
- §7 Phase 2(Android) ✅, Phase 3(iOS) ✅. 잔존: Phase 4(Windows libLynx 입수), Phase 5(runner 패키지화).

## 남은 리스크

- **Phase 4 — Windows libLynx 입수**: 로컬은 macOS arm64/iOS/Android. Windows prebuilt 입수/빌드 경로 미확정.
- **capability별 NativeModule**: rkyv V2 왕복 transport(`invokeRkyvV2`)는 검증됐으나, capability command(read_file/notify/camera 등)의 플랫폼별 구현체는 신규 작성 필요. design §4 capability 추상(`trait Capability`)과 연결될 차기 과제.
- **Android NDK 버전 고정**: `27.1.12297006` 로 고정(Rust staticlib ABI 정합). NDK 메이저 업그레이드 시 재검증.
- **Rust `__mod_init_func` ↔ ELF constructor 비대칭**: 차기 runner 패키지화 시 Android 경로의 `JNI_OnLoad` init 호출을 템플릿 기본값으로 문서화 필요(잊으면 `ffi.not_registered` 로 헷갈리기 쉬운 함정).

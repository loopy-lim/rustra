# Lynx Mobile (iOS + Android) Spike Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 동일 ReactLynx 번들 + 동일 rustra rkyv 백엔드가 iOS 시뮬레이터(그리고 가능하면 Android 에뮬레이터)에서 `addNumbers(20,22) → 42` rkyv 왕복을 증명한다.

**Architecture:** iOS = CocoaPods `pod 'Lynx'` + `pod 'LynxService'` (로컬 바이너리 불필요, pod install 시 소스 컴파일) + `RustraLynx` local pod(이미 구현됨, `examples/lynx-calculator/modules/rustra-lynx/ios/`) + Rust staticlib(`build-rust-ios.sh`, `aarch64-apple-ios-sim`). iOS 호스트 앱 셸(AppDelegate/ViewController/LynxView/Podfile)은 lynx-calculator에 신규 추가. Android = `org.lynxsdk.lynx` Maven coords 확인 후 gradle 모듈(템플릿 이미 구현됨) — 단 SDK 입수 경로가 미확정이라 조건부 Phase.

**Tech Stack:** Lynx 4.0.1 (CocoaPods source pod, iOS 14+), Rust `cargo build --target aarch64-apple-ios-sim`, Xcode 26.2 / iPhone 17 sim, xcodegen(프로젝트 생성), cargo-ndk(Android).

**사전 조사 결론 (2026-08-11):**

- iOS 자산 전부 로컬 준비됨: Xcode 26.2, iPhone 17 sim booted, CocoaPods 1.16, rustup `aarch64-apple-ios-sim` installed, `RustraLynx.podspec` + `RustraModule.m` + `build-rust-ios.sh` 구현됨.
- Android 환경 8/9 (gradle만 보충, NDK 27.x, AVD `Medium_Phone_API_36.1`, cargo-ndk) — 그러나 **Lynx Android SDK 입수 경로 미확정**: `/tmp/lynx-prebuilt/`엔 macOS 바이너리 + iOS podspec source만, Maven Central `org.lynxsdk.lynx` 없음(numFound:0). Android는 Phase B에서 입수 시도 후 결과에 따라 정직 보고.
- iOS 통합 패턴(공식 가이드): `AppDelegate` `[LynxEnv sharedInstance]` → `LynxView`(UIView 서브클래스) `addSubview` → `LynxTemplateProvider` 로 bundle 로드.

---

## Phase A — iOS 시뮬레이터 rkyv 왕복 증명

### Task A1: iOS 호스트 앱 셸 (xcodegen 프로젝트)

**Files:**

- Create: `examples/lynx-calculator/ios/app/AppDelegate.m`
- Create: `examples/lynx-calculator/ios/app/ViewController.m`
- Create: `examples/lynx-calculator/ios/app/ViewController.h`
- Create: `examples/lynx-calculator/ios/app/DemoLynxProvider.h` / `.m` (`LynxTemplateProvider` 구현)
- Create: `examples/lynx-calculator/ios/app/Info.plist`
- Create: `examples/lynx-calculator/ios/app/main.m`
- Create: `examples/lynx-calculator/ios/project.yml` (xcodegen 스펙)
- Create: `examples/lynx-calculator/ios/Podfile`

**Step 1: xcodegen 가용성 확인**

```sh
which xcodegen || brew install xcodegen
```

**Step 2: project.yml** — 단일 target `RustraLynxApp`, iOS 14.0, source `app/*.{m,h}`, bundle resource `dist/index.lynx.bundle`.

**Step 3: AppDelegate.m**

```objc
#import <UIKit/UIKit.h>
#import <Lynx/LynxEnv.h>
@interface AppDelegate : UIResponder <UIApplicationDelegate>
@property (strong, nonatomic) UIWindow *window;
@end
@implementation AppDelegate
- (BOOL)application:(UIApplication *)app didFinishLaunchingWithOptions:(NSDictionary *)opts {
  [LynxEnv sharedInstance];   // Lynx 글로벌 초기화 (모든 Lynx API 호출 전)
  self.window = [[UIWindow alloc] initWithFrame:[UIScreen mainScreen].bounds];
  self.window.rootViewController = [[ViewController alloc] init];
  [self.window makeKeyAndVisible];
  return YES;
}
@end
```

**Step 4: ViewController.m** — `LynxView` 생성 + `addSubview` + `loadTemplate` (번들 리소스 로드).

```objc
#import "ViewController.h"
#import <Lynx/LynxView.h>
#import "DemoLynxProvider.h"
@implementation ViewController
- (void)viewDidLoad {
  [super viewDidLoad];
  LynxView *lv = [[LynxView alloc] initWithFrame:self.view.bounds];
  lv.templateProvider = [[DemoLynxProvider alloc] init];
  [self.view addSubview:lv];
  NSURL *bundleURL = [[NSBundle mainBundle] URLForResource:@"index.lynx" withExtension:@"bundle"];
  [lv loadTemplateFromURL:bundleURL];
}
@end
```

**Step 5: DemoLynxProvider** — `LynxTemplateProvider` 프로토콜, 메인 번들에서 `index.lynx.bundle` bytes 반환.

**Step 6: Podfile**

```ruby
platform :ios, '14.0'
target 'RustraLynxApp' do
  use_frameworks!
  pod 'Lynx'
  pod 'LynxService'
  pod 'RustraLynx', :path => '../modules/rustra-lynx/ios'
end
# Xcode 26 호환 (공식 가이드 post_install hook)
post_install do |installer|
  installer.pods_project.targets.each do |t|
    t.build_configurations.each do |c|
      c.build_settings['GCC_TREAT_WARNINGS_AS_ERRORS'] = 'NO'
      c.build_settings['USER_SCRIPT_SANDBOXING'] = 'NO'
    end
  end
end
```

**Step 7: xcodegen generate**

```sh
cd examples/lynx-calculator/ios && xcodegen generate
```

Expected: `RustraLynxApp.xcodeproj` 생성.

### Task A2: rustra iOS staticlib + ReactLynx bundle

**Step 1: Rust staticlib 빌드**

```sh
cd examples/lynx-calculator && \
  modules/rustra-lynx/ios/build-rust-ios.sh
```

Expected: `modules/rustra-lynx/ios/rust/lib/librustra_calculator_example.a` 생성 (`aarch64-apple-ios-sim`).

**Step 2: ReactLynx bundle 빌드 + iOS 리소스 복사**

```sh
cd examples/lynx-calculator && npm run build
mkdir -p ios/app/Resources
cp dist/index.lynx.bundle ios/app/Resources/   # xcodegen 이 번들 리소스로 포함
```

project.yml 은 `app/Resources/index.lynx.bundle` 를 `Copy Bundle Resources` 로 추가.

### Task A3: pod install + 시뮬레이터 빌드

**Step 1: pod install**

```sh
cd examples/lynx-calculator/ios && pod install
```

Expected: `Lynx` / `LynxService` / `RustraLynx` 설치. (첫 install 은 Lynx 소스 컴파일로 수 분 소요.)

**Step 2: xcodebuild 시뮬레이터 빌드**

```sh
cd examples/lynx-calculator/ios && \
  xcodebuild -workspace RustraLynxApp.xcworkspace -scheme RustraLynxApp \
    -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17' \
    -derivedDataPath build ONLY_ACTIVE_ARCH=YES build
```

Expected: `BUILD SUCCEEDED`. 실패 시 에러 읽고 수정.

### Task A4: 시뮬레이터 실행 + rkyv 왕복 증명

**Step 1: 부트된 시뮬 확인**

```sh
xcrun simctl list devices booted
```

**Step 2: 앱 설치 + 실행**

```sh
APP_PATH=$(find examples/lynx-calculator/ios/build/Build/Products -name 'RustraLynxApp.app' -path '*Simulator*' | head -1)
xcrun simctl install booted "$APP_PATH"
xcrun simctl launch booted dev.rustra.lynx-calculator   # bundle id 는 Info.plist 에 맞춤
```

**Step 3: 증명 캡처**

```sh
# UI 스크린샷 — "result: 42" 가 보이면 rkyv 왕복 성공
xcrun simctl io booted screenshot /tmp/lynx-ios-result.png
# 런타임 로그 — addNumbers/invokeRkyvV2 호출 추적 (필요시 RustraModule.m 에 NSLog 추가)
xcrun simctl spawn booted log stream --predicate 'process == "RustraLynxApp"' --timeout 8
```

**Step 4: 검증(성공 기준)** — 스크린샷에 `result: 42` (또는 로그에서 rkyv 왕복 확인).

성공 기준:

1. iOS 시뮬에서 앱 실행 (white screen 아님)
2. ReactLynx 뷰 렌더링 (addNumbers(20,22) 호출)
3. `result: 42` 표시 (rkyv V2 fast-path 왕복)

**Step 5: verify-ios.sh 작성** — 위 Step 1~4 자동화, PASS/FAIL.

### Task A5: Phase A 커밋

```sh
git add examples/lynx-calculator/ios/ examples/lynx-calculator/modules/rustra-lynx/ios/rust/  # rust/.a 만, build 산물 제외
git commit -m "feat(mobile): iOS 시뮬레이터 Lynx + rustra rkyv 왕복 스파이크"
```

(lefthook prettier/rustfmt 후 amend.)

---

## Phase B — Android (조건부: SDK 입수 성공 시)

### Task B1: Lynx Android SDK 입수 시도

**Step 1: 입수 경로 순차 시도**

- GitHub `lynx-family/lynx` releases (maven artifacts / aar).
- 공식 `integrating-lynx-demo-projects` 의 gradle 의존성 coords.
- `examples/react-native-calculator/` 의 기존 android build 산물에 Lynx aar 캐시 있는지.

**Step 2: 입수 결과 기록**

- 성공: coords/경로를 plan 결과에 기록 → Task B2 진행.
- 실패: 정직 보고 — "Android Lynx SDK 를 입수할 수 없음(iOS는 성공)". Phase B 중단, design §6 리스크 3(Windows) 와 함께 Android 입수를 차기 과제로 명시.

### Task B2: (입수 성공 시) Android gradle 모듈 + 에뮬 빌드/런

- `examples/lynx-calculator/modules/rustra-lynx/android/build-rust-android.sh` (cargo-ndk, 이미 구현).
- Android 호스트 앱(Activity → LynxView + RustraModule 등록) + gradle(Lynx coords).
- `Medium_Phone_API_36.1` 에뮬에서 빌드/런, `result: 42` 증명.

---

## 완료 조건

- [ ] **iOS (필수):** 시뮬레이터에서 `result: 42` rkyv 왕복 — verify-ios.sh PASS.
- [ ] **Android (조건부):** 에뮬레이터에서 `result: 42` — 또는 SDK 입수 실패 정직 보고.
- [ ] 결과 보고서 `docs/plans/2026-08-11-lynx-mobile-spike-result.md` 작성.
- [ ] design `2026-08-11-tauri-lynx-desktop-design.md` §6/§7 업데이트(모바일 리스크 해소/잔존).

iOS PASS 시 design §7 Phase 3(iOS) 완료, Phase 2(Android)는 입수 결과에 따라. main push.

---

## Phase A 결과 (2026-08-11) — iOS PASS ✅

`verify-ios.sh` 7/7 PASS. 동일 ReactLynx 번들(`app.lynx.js`) + 동일 rustra rkyv 백엔드가
iOS 시뮬레이터(iPhone 17, iOS 26.2)에서 실제 Rust FFI 왕복을 수행했다.

**결정적 로그 증거:**

- `[spike-ios] loadTemplate path=…/app.lynx.js bytes=114733` — ReactLynx 번들 로드.
- `module: RustraModule registered with param (address): 0x0` — `LynxConfig registerModule:` 등록 성공.
- `[spike-ios] rkyv in bytes=4` — addNumbers 요청 (`[cmd 1 u16 LE][postcard {a:20,b:22}]`).
- `[spike-ios] rkyv out bytes=9` — addNumbers→**42** 응답 (`[ok=1][7B pad][postcard {value:42}]`), rkyv V2 와이어 포맷 정확 일치.
- `[spike-ios] rkyv out bytes=52` — divide(1,0) typed error(`math.divide_by_zero`) 왕복.
- `[spike-ios] rkyv out bytes=95` — secureCompute `capability.denied` (deny-by-default authority).
- `LynxModuleDarwin did invokeMethod: RustraModule.invokeRkyvV2` — FFI 정상 왕복.
- "Rustra not configured" 에러 없음.

**해결한 핵심 갭 — NativeModules 클로저 변수 (iOS 공식 SDK):**
ReactLynx 런타임(`lynx_core.js`)은 `globalThis.NativeModules`를 **설정하지 않는다**.
`NativeModules`는 `@lynx-js/runtime-wrapper-webpack-plugin`이 번들 외곽 함수의 위치 인자로
주입하는 **클로저 변수**다 (번들 내 모든 모듈의 bare 식별자가 이 클로저로 해석됨 —
`@lynx-js/websocket`의 `NativeModules.LynxWebSocketModule`과 동일 패턴).
데스크톱 헤드리스 호스트(`host.cpp`)는 이 갭을 `globalThis.NativeModules` 수동 주입으로 우회했지만,
iOS 공식 SDK는 그렇지 않다. `packages/lynx/src/index.ts`의 `getRustraNative()`가
`globalThis.NativeModules`만 보던 것을 **bare `NativeModules`(typeof 가드) → `globalThis` 폴백**
2경로로 수정해 양쪽(host/iOS·Android SDK)을 모두 지원한다. (Node 테스트는 `globalThis` 경로 유지로 통과.)

**등록 패턴:** per-view `LynxViewBuilder.config`(LynxConfig + `registerModule:[RustraModule class]`)로 충분.
글로벌 `LynxEnv prepareConfig:` 불필요 (여러 LynxView 공유 시에만).

**회귀 확인:** `test:packages` 24/24, `test:ts:node` 32/32 통과 — getRustraNative 변경 데스크톱/타 패키지 영향 없음.

스크린샷: `/tmp/lynx-ios-result.png` (result: 42, err: math.divide_by_zero, cap: capability.denied 표시).

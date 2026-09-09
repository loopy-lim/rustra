# React Native Calculator

Expo development build에서 Rustra generated JSI bridge를 사용하고, 같은 Rust 코어를
Nitro Modules와 Swift FFI 비교 경로에도 연결하는 성능·런타임 fixture입니다. 제품
사용 경로는 Expo API에 의존하지 않으며 bare RN fixture와 같은 autolinking 모듈을
사용합니다.

## 실행

모든 앱 작업은 Bun 1.4로 실행합니다.

```bash
bun install
bun run codegen
bun run check
```

실제 네이티브 빌드 게이트는 다음과 같습니다.

```bash
bun run verify:native:android
bun run verify:native:ios
```

iOS Release 앱을 설치하고 측정 receipt를 추출하려면:

```bash
bun run ios -- --configuration Release
bun run bench:ios:receipt -- --output /tmp/rustra-rn-receipt.json
```

## 앱 코드

```ts
import { addNumbers } from './generated/react-native';

const result = await addNumbers({ a: 42, b: 58 });
```

`rustra.json`은 monorepo app crate의 위치만 지정합니다. Cargo package/library 이름,
TypeScript bootstrap, Podspec, Gradle,
CMake와 JNI는 생성기가 소유합니다. 첫 명령이 JSI 설치, contract 검증, fast engine
설정을 한 번만 수행하므로 앱 코드에 수동 `install`/`configure`가 없습니다.

## 구조

```text
react-native-calculator/
  App.tsx
  BenchmarkApp.tsx
  generated/                         generated TypeScript entry/codecs
  modules/
    rustra-jsi/                      generated @rustra/generated-react-native
    rustra-calculator/               Swift FFI comparator
    nitro-bench/nitro-bench/         Nitro comparator
```

`rustra-jsi`라는 디렉터리명은 fixture의 기존 로컬 위치일 뿐 공개 package/module
이름이 아닙니다. 실제 충돌 격리 이름은 다음과 같습니다.

- package: `@rustra/generated-react-native`
- iOS/React Native module: `RustraBridge`
- Android namespace: `dev.rustra.bridge`
- shared library: `rustra_bridge`

Rustra generated package는 표준 React Native autolinking만 사용합니다. Expo module
config, Podfile, `settings.gradle`, `MainApplication`의 수동 Rustra 패치는 없습니다.
Expo Go는 JSI native code를 포함할 수 없으므로 development build가 필요합니다.

## doctor

```bash
bun run doctor
bun run doctor -- --json
```

doctor는 읽기 전용이며 다음 층을 독립적으로 확인합니다.

- 현재 checkout의 lockfile과 로컬 `@rustra/*` 패키지 조합
- Rust schema, TypeScript entry, C++ codec, build fingerprint 동기화
- iOS/Android autolinking과 Pods
- iOS static archive 최신성, architecture, 필수 FFI symbol
- booted simulator의 설치 앱과 runtime fingerprint

Metro reload는 static archive, Pod, FFI symbol을 교체하지 않습니다. Runtime 경고가
남으면 simulator를 boot하고 현재 native app을 다시 설치해야 합니다.

개발용 Metro를 켠 상태에서 JSI 재설치, Rust 소유 byte buffer finalizer, 진행 중 async
callback을 30회 runtime reload로 검증하려면 다음을 실행합니다.

```bash
bun run demo:reload
bun run test:reload:ios -- --cycles 30
```

## Android 핫 코어 스모크 (dev)

네이티브 핫 코어 스왑은 JSI 표면을 정적으로 유지하고 C++ 코어 내부 디스패치
테이블만 재지향합니다. 따라서 시그니처 불변 로직 변경(스키마/계약 해시 불변)은
JS 재로드 없이 실행 중인 앱에 반영됩니다. 스모크는 `addNumbers(2,3)`로 이를
증명합니다 — 정적 코어는 `5`, 전달된 behavior 변형(`a+b+100`)은 같은 로그
스트림에서 `105`를 답합니다.

전달 계약 — tmp + rename, 제자리 덮어쓰기 금지:

- 앱은 `<filesDir>/rustra/hot` 에서 `*-hot-live.so` 를 감시합니다(Kotlin
  `nativeConfigureHotCore` 가 `nativeInstall` 직후 호출되며, 파일이 없으면
  정적 코어로 머무릅니다).
- 프로세스가 이미 `dlopen` 한 파일을 같은 경로로 제자리 덮어쓰면 Android 에서
  SIGSEGV 가 납니다(수정된 파일 페이지가 재로딩됩니다). 그래서 모든 전달은
  `live-tmp.so` 로 기록한 뒤 `run-as mv` 로 교체합니다 — 동일 디렉터
  `rename(2)` 라 원자적이고 기존 inode 가 보존됩니다.
- `/data/local/tmp` 는 스테이징 영역으로 쓸 수 없습니다. 앱 도메인
  (`untrusted_app`)은 `shell_data_file` 를 읽지 못해 그곳에서의 `run-as cp` 는
  SELinux 거부입니다. push 스크립트는 대신 stdin 바이트를
  `run-as <pkg> dd of=<절대 경로>` 로 스트리밍합니다 — 셸 메타문자가 하나도
  없는 형태인데, 일부 adbd 는 따옴표로 감싼 `sh -c` 명령을 분해해 redirect 가
  엉뚱한 셸에서 실행되기 때문입니다(API 36 에뮬레이터 실측). 전달된 바이트 수는
  원자 rename 전에 다시 읽어 대조합니다.

최초 1회 준비물: 실행 중인 에뮬레이터(`adb devices`, 기본 `emulator-5554`,
`--serial` 또는 `ADB_SERIAL` 로 재정의), cdylib 빌드용 NDK/cargo-ndk,
디버깅 가능한 앱 빌드(release 는 `run-as` 가 거부합니다).

```bash
# 터미널 1 — 핫 코어 앱 분기를 서빙합니다
bun run demo:hot-core

# 터미널 2 — 전체 스모크: cargo ndk cdylib → gradle assembleDebug + 설치
# → 부팅 → [RustraHotCore] READY value=5 → push → addNumbers 5→105 관측
bun run test:hot-core:android

# 또는 미리 빌드한 cdylib 를 수동 전달하고 로그를 감시합니다
bun run push:hot-core:android -- <경로>/librustra_hot_core_variant.so
adb logcat -v time | grep '[RustraHotCore]'
```

유용한 플래그: `--skip-cargo` / `--skip-gradle` 은 기존 산출물과 설치된 앱을
재사용합니다. `--package` 는 자동 감지된 application id(`app.json` →
`android/app/build.gradle`)를 재정의합니다. push 스크립트는 전달 바이트 수를
검증해 파이프 절단을 조용히 넘기지 않습니다.

## iOS 시뮬레이터 핫 코어 스모크 (dev)

같은 스왑 계약을 iOS 시뮬레이터에서 수행합니다. 전달 메커니즘만 iOS에 맞게
다릅니다. 실기기는 스코프 외입니다(샌드박스를 호스트 FS 에서 직접 만질 수
없습니다).

전달 계약 — env 로 디렉터 주입, tmp + rename, 제자리 덮어쓰기 금지:

- iOS 어댑터는 JSI 모듈 설치 시 env `RUSTRA_HOT_CORE_DIR`(디렉터)을 읽고 그
  디렉터의 `*-hot-live.*` 를 폴링합니다. 스모크는 `SIMCTL_CHILD_` 접두사로
  경로를 주입합니다(`SIMCTL_CHILD_RUSTRA_HOT_CORE_DIR=<디렉터> xcrun simctl
launch …`) — `simctl` 이 이 환경변수를 앱 프로세스에 전파합니다(실측 확인).
  디렉터가 비어 있으면 정적 코어로 부팅됩니다. baseline(`READY value=5`)을
  정적 코어에서 관측해야 하므로 런치 전에 stale live 파일을 확실히 지웁니다.
- 핫 디렉터는 앱 data 컨테이너 안의 `Documents/rustra/hot` 입니다. 런치 시와
  push 시 모두 `xcrun simctl get_app_container <udid> <bundle-id> data` 로
  조회합니다 — 앱을 재설치하면 컨테이너 경로가 바뀔 수 있고, env 경로와 push
  대상이 어긋나면 스왑이 영원히 관측되지 않습니다.
- 시뮬레이터 컨테이너는 호스트 FS 위에 있어 push 스크립트가 직접 기록할 수
  있습니다. 하지만 프로세스가 이미 `dlopen` 한 dylib 를 같은 경로로 제자리
  덮어쓰면 iOS 에서는 SIGKILL 이 떨어집니다. 그래서 모든 전달은
  `live-tmp.dylib` 로 기록한 뒤 동일 디렉터 rename(2) 로 교체합니다 — 원자적이고
  기존 inode 가 보존됩니다. 기록된 바이트 수는 rename 전에 검증합니다.

최초 1회 준비물: 부팅된 시뮬레이터(없으면 스모크가 기본 iPhone 17 을 부팅합니다.
`--udid` 또는 `RUSTRA_SIM_UDID` 로 재정의), 핫 코어 분기를 서빙하는 Metro.

```bash
# 터미널 1 — 핫 코어 앱 분기를 서빙합니다
bun run demo:hot-core

# 터미널 2 — 전체 스모크: cargo ios-sim cdylib → xcodebuild + 설치
# → 부팅 → [RustraHotCore] READY value=5 → push → addNumbers 5→105 관측
bun run test:hot-core:ios

# 또는 미리 빌드한 cdylib 를 수동 전달하고 로그 스트림을 감시합니다
bun run push:hot-core:ios -- <경로>/librustra_hot_core_variant.dylib
xcrun simctl spawn booted log stream --style compact \
  --predicate 'eventMessage CONTAINS "[RustraHotCore]"'
```

유용한 플래그: `--skip-cargo` / `--skip-xcodebuild` 은 기존 산출물과 설치된 앱을
재사용합니다. `--ready-timeout-ms` / `--swap-timeout-ms` 은 관측 대기 시간을
조정합니다. `--bundle-id` 는 자동 감지된 bundle id(`app.json` →
`expo.ios.bundleIdentifier`)를 재정의합니다.

## 성능 비교 계약

Nitro, Rustra, FFI는 동일 입력과 결과 shape를 먼저 검증한 뒤 호출 단위로 순환
측정합니다. runner는 3회 중앙값, paired 95% CI, p50/p95/p99, throughput과 생성
helper/native 경로 진단을 receipt에 기록합니다.

2026-08-24 저장된 Release 중앙값에서 Rustra/Nitro 비율은 add 1.0418x, string
1.0281x, bytes64 0.9543x, pair 1.0535x, 64KiB 0.9338x, exact 1MiB 1.0129x였습니다.
이는 세션 관측치이지 모든 기기의 보장이 아닙니다. 최신 결과와 기능 패리티는
[벤치마크 문서](../../docs/benchmarks.md)를 따릅니다.

0.4 최종 fingerprint
`eb14a45517032caa6adbfb1b366da70ef1adcb69633e09eac07fd831f37a90b1`의 Release
receipt도 correctness와 paired 95% CI gate를 통과했습니다.

byte 경로는 `Uint8Array`/`ArrayBuffer` view의 offset과 length를 검증하고 raw span을
caller-buffer FFI에 전달합니다. 결과는 Rust가 소유한 buffer를 한 번만 JS
`ArrayBuffer`로 옮기며, free callback이 수명을 회수합니다. optional/복합 byte shape는
안전하게 일반 codec 경로로 폴백합니다.

## 검증 범위

- `bun run test`: doctor/receipt/benchmark 통계/adapter 회귀
- `bun run test:cpp-codec`: generated codec과 byte lifetime C++ 회귀
- `bun run verify:native:*`: 실제 Android/iOS build와 link
- `examples/react-native-bare-calculator`: Expo 없는 RN autolinking 회귀

build/link 성공은 물리 기기 장시간 실행을 대신하지 않습니다. 릴리스 전에는 현재
commit의 Release 앱에서 generated command, reload stress, benchmark receipt를 다시
확인해야 합니다.

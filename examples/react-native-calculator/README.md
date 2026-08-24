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

`rustra.json`은 monorepo app crate의 위치와 benchmark 전용 legacy ABI flag만
지정합니다. Cargo package/library 이름, TypeScript bootstrap, Podspec, Gradle,
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

- Bun 1.4와 동기화된 `@rustra/*` 0.4.0 release line
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

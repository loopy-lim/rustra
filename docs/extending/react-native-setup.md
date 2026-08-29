# React Native Setup Guide

Rustra는 Expo development build와 bare React Native에 같은 generated native
package를 사용합니다. 앱의 Podfile, Gradle settings, `MainApplication`, CMake를
직접 편집하지 않습니다.

## 1. Rust crate 준비

모바일 앱이 링크할 static library를 만들고, package 초기화를 한 줄로 export합니다.

```toml
[lib]
crate-type = ["rlib", "staticlib"]
```

```rust
use rustra::prelude::*;

pub fn app_package() -> Package {
    rustra::build!("app.example", add_numbers).done()
}

rustra::native_entry!(app_package);
```

`native_entry!`는 플랫폼 공통 `rustra_mobile_init` ABI를 만들고 Apple에서는 library
load 시 package를 자동 등록합니다. 앱별 함수명을 C++에 복사하지 않습니다.

## 2. 앱 설정

일반적인 단일-crate 앱은 `reactNative: {}`면 충분합니다.

```json
{
  "schema": "./generated/schema.json",
  "output": "./generated",
  "codegen": {
    "rustManifest": "./Cargo.toml",
    "rustBinary": "generate"
  },
  "reactNative": {}
}
```

Cargo workspace에 staticlib crate가 여러 개라면 manifest를 app crate로 좁힙니다.

```json
{
  "schema": "./generated/schema.json",
  "output": "./generated",
  "reactNative": {
    "rustManifest": "../native/Cargo.toml"
  }
}
```

manifest 자체도 여러 package를 가리킬 때만 `rustPackage`를 추가합니다. library
target 이름은 Cargo metadata에서 추론하므로 보통 `rustLibrary`는 필요 없습니다.

## 3. 생성과 설치

모든 JavaScript 작업은 Bun 1.4 이상으로 실행합니다.

```bash
bun add @rustra/react-native @rustra/types
bun add -d @rustra/cli
bunx --bun @rustra/cli doctor --config rustra.json
bunx --bun @rustra/cli codegen --config rustra.json
bun install
```

생성 결과는 기본적으로 다음과 같습니다.

```text
generated/
  react-native.ts
  commands.ts
  rkyv-registry.ts
modules/rustra-bridge/
  package.json
  react-native.config.js
  RustraBridge.podspec
  ios/
  android/
  generated/
```

생성기는 `package.json`의 `@rustra/generated-react-native` workspace dependency가 다른
경로를 가리키면 덮어쓰지 않고 실패합니다. 이 fail-closed 동작이 기존 패키지와의
우발적 충돌을 막습니다.

## 4. 앱 코드

```ts
import { addNumbers } from './generated/react-native';

const result = await addNumbers({ a: 1, b: 2 });
```

첫 호출이 native install, contract 검증, fast engine configure를 한 번만 수행합니다.
reload 후에도 새 JavaScript runtime에 다시 설치되며, 동시 첫 호출은 하나의 bootstrap을
공유합니다.

## 5. bare React Native

React Native CLI가 생성 모듈의 iOS Podspec과 Android source directory를 찾는지
확인합니다.

```bash
bunx --bun react-native config
cd ios && pod install
```

그 뒤 평소처럼 앱을 새로 빌드합니다. Metro reload만으로는 static archive나 JSI
symbol 변경이 반영되지 않습니다.

저장소의 `examples/react-native-bare-calculator`는 Expo package 없이 RN 0.81에서
TypeScript와 양 플랫폼 autolinking을 검증하는 fixture입니다.

## 6. Expo

Expo Go는 임의의 JSI native module을 포함할 수 없으므로 development build가
필수입니다.

```bash
bunx --bun expo prebuild --platform ios --no-install
bunx --bun expo run:ios
```

생성 모듈은 React Native autolinking을 사용하므로 Expo module config나 Podfile
수동 선언은 필요하지 않습니다.

## 7. 검증

```bash
bun run typecheck
bunx --bun react-native config
```

저장소 예제에서는 다음 추가 게이트를 제공합니다.

```bash
cd examples/react-native-calculator
bun run codegen
bun run test
bun run test:cpp-codec
bun run verify:native:android
bun run verify:native:ios
```

CI는 클린 Expo prebuild 후 Android Release APK의 `librustra_bridge.so`와 iOS
Release workspace link를 확인합니다. build/link 성공은 실제 기기 실행과 별개이므로
제품 릴리스 전에는 simulator/device에서 generated command 결과도 확인해야 합니다.

## 충돌 방지 계약

- JS package: `@rustra/generated-react-native`
- native module: `RustraBridge`
- Android namespace: `dev.rustra.bridge`
- Android library: `rustra_bridge`
- stable Rust initializer: `rustra_mobile_init`

calculator 전용 benchmark ABI는 `legacyBenchmarks: true` fixture에서만 컴파일됩니다.
일반 사용자 생성물에는 포함되지 않습니다.

## 문제 해결

`RustraBridge was not linked`가 나오면 `bun run codegen`, `bun install`,
`bunx --bun react-native config` 순서로 확인하고 iOS는 Pods를 다시 설치한 뒤 native
app을 재빌드합니다.

Cargo package가 모호하다는 오류는 `codegen.rustManifest`와
`codegen.rustPackage`를 app crate로 좁혀 해결합니다. generator binary가 모호하면
`codegen.rustBinary`를 추가합니다. staticlib target 오류는 `[lib] crate-type`에
`staticlib`를 추가합니다.

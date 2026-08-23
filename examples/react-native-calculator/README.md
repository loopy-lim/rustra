# React Native Calculator 예시

rustra 패키지를 React Native(Expo) 앱에서 JSI 브릿지를 통해 사용하는 예시입니다.

## 개요

C++ JSI caller-buffer 경로를 주 경로로 사용하고, 동일 앱 안에서 Nitro Modules와
Swift Expo 모듈 기반 C FFI를 함께 측정합니다. JSON, msgpack, postcard, rkyv,
rkyvV2의 정확성과 비용 분해도 같은 Release 빌드에서 확인합니다.

## 구조

```
react-native-calculator/
├── App.tsx              # 기본 사용 예시
├── BenchmarkApp.tsx     # Nitro·Rustra JSI·Swift FFI 동등 조건 벤치마크
├── modules/
│   ├── rustra-calculator/   # Expo 모듈 (Swift → Rust FFI)
│   ├── rustra-jsi/          # JSI 네이티브 인터페이스
│   └── nitro-bench/         # Nitro Modules 비교용
```

## 테스트하는 커맨드

| Tier   | 커맨드                                      | 타입              |
| ------ | ------------------------------------------- | ----------------- |
| Tier 1 | `addNumbers`, `multiply`, `isEven`, `clamp` | 고정폭 프리미티브 |
| Tier 2 | `greet`, `sumList`, `toUpper`               | 문자열, Vec       |
| Tier 3 | `createItem`, `processItem`                 | 중첩 구조체       |

## 실행

```bash
# 의존성 설치
bun install

# iOS Release 빌드·설치 (Pod prepare 단계가 Rust archive도 빌드)
bunx expo run:ios --configuration Release

# 빠른 로컬 게이트
bun run typecheck
bun run test
bun run test:cpp-codec
```

`rustra-jsi`와 `rustra-calculator`는 루트의 `expo-module.config.json`으로
autolink된다. Swift 모듈은 Rust archive를 별도로 링크하지 않고 RustraJSI pod가
force-load한 하나의 archive를 공유하므로, 두 비교 경로는 같은 Rust 코어를 쓴다.

## 예시가 보여주는 것

1. **JSI 브릿지** — JavaScript → C++ JSI → caller-buffer Rust FFI 직접 호출
2. **다중 직렬화 비교** — JSON, msgpack, postcard, rkyv, hybrid, rkyvV2 성능 측정
3. **정확성 검증** — 모든 포맷의 커맨드 결과가 올바른지 자동 확인
4. **벤치마크** — 동등 비교는 Nitro/Rustra/FFI를 호출 단위로 순환하고,
   avg/stddev/min/max/p50/p95/p99, 100개 batch mean과 처리량을 구조화 receipt로 출력.
   Debug에서는 성능 측정을 중단해 Release 영수증과 섞이지 않음
5. **FFI 비교** — add/string/64-byte/object를 Nitro·JSI와 같은 입력/출력으로 측정하고,
   정답 shape를 timing 전에 검증. 모양이 다른 Swift sync scalar는 lower bound로만 표시
6. **자동 네이티브 설치** — Expo autolinking + 단일 Rust archive 소유권

## 핵심 파일

| 파일                                                         | 설명                     |
| ------------------------------------------------------------ | ------------------------ |
| `BenchmarkApp.tsx`                                           | 벤치마크 UI 및 실행 로직 |
| `modules/rustra-calculator/ios/RustraCalculatorModule.swift` | Swift → Rust FFI 브릿지  |
| `modules/rustra-jsi/ios/build-rust-ios.sh`                   | iOS용 Rust 크로스 컴파일 |
| `modules/rustra-jsi/`                                        | 저수준 JSI 인터페이스    |

## 사전 요구사항

- Expo SDK ~54
- React Native 0.81+
- Xcode + iOS 시뮬레이터
- Rust iOS 타겟 (`rustup target add aarch64-apple-ios-sim`)

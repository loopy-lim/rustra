# React Native Calculator 예시

rustra 패키지를 React Native(Expo) 앱에서 JSI 브릿지를 통해 사용하는 예시입니다.

## 개요

Swift Expo 모듈을 통해 Rust FFI를 호출하고, `@rustra/react-native` 어댑터로 다양한 직렬화 포맷(JSON, msgpack, postcard, rkyv, rkyvV2)의 성능을 비교합니다.

## 구조

```
react-native-calculator/
├── App.tsx              # 전체 벤치마크 UI (9개 커맨드 × 6개 직렬화)
├── BenchmarkApp.tsx     # Nitro Modules 비교 벤치마크
├── modules/
│   ├── rustra-calculator/   # Expo 모듈 (Swift → Rust FFI)
│   ├── rustra-jsi/          # JSI 네이티브 인터페이스
│   └── nitro-bench/         # Nitro Modules 비교용
```

## 테스트하는 커맨드

| Tier | 커맨드 | 타입 |
|------|--------|------|
| Tier 1 | `addNumbers`, `multiply`, `isEven`, `clamp` | 고정폭 프리미티브 |
| Tier 2 | `greet`, `sumList`, `toUpper` | 문자열, Vec |
| Tier 3 | `createItem`, `processItem` | 중첩 구조체 |

## 실행

```bash
# 의존성 설치
npm install

# iOS 빌드 (Rust + Expo)
cd modules/rustra-calculator/ios && ./build-rust-ios.sh
cd ../../..
npx expo run:ios

# 타입체크만
npm run typecheck
```

## 예시가 보여주는 것

1. **JSI 브릿지** — JavaScript → Swift → Rust FFI 직접 호출
2. **다중 직렬화 비교** — JSON, msgpack, postcard, rkyv, hybrid, rkyvV2 성능 측정
3. **정확성 검증** — 모든 포맷의 커맨드 결과가 올바른지 자동 확인
4. **벤치마크** — 100K 반복, p50/p99, 처리량(ops/s) 측정
5. **Expo 모듈 패턴** — Swift, Podspec, 빌드 스크립트 완비

## 핵심 파일

| 파일 | 설명 |
|------|------|
| `App.tsx` | 벤치마크 UI 및 실행 로직 |
| `modules/rustra-calculator/ios/RustraCalculatorModule.swift` | Swift → Rust FFI 브릿지 |
| `modules/rustra-calculator/ios/build-rust-ios.sh` | iOS용 Rust 크로스 컴파일 |
| `modules/rustra-jsi/` | 저수준 JSI 인터페이스 |

## 사전 요구사항

- Expo SDK ~54
- React Native 0.81+
- Xcode + iOS 시뮬레이터
- Rust iOS 타겟 (`rustup target add aarch64-apple-ios-sim`)

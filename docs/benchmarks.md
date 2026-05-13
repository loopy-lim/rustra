# 벤치마크

모든 측정은 Apple Silicon (M-series) 환경에서 수행했다.

## 테스트 환경

| 항목 | 버전 |
|------|------|
| OS | macOS (Darwin 25.3.0, arm64) |
| Rust | stable, aarch64-apple-darwin |
| Node.js | v22.21.1 |
| Bun | 1.3.6 |
| React Native | 0.81.5 + Expo 54 |
| iOS 시뮬레이터 | iPhone 17 |

## 어댑터별 성능 비교

단일 `addNumbers({ a: 42, b: 58 })` 호출 기준 (10,000회 이상 반복, release 빌드).

| 어댑터 | 평균 지연 | p50 | p99 | 처리량 (ops/s) |
|--------|----------|-----|-----|---------------|
| Rust (typed invoke) | 209 ns | 208 ns | 292 ns | 5,093,309 |
| Rust (JSON roundtrip) | 172 ns | — | — | ~5,800,000 |
| Swift → Rust FFI | 3.5 µs | 3.4 µs | 4.7 µs | 296,710 |
| Bun (JS engine) | 189 ns | — | — | ~5,284,714 |
| Node.js (JS engine) | 308 ns | — | — | ~3,251,407 |
| React Native (iOS sim) | 52.5 µs | 50.0 µs | 91.3 µs | 19,054 |

> JS 어댑터(Bun, Node) 수치는 `EngineClient.invoke` JS측 오버헤드만 측정한 것으로, 실제 IPC/FFI 비용은 별도다.

## Rust 코어 성능

### 패키지 생성

```
Package::builder("...").command_fn(...).build()
```

| 지표 | 값 |
|------|-----|
| 평균 | 8.3 µs |
| p50 | 7.1 µs |
| p99 | 23.6 µs |

### 명령 호출 (typed)

```
package.invoke::<SimpleInput, SimpleOutput>("addNumbers", input)
```

| 지표 | 값 |
|------|-----|
| 평균 | 209 ns |
| p50 | 208 ns |
| p99 | 292 ns |
| 최대 처리량 | 5,093,309 ops/s |

### TypeScript 코드 생성

| 지표 | 값 |
|------|-----|
| 평균 | 20 µs |
| p50 | 19.7 µs |
| p99 | 26.7 µs |

### Ser/de 오버헤드 (데이터 크기별)

| 페이로드 | 직렬화 (to_value) | 역직렬화 (from_value) |
|----------|-------------------|---------------------|
| Simple (2 fields) | 100 ns | 153 ns |
| 10 items | 3.6 µs | 4.9 µs |
| 100 items | 32.7 µs | 48.6 µs |
| 1000 items | 353.4 µs | 505.5 µs |

## 페이로드 크기별 확장성

### Rust (invoke_json)

| 항목 수 | JSON 크기 | 평균 지연 | 처리량 |
|---------|----------|----------|--------|
| 1 | 87 B | 557 ns | ~156 KB/s |
| 10 | 779 B | 3.3 µs | ~236 KB/s |
| 100 | 7.9 KB | 26.3 µs | ~301 KB/s |
| 1000 | 82.5 KB | 293.6 µs | ~281 KB/s |

### Swift FFI (RN 네이티브 계층)

| 항목 수 | JSON 크기 | 평균 지연 |
|---------|----------|----------|
| 1 | 113 B | 4.2 µs |
| 10 | 720 B | 10.5 µs |
| 50 | 3.5 KB | 39.1 µs |
| 100 | 7.0 KB | 80.5 µs |

## React Native 오버헤드 분석

실제 iOS 시뮬레이터에서 측정한 `addNumbers` 호출의 레이어별 분해:

```
JSON ser/de (JS)       ▓▓                       2.9 µs    (5.5%)
RN bridge + FFI        ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒    40.2 µs   (76.6%)
EngineClient wrap      ░░                       9.3 µs    (17.7%)
                       ─────────────────────── ────────
Total                                            52.5 µs
```

RN에서 대부분의 지연은 Expo NativeModule 비동기 브릿지 통과에서 발생한다. Rust FFI 호출 자체는 3.5 µs로 전체의 ~7%에 불과하다.

## JS 어댑터 JSON 성능

| 연산 | Node.js | Bun | 비고 |
|------|---------|-----|------|
| JSON.parse (simple) | 269 ns | 127 ns | Bun 2.1x 빠름 |
| JSON.stringify (simple) | 93 ns | 61 ns | Bun 1.5x 빠름 |
| JSON.parse (100 items) | 34.3 µs | 23.8 µs | Bun 1.4x 빠름 |
| JSON.stringify (100 items) | 54.0 µs | 33.6 µs | Bun 1.6x 빠름 |
| EngineClient.invoke | 308 ns | 189 ns | Bun 1.6x 빠름 |
| Object spread copy | 22 ns | 19 ns | 비슷 |

## 벤치마크 실행 방법

```bash
# Rust 전체 벤치마크
cargo run --release -p rustra-benchmark

# Node.js 어댑터 벤치마크
node scripts/adapter-bench.mjs

# Bun 어댑터 벤치마크
bun scripts/adapter-bench.mjs

# Swift FFI 벤치마크 (macOS)
cd scripts/swift-ffi-bench && make

# React Native 벤치마크 (iOS 시뮬레이터 필요)
# examples/react-native-calculator/BenchmarkApp.tsx를 App.tsx로 교체 후
npx expo run:ios
```

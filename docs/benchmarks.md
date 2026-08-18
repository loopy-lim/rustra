# 벤치마크

모든 측정은 Apple Silicon (M-series) 환경에서 수행했다.

## 테스트 환경

| 항목           | 버전                         |
| -------------- | ---------------------------- |
| OS             | macOS (Darwin 25.3.0, arm64) |
| Rust           | stable, aarch64-apple-darwin |
| Node.js        | v22.21.1                     |
| Bun            | 1.3.6                        |
| React Native   | 0.81.5 + Expo 54             |
| iOS 시뮬레이터 | iPhone 17                    |

## 2026-08-18 현재 버전 재측정 (`0.1.2`)

아래 수치는 이번 checkout에서 benchmark를 순차 실행한 재측정 결과다. Rust 코어
수치는 Apple Silicon macOS에서 측정했으며, N-API는 release native addon을 사용했다.
기존 온디바이스 iOS/Android 표와 직접 합산하지 않고 현재 기준선으로 사용한다.

### Rust release wire benchmark

`cargo run -p rustra-calculator-example --bin wire-bench --release`

| 경로                       | 요청 | 응답 |        평균 |         p50 |         p99 |            처리량 |
| -------------------------- | ---: | ---: | ----------: | ----------: | ----------: | ----------------: |
| JSON `invoke`              | 47 B | 34 B |     2.43 µs |     2.38 µs |     2.75 µs |     411,082 ops/s |
| postcard `invoke_postcard` | 13 B |  4 B |     1.70 µs |     1.62 µs |     1.88 µs |     587,120 ops/s |
| rkyv V2 `invoke_rkyv_v2`   |  4 B | 10 B | **1.34 µs** | **1.29 µs** | **1.50 µs** | **743,821 ops/s** |

→ 현재 Rust 코어에서 rkyv V2는 JSON보다 약 1.8배, postcard보다 약 1.3배 빠르며,
요청 wire는 JSON 대비 약 11.8배 작다.

### Node.js release N-API transport

`cd examples/calculator-napi && npm run build`, 이후 `npm run bench`

| transport          |       평균 |        p50 |        p99 |            처리량 |
| ------------------ | ---------: | ---------: | ---------: | ----------------: |
| Node.js subprocess |    5.99 ms |    5.68 ms |   10.82 ms |         167 ops/s |
| Node N-API         | **2.9 µs** | **2.7 µs** | **5.2 µs** | **349,062 ops/s** |

→ 동일 실행에서 N-API가 subprocess보다 약 2,092배 빠르다. 고정 47 B payload의
샘플 수를 100~10,000회로 바꿔도 2.7~2.8 µs로 측정되어 benchmark 안정성도 확인했다.

### React Native iOS Release micro-benchmark

실제 iPhone 17 Simulator Release 실행에서 `BenchmarkApp`을 100K sync iteration,
10K async iteration으로 측정했다.

| 경로              |        평균 |         p50 |        p99 |
| ----------------- | ----------: | ----------: | ---------: |
| rkyv V2 encode    |      2.1 µs |      1.7 µs |          - |
| rkyv V2 JSI call  |      8.3 µs |      8.1 µs |          - |
| rkyv V2 decode    |      675 ns |      625 ns |          - |
| rkyv V2 full sync | **11.2 µs** | **10.6 µs** |          - |
| JSON full sync    |     26.1 µs |     25.5 µs |          - |
| Nitro async       |      1.9 µs |      1.7 µs |     2.1 µs |
| rkyv V2 async     |  **5.4 µs** |  **5.2 µs** | **6.5 µs** |
| JSON async        |     27.2 µs |     26.5 µs |    34.5 µs |

→ 이 실행에서 rkyv V2는 JSON 대비 full sync 약 2.3배, async 약 5.0배 빠르다.
Nitro보다는 느리지만, Rustra의 정적 codec 및 rkyv V2 경로가 실제 RN JSI 환경에서
동작하면서 측정된 값이다.

### Rust Criterion debug Tier 3 기준선

동적 registry는 release에서 mutation이 차단되는 설계이므로 `--profile dev`로
측정했다. 각 benchmark는 0.5초 warm-up, 2초 measurement로 순차 실행했다.

| 경로                       |     평균 |
| -------------------------- | -------: |
| 정적 Tier 1 postcard       |  6.15 µs |
| 정적 Tier 2 postcard       |  5.47 µs |
| 동적 Tier 3 JSON-in-binary |  8.86 µs |
| `register()` 1회           | 26.92 µs |
| `live_schema()` 3 commands | 52.43 µs |
| mutable invoke             |  8.76 µs |
| frozen invoke              |  8.74 µs |

payload scaling은 1/10/100/1000 items에서 각각 31.29 µs, 131.23 µs, 590.12 µs,
5.78 ms였다. 동적 Tier 3은 payload가 커질수록 JSON 처리 비용이 지배적이므로,
대형 payload에는 정적 codec Tier 1/2 또는 별도 binary codec을 우선 사용해야 한다.

## 어댑터별 성능 비교

단일 `addNumbers({ a: 42, b: 58 })` 호출 기준 (10,000회 이상 반복, release 빌드).

| 어댑터                          | 평균 지연   | p50         | p99         | 처리량 (ops/s) |
| ------------------------------- | ----------- | ----------- | ----------- | -------------- |
| Rust (typed invoke)             | 209 ns      | 208 ns      | 292 ns      | 5,093,309      |
| Rust (JSON roundtrip)           | 172 ns      | —           | —           | ~5,800,000     |
| **Lynx (Direct C++ Fast-Path)** | **0.95 µs** | **0.85 µs** | **1.45 µs** | **1,052,000**  |
| Nitro Modules (v0.80+)          | 1.10 µs     | 0.90 µs     | 1.80 µs     | 909,000        |
| RN JSI (rkyv V2 Fast-Path)      | 1.50 µs     | 1.30 µs     | 2.80 µs     | 666,000        |
| **Lynx (rkyv V2 Binary JS)**    | **3.80 µs** | **3.20 µs** | **5.40 µs** | **263,000**    |
| Swift → Rust FFI                | 3.5 µs      | 3.4 µs      | 4.7 µs      | 296,710        |
| Bun (JS engine)                 | 189 ns      | —           | —           | ~5,284,714     |
| Node.js (JS engine)             | 308 ns      | —           | —           | ~3,251,407     |
| React Native (Standard JSON)    | 52.5 µs     | 50.0 µs     | 91.3 µs     | 19,054         |

> JS 어댑터(Bun, Node) 수치는 `EngineClient.invoke` JS측 오버헤드만 측정한 것으로, 실제 IPC/FFI 비용은 별도다.

## Transport별 End-to-End 성능

단일 `addNumbers({ a: 42, b: 58 })` 호출 기준 (10,000회 반복, debug 빌드). Rust 실행 + JSON 직렬화 + transport 오버헤드를 모두 포함한 실제 측정값.

| Transport                  | 평균 지연   | p50         | p99         | 처리량 (ops/s) |
| -------------------------- | ----------- | ----------- | ----------- | -------------- |
| Node.js subprocess (stdio) | 1.84 ms     | 1.77 ms     | 2.41 ms     | ~542           |
| **Node.js napi-rs**        | **24.3 µs** | **24.0 µs** | **26.5 µs** | **~41,172**    |
| Bun subprocess (stdio)     | 1.69 ms     | 1.62 ms     | 2.24 ms     | ~593           |
| **Bun FFI**                | **26.8 µs** | **26.3 µs** | **33.6 µs** | **~37,250**    |

### Transport 오버헤드 분석

```
Node.js napi-rs:
  Rust core + serde     █                              ~200 ns   (0.8%)
  JS JSON ser/de        █                              ~459 ns   (1.9%)
  napi-rs bridge        ████████████████████████████  ~23.8 µs  (97.9%)
  Total                 █████████████████████████████  ~24.3 µs

Bun FFI:
  Rust core + serde     █                              ~200 ns   (0.7%)
  JS JSON ser/de        █                              ~203 ns   (0.8%)
  Bun FFI bridge        ████████████████████████████  ~26.6 µs  (99.2%)
  Total                 █████████████████████████████  ~26.8 µs
```

napi-rs와 Bun FFI는 subprocess 대비 각각 **76x**, **63x** 빠르다. 대부분의 지연은 FFI/napi 브릿지 레이어에서 발생하며, Rust core와 JSON 처리는 전체의 1-3%에 불과하다.

### 벤치마크 실행

```bash
# Transport 벤치마크 (Node)
node scripts/transport-bench.mjs

# Transport 벤치마크 (Bun)
bun scripts/transport-bench.mjs

# Transport 성능 회귀 테스트
npm run test:runtime:node-napi
```

## Rust 코어 성능

### 패키지 생성

```
Package::builder("...").command_fn(...).build()
```

| 지표 | 값      |
| ---- | ------- |
| 평균 | 8.3 µs  |
| p50  | 7.1 µs  |
| p99  | 23.6 µs |

### 명령 호출 (typed)

```
package.invoke::<SimpleInput, SimpleOutput>("addNumbers", input)
```

| 지표        | 값              |
| ----------- | --------------- |
| 평균        | 209 ns          |
| p50         | 208 ns          |
| p99         | 292 ns          |
| 최대 처리량 | 5,093,309 ops/s |

### TypeScript 코드 생성

| 지표 | 값      |
| ---- | ------- |
| 평균 | 20 µs   |
| p50  | 19.7 µs |
| p99  | 26.7 µs |

### Ser/de 오버헤드 (데이터 크기별)

| 페이로드          | 직렬화 (to_value) | 역직렬화 (from_value) |
| ----------------- | ----------------- | --------------------- |
| Simple (2 fields) | 100 ns            | 153 ns                |
| 10 items          | 3.6 µs            | 4.9 µs                |
| 100 items         | 32.7 µs           | 48.6 µs               |
| 1000 items        | 353.4 µs          | 505.5 µs              |

## 페이로드 크기별 확장성

### Rust (invoke_json)

| 항목 수 | JSON 크기 | 평균 지연 | 처리량    |
| ------- | --------- | --------- | --------- |
| 1       | 87 B      | 557 ns    | ~156 KB/s |
| 10      | 779 B     | 3.3 µs    | ~236 KB/s |
| 100     | 7.9 KB    | 26.3 µs   | ~301 KB/s |
| 1000    | 82.5 KB   | 293.6 µs  | ~281 KB/s |

### Swift FFI (RN 네이티브 계층)

| 항목 수 | JSON 크기 | 평균 지연 |
| ------- | --------- | --------- |
| 1       | 113 B     | 4.2 µs    |
| 10      | 720 B     | 10.5 µs   |
| 50      | 3.5 KB    | 39.1 µs   |
| 100     | 7.0 KB    | 80.5 µs   |

## React Native 오버헤드 분석

### Expo async bridge (초기 측정)

실제 iOS 시뮬레이터에서 측정한 `addNumbers` 호출의 레이어별 분해:

```
JSON ser/de (JS)       ▓▓                       2.9 µs    (5.5%)
RN bridge + FFI        ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒    40.2 µs   (76.6%)
EngineClient wrap      ░░                       9.3 µs    (17.7%)
                       ─────────────────────── ────────
Total                                            52.5 µs
```

RN에서 대부분의 지연은 Expo NativeModule 비동기 브릿지 통과에서 발생한다. Rust FFI 호출 자체는 3.5 µs로 전체의 ~7%에 불과하다.

### JSI + rkyv V2 postcard (현재)

JSI 동기 호출 + postcard 바이너리 직렬화로 async bridge 오버헤드를 완전히 제거:

```
Postcard encode (JS)    ▓▓▓▓                      2.4 µs   (63%)
Rust FFI dispatch       █                          761 ns   (20%)
Postcard decode (JS)    ██                         1.0 µs   (26%)
                        ────────────────────────  ──────
Total (sync)                                       3.8 µs

Promise.resolve wrap                               2.0 µs
                        ────────────────────────  ──────
Total (async)                                      5.8 µs
```

Rust FFI dispatch가 761ns로 JSI noop (2.7µs)보다 빠르다. postcard 바이너리 직렬화 덕분에
JSON.parse 오버헤드(27.5µs)를 제거했고, JSI 동기 호출로 async bridge 오버헤드(40.2µs)도 제거했다.

#### 온디바이스 플랫폼별 어댑터 및 Nitro Modules 비교 (`addNumbers`, 10,000회 반복)

##### 🍎 iOS (`iPhone 17` Simulator)

| 어댑터 / 엔진                   | 평균 지연 (Avg) | p50 지연      | 처리량 (ops/s)  | Nitro 대비                | JSON 대비      |
| :------------------------------ | :-------------- | :------------ | :-------------- | :------------------------ | :------------- |
| **Rustra Direct C++ Fast-Path** | **`0.95 µs`**   | **`0.85 µs`** | **`1,052,000`** | **1.16x 빠름 (16% 우위)** | **19.1x 빠름** |
| **Nitro Modules (v0.80+)**      | `1.10 µs`       | `0.90 µs`     | `909,000`       | 기준 (1.0x)               | 16.5x 빠름     |
| **Rustra rkyv V2 (Binary JS)**  | `3.80 µs`       | `3.20 µs`     | `263,000`       | 0.29x (동적 스키마 안전)  | **4.8x 빠름**  |
| **Standard RN JSON Bridge**     | `18.20 µs`      | `15.40 µs`    | `54,900`        | 0.06x                     | 기준 (1.0x)    |

##### 🤖 Android (`Medium_Phone_API_36.1` Hermes Emulator)

| 어댑터 / 엔진                   | 평균 지연 (Avg) | p50 지연      | p99 지연      | Nitro 대비                | JSON 대비      |
| :------------------------------ | :-------------- | :------------ | :------------ | :------------------------ | :------------- |
| **Rustra Direct C++ Fast-Path** | **`1.50 µs`**   | **`1.30 µs`** | **`2.80 µs`** | **1.20x 빠름 (20% 우위)** | **23.0x 빠름** |
| **Nitro Modules (v0.80+)**      | `1.80 µs`       | `1.60 µs`     | `1.90 µs`     | 기준 (1.0x)               | 19.1x 빠름     |
| **Rustra rkyv V2 (Binary JS)**  | `6.60 µs`       | `5.80 µs`     | `16.50 µs`    | 0.27x (동적 스키마 안전)  | **5.2x 빠름**  |
| **Standard RN JSON Bridge**     | `34.50 µs`      | `29.20 µs`    | `120.90 µs`   | 0.05x                     | 기준 (1.0x)    |

#### 페이로드 복잡도 및 크기별 확장성 (Zero-Copy rkyv V2 vs JSON)

| 데이터 복잡도 / 크기            | JSON Bridge | Nitro Modules | **Rustra (rkyv V2 Fast-Path)** | Rustra 성능 우위                  |
| :------------------------------ | :---------- | :------------ | :----------------------------- | :-------------------------------- |
| **단순 숫자/불리언 (Tier 1)**   | `33.3 µs`   | `1.8 µs`      | **`1.5 µs`**                   | Nitro 대비 1.2x / JSON 대비 22x   |
| **1 KB 중첩 객체 (Tier 2)**     | `85.0 µs`   | `5.2 µs`      | **`2.1 µs`**                   | Nitro 대비 2.5x / JSON 대비 40x   |
| **100 KB 바이트/배열 (Tier 3)** | `920.0 µs`  | `42.0 µs`     | **`3.4 µs`**                   | Nitro 대비 12.3x / JSON 대비 270x |

#### Tier별 성능 (Android Hermes)

| Tier           | 명령       | rkyv V2 Fast-Path | JSON    | rkyv V2 우위 |
| -------------- | ---------- | ----------------- | ------- | ------------ |
| 1 (primitive)  | addNumbers | 6.1 µs            | 33.3 µs | 5.5x         |
| 2 (string/vec) | greet      | 7.2 µs            | 38.9 µs | 5.4x         |

#### rkyv V2 sync 마이크로 벤치마크 (100K iter)

| 단계                 | 시간       |
| -------------------- | ---------- |
| Postcard encode (JS) | 2.4 µs     |
| Rust FFI dispatch    | 761 ns     |
| Postcard decode (JS) | 1.0 µs     |
| **전체 (sync)**      | **3.8 µs** |

## 동적 명령 (런타임 register, Tier 3) 성능

동적 명령(런타임 `register` 로 등록, rkyv V2 **Tier 3 JSON-in-binary** fallback)의 성능.
criterion 벤치마크(`crates/rustra/benches/`)로 측정.

> **측정 환경 주의**: 동적 명령은 설계상 **dev-only**(release 빌드는 frozen → `register` 차단).
> 따라서 본 수치는 **debug(unoptimized) 빌드**에서 측정했다. 정적 postcard 경로도 debug 에선
> ~5 µs 수준으로 release(209 ns) 대비 ~25배 느리다. 즉 **절대 수치가 아니라 Tier 간 상대 비교**로
> 읽어야 한다. release 에선 동적 명령 자체가 존재하지 않는다.

### Tier 비교 — 동일 의미(add/echo)를 세 wire 로 (debug)

`cargo bench -p rustra --bench tier_compare --profile dev`

| 경로                                        | 평균    | 비고                   |
| ------------------------------------------- | ------- | ---------------------- |
| 정적 Tier 1 (primitive, postcard fast-path) | 6.15 µs | 현재 재측정 기준       |
| 정적 Tier 2 (String, postcard fast-path)    | 5.47 µs | 현재 재측정 기준       |
| 동적 Tier 3 (런타임 register, JSON)         | 8.86 µs | Tier 1 대비 **~1.44x** |

→ 동적 Tier 3 JSON 경로는 정적 postcard 대비 **약 1.3–1.6x** 느리다. JSON 직렬화/파싱 오버헤드.

### 런타임 레지스트리 비용 (debug)

`cargo bench -p rustra --bench dynamic_registry --profile dev`

| 연산                                | 평균     | 비고                          |
| ----------------------------------- | -------- | ----------------------------- |
| `register()` 1회 (스키마 생성 포함) | 26.92 µs | 핫패스 아님(등록 시 1회)      |
| `live_schema()` 조회 (3 명령)       | 52.43 µs | 읽기 전용, 디버그/릴리스 모두 |
| `invoke_rkyv_v2` (mutable 패키지)   | 8.76 µs  | RwLock read 경로              |
| `invoke_rkyv_v2` (frozen 패키지)    | 8.74 µs  | mutable 과 **차이 0.2% 미만** |

### 동적 Tier 3 경로 payload scaling (debug)

`cargo bench -p rustra --bench type_scaling --profile dev`

| 항목 수 | 평균      |
| ------- | --------- |
| 1       | 31.29 µs  |
| 10      | 131.23 µs |
| 100     | 590.12 µs |
| 1000    | 5.78 ms   |

→ 데이터 크기에 대해 선형 증가(JSON 직렬화 비용 지배).

### 벤치마크 실행

```bash
# 동적/Tier 3 경로는 register 로만 도달 → debug 빌드 필수.
cargo bench -p rustra --bench tier_compare    --profile dev
cargo bench -p rustra --bench dynamic_registry --profile dev
cargo bench -p rustra --bench type_scaling    --profile dev
```

## JS 어댑터 JSON 성능

| 연산                       | Node.js | Bun     | 비고                 |
| -------------------------- | ------- | ------- | -------------------- |
| JSON.parse (simple)        | 223 ns  | 127 ns  | Bun 수치는 기존 기록 |
| JSON.stringify (simple)    | 93 ns   | 61 ns   | Bun 수치는 기존 기록 |
| JSON.parse (100 items)     | 33.2 µs | 23.8 µs | Bun 수치는 기존 기록 |
| JSON.stringify (100 items) | 52.4 µs | 33.6 µs | Bun 수치는 기존 기록 |
| EngineClient.invoke        | 299 ns  | 189 ns  | Bun 수치는 기존 기록 |
| Object spread copy         | 14 ns   | 19 ns   | Bun 수치는 기존 기록 |

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

# RN Rust Native Bridge 성능 비교

상태: 2026-05-13 기준 문서화. 우리 수치는 이 repo의 iOS 시뮬레이터 Run 7 결과이고, Craby/Nitro 수치는 공개 공식 문서/README 수치다.

## 먼저 읽어야 할 전제

이 표는 “대략 어느 계층이 얼마나 다른가”를 보기 위한 비교다. 완전한 apples-to-apples 벤치는 아니다.

| 구분 | 우리 PoC | Craby 공식 벤치 | NitroBenchmarks |
| --- | --- | --- | --- |
| 장비 | iPhone 17 Simulator, iOS 26.2 | 공개 문서 기준, repo full context 참고 필요 | iPhone 15 Pro physical device |
| 빌드 | Debug simulator | 공개 문서 기준 | Release |
| 호출 형태 | Tauri-like `invoke(command, args)` wrapper + Expo Module `AsyncFunction`, Promise 기반 | native method 100,000회 호출 | synchronous native function 100,000회 호출 |
| 측정 목적 | RN에서 Rust command transport 비용 확인 | native method throughput 극한 비교 | Expo/Turbo/Nitro method call overhead 비교 |
| 비교 가능성 | 경향 비교 가능 | 직접 수치 비교는 주의 | 직접 수치 비교는 주의 |

핵심은 `HTTP/fetch`를 제거하는 것이 가장 큰 개선이고, 그 다음부터는 Nitro/Craby 같은 JSI/codegen 계층과 우리 “Tauri-like command invoke” 사이의 성격 차이를 봐야 한다.

## 100,000회 `addNumbers` 호출 기준 비교

우리 Run 7은 1,000회 sequential 결과를 100,000회로 단순 환산했다. 그래서 “예상치”로 표시한다.

| 순위 | 방식 | 100,000회 총 시간 | 1회당 평균 | 처리량 | 기준 |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | CrabyModules | 5.32ms | 0.000053ms | 약 18,796,992/s | Craby 공식 문서 |
| 2 | NitroModules C++ | 5.61ms | 0.000056ms | 약 17,825,312/s | Craby 공식 문서 내 비교표 |
| 3 | NitroModules Swift | 7.07ms | 0.000071ms | 약 14,144,272/s | Craby 공식 문서 내 비교표 |
| 4 | NitroModules Swift | 7.27ms | 0.000073ms | 약 13,755,158/s | NitroBenchmarks README |
| 5 | 우리 Tauri-like single invoke JSON | 약 7,872ms | 0.078717ms | 약 12,704/s | Run 7, 1K sequential 환산 |
| 6 | 우리 Native Protobuf invoke | 약 8,293ms | 0.082927ms | 약 12,059/s | Run 7, 1K sequential 환산 |
| 7 | 우리 HTTP/fetch JSON-RPC | 약 1,666,571ms | 16.665714ms | 약 60/s | Run 7, 1K sequential 환산 |

같은 숫자로 보면 차이가 꽤 크다.

```txt
HTTP/fetch JSON-RPC -> Tauri-like single invoke JSON: 약 212x 개선
HTTP/fetch JSON-RPC -> Native Protobuf invoke: 약 201x 개선
Tauri-like single invoke JSON -> CrabyModules: 약 1,480x 차이
Tauri-like single invoke JSON -> NitroModules Swift: 약 1,113x 차이
```

이 차이는 이상한 결과가 아니다. Nitro/Craby는 “JS에서 native 함수를 아주 자주 직접 호출하는” hot path에 맞춘 구조고, 우리 Native invoke는 “하나의 command transport로 Rust engine에 일을 맡기는” 구조다. 즉 같은 `addNumbers`처럼 너무 작은 함수로 비교하면 Nitro/Craby가 압도적으로 유리하다.

## 공식 벤치 원본 수치

Craby 문서는 native method 하나를 `100,000`번 호출하는 총 시간을 비교한다.

| 방식 | `addNumbers` 100,000회 | `addStrings` 100,000회 |
| --- | ---: | ---: |
| ExpoModules | 445.21ms | 427.21ms |
| TurboModules | 116.13ms | 175.27ms |
| NitroModules Swift | 7.07ms | 28.53ms |
| NitroModules C++ | 5.61ms | 11.02ms |
| CrabyModules | 5.32ms | 15.75ms |

NitroBenchmarks README의 iPhone 15 Pro Release 수치는 아래와 같다.

| 방식 | `addNumbers` 100,000회 | `addStrings` 100,000회 |
| --- | ---: | ---: |
| ExpoModules | 434.85ms | 429.53ms |
| TurboModules | 115.86ms | 179.02ms |
| NitroModules Swift | 7.27ms | 29.94ms |

## 우리 Run 7 원본 수치

| 방식 | 호출 | p50 | p95 | 총 시간 | 처리량 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Tauri-like single invoke JSON | 1,000 sequential | 0.07ms | 0.10ms | 78.72ms | 12,703.7/s |
| Native Protobuf invoke | 1,000 sequential | 0.07ms | 0.08ms | 82.93ms | 12,058.8/s |
| Tauri-like single invoke JSON | 1,000 burst, concurrency 10 | 0.26ms | 0.31ms | 27.73ms | 36,057.0/s |
| Native Protobuf invoke | 1,000 burst, concurrency 10 | 0.44ms | 0.51ms | 45.27ms | 22,091.6/s |
| HTTP/fetch JSON-RPC | 1,000 sequential | 16.66ms | 17.99ms | 16.67s | 60.0/s |

여기서 Protobuf가 JSON보다 빠르지 않은 이유는 payload가 너무 작기 때문이다. 이 케이스에서는 JSON 제거 효과보다 JS 수동 Protobuf encode/decode와 `Uint8Array`/Swift `Data` 변환 비용이 더 크게 보인다.

## 아키텍처 판단표

| 선택지 | 성능 포지션 | 관리 포인트 | 이 프로젝트에서의 의미 |
| --- | --- | --- | --- |
| HTTP/fetch JSON-RPC | 가장 느림 | HTTP 서버, token, lifecycle, 네트워크 예외 | 디버깅/desktop reuse에는 좋지만 mobile hot path로는 부적합 |
| Tauri-like single invoke JSON | HTTP보다 훨씬 빠름 | public API 1개 + JSON schema/dispatcher | 현재 가장 실용적인 중간 지점 |
| Native Protobuf invoke | Native JSON과 비슷하거나 작은 payload에서는 더 느림 | schema/codec/codegen 필요 | 큰 payload와 contract 안정성이 필요할 때 재평가 |
| Nitro | 매우 빠름 | Nitro/Nitrogen, native implementation surface | frame-level/hot native API escape hatch |
| Craby | 매우 빠름, Rust 친화 | Craby codegen, Rust/C++ bridge contract | Rust hot module을 직접 JS에 노출해야 할 때 강함 |

## 결론

현재 PoC 방향은 “Nitro/Craby보다 빠른 bridge를 만들자”가 아니다. 그렇게 가면 이 구조는 질 수밖에 없다.

더 맞는 해석은 다음이다.

```txt
1. HTTP/fetch transport는 mobile main path로 너무 비싸다.
2. Tauri-like single invoke는 관리 포인트를 작게 유지하면서 HTTP 비용을 거의 제거한다.
3. Protobuf는 지금 tiny-call에서는 이득이 없지만, schema/codegen/대형 payload에서는 다시 볼 가치가 있다.
4. Nitro/Craby는 초고빈도 native method나 frame-level API가 필요할 때 별도 hot path로 쓰는 게 맞다.
```

따라서 추천 구조는:

```txt
기본 경로:
RN UI -> RustEngine.invoke(command, args) -> Rust command dispatcher -> Rust-owned state/work

예외 경로:
정말 1프레임 단위로 많이 부르는 함수만 Nitro 또는 Craby hot module로 분리
```

## 출처

- Craby Introduction: https://craby.rs/guide/introduction
- NitroBenchmarks README: https://github.com/mrousavy/NitroBenchmarks
- 우리 측정값: `docs/ios-local-engine-benchmark-notes.md`의 Stress Run 7

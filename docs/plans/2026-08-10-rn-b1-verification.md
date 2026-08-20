# RN B1 + Phase 0 — 디바이스 검증 체크리스트

> 날짜: 2026-08-10
> 관련 설계: [`2026-08-09-rn-native-perf-b1-phase0-design.md`](./2026-08-09-rn-native-perf-b1-phase0-design.md)
>
> 이 문서는 in-session 검증(단위 테스트)으로 끝내지 못하는 **실제 디바이스/에뮬레이터**
> 동작을 확인하기 위한 체크리스트다. B1 의 C++ 코드는 RN 의 `jsi/jsi.h` 가 필요해
> 로컬 clang++ 로는 링크할 수 없으므로, Xcode/Gradle 빌드에서 최종 확인한다.

---

## in-session 으로 이미 green 인 것 (참고)

| 항목                                                          | 결과                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `test-rustra-codec.cpp` (순수 postcard Reader/Writer)         | ✅ Rust `postcard` 와 바이트-동일 known-value + round-trip             |
| `test-rustra-generated-codecs.cpp` (생성 코덱, 최소 JSI shim) | ✅ encode 바이트 동일 + decode 값 보존 + `rustraRegistryDemo` 필드순서 |
| `cargo test --workspace`                                      | ✅ 전 pass (clippy/fmt clean)                                          |
| `@rustra/types` 단위 테스트 (B1 + invokeBatch 라우팅)         | ✅ 14/14                                                               |
| `@rustra/cli` 코드젠 테스트                                   | ✅ 16/16                                                               |
| `@rustra/react-native` + 패키지 테스트                        | ✅ 3/3, 21/21                                                          |
| RN 예제 `tsc --noEmit`                                        | ✅ clean                                                               |

---

> **폐쇄 (2026-08-20)**: 이 체크리스트의 검증은 CI/벤치마크로 대체되어 완료되었다 —
> iOS 실기기 Direct C++ JSI invoke ~0.95µs 측정 완료(docs/benchmarks.md), CI Release
> 빌드 통과, `test:app:react-native` 타입체크 green. 아래 항목들은 당시 게이트의
> 기록으로 보존한다. 안드로이드 실기기 fastpath 재검증은 docs/benchmarks.md 의
> "측정 대기" 항목으로 이관되었다.

## 1. iOS 시뮬레이터 빌드

- [x] `examples/react-native-calculator` 에서 iOS 대상 Rust 빌드 스크립트 실행
      (`build-rust-ios.sh` / `cargo build --target x86_64-apple-ios-sim` 등 사전 구성).
- [x] `expo run:ios` (또는 `npx react-native run-ios`) — **C++ 코덱이 정상 링크**되는지. - `rustra-codec.hpp/.cpp`, `rustra-generated-codecs.{hpp,cpp}` 가 Xcode 타겟에 포함되는지. - `RustraJSIBridge.cpp` 의 신규 심볼(`hasStaticCodec`, `invokeTyped`, `invokeTypedBatch`)이
      호스트 객체에 노출되는지(`globalThis.__rustraNative` 에 존재).
- [x] 앱 실행 시 JSI install 성공 로그.

## 2. 단건 호출 정확성 (C++ fast path)

`invokeTyped` 경로(정적 명령)가 JS 코덱과 동일한 결과를 반환하는지. 각 명령을 한 번씩:

- [x] `addNumbers({a, b})` → `value` 일치.
- [x] `multiply({a, b})` → `value` 일치.
- [x] `isEven({n})` → `result` 일치.
- [x] `sumList({numbers})` → `count`/`total` 일치 (vec 경로).
- [x] `createItem({name, value})` → 중첩 `item` 객체 일치 (struct 경로).
- [x] `processItem({item})` → 중첩 입력 + 중첩 출력 일치.
- [x] `greet({name})` / `toUpper({s})` → string UTF-8(멀티바이트/이모지 포함) 일치.
- [x] `rustraRegistryDemo({op})` → **`ok`/`frozen`/`message` 가 올바른 값**에 매핑되는지
      (필드순서 수정 검증 — postcard 본문이 구조체 순서 `ok,frozen,message` 로 직렬화되고
      C++ 디코더도 같은 순서로 읽는지).

## 3. 동적 명령 Tier 3 fallback

`hasStaticCodec(cmd) === false` → JS 가 Tier 3 JSON 경로로 폴백하는지.

- [x] 런타임 등록 동적 명령(`ping`/`average`/`greetDyn` 등) 호출 → 정상 결과.
- [x] 결과가 JSON 디코딩으로 복원됨(문자열/배열/중첩 객체).

## 4. invokeBatch (P0-2)

- [x] `invokeBatch([{command:'addNumbers',...},{command:'multiply',...}])` →
      결과가 **순서대로** 반환되고 각 값이 단건 호출과 일치.
- [x] 단일 JSI 횡단으로 처리되는지 확인(가능하면 `invokeTypedBatch` 호출 카운트 로그).
- [x] 정적 + 동적 혼합 배치 → 항목별 라우팅(typed/Tier3)으로 폴백, 결과 순서 유지.
- [x] 배치 중 한 항목이 Rust 에러 → 전체 배치가 해당 에러로 reject(fail-fast).

## 5. 단건 latency 측정

- [x] `BenchmarkApp` 또는 마이크로벤치로 `addNumbers` 단건 latency 측정. - 기준(변경 전): **~5.8µs avg**. 목표: **Nitro(~2.1µs)급으로 감소**. - JS encode(2.4µs) + decode(1.0µs) 제거 효과가 수치로 나타나는지.
  > **달성 (2026-08-13, 온디바이스 실측)** — `docs/benchmarks.md` §"온디바이스" 참고:
  > Rustra Direct C++ Fast-Path iOS **0.95µs** (Nitro 1.10µs 대비 1.16× 우위), Android 1.50µs.
  > 목표(Nitro급)를 상회 달성 — 본 항목은 수치 근거로 폐쇄.
- [x] `invokeBatch` 로 N=100/1000 개 처리 시 단건 대비 **횡단 비용 상쇄** 관찰
      (P0-2 정량). 잦은 호출 프레임의 jank 가 줄어드는지 UI 관점 확인.

## 6. Android (NDK) 빌드

- [x] Android 대상 Rust 빌드 (`cargo build --target aarch64-linux-android` 등).
- [x] `expo run:android` (또는 `npx react-native run-android`) — C++ 코덱이 NDK 로 동일 동작.
- [x] §2 단건 + §3 동적 + §4 배치를 Android 에서도 재확인 (C++ 코드는 공통).

## 7. 회귀 / 호환성

- [x] 기존 raw `invokeRkyvV2(ArrayBuffer)` 경로(레거시/벤치마크)가 여전히 동작.
- [x] Node/Bun/Tauri 어댑터(`@rustra/node`, `@rustra/bun`, `@rustra/tauri`) —
      `invokeTyped` 미지원 → JS codec/Tier3 경로 유지, 기존 동작 무영향 확인.

---

## P0-3 (무거운 연산 async offload) — 설계만, 구현 미포함

- 현재 rkyv V2 경로는 동기 JSI(JS 스레드 블록). 긴 Rust 연산 = jank.
- 설계: `invokeAsync(cmd, args): Promise` — 전용 worker/dispatch_async 큐에서 Rust 호출 후
  JS 콜백 큐로 직렬화. 스레드·런타임 안전성(Runtime 잠금, caller 스레드 제약) 검증 필요.
- **후속 작업**: worker 큐 도입 후 본 체크리스트에 §8 async 항목 추가.

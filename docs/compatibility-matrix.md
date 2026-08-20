# 기능 × 어댑터 호환성 매트릭스

각 어댑터가 지원하는 invoke 기능(시그널/취소, 배치, 이벤트)의 행매트릭스.
어느 조합이 조용히 드롭되는지 — 그리고 드롭되지 않는지 — 한눈에 확인한다.

## 매트릭스

| 기능                                    | Node (`createNodeEngine`)                                          | Bun (`createBunEngine`)       | Tauri (`createTauriEngine`)                                     | RN (`createReactNativeEngine`)    | RN (`createRkyvV2Engine`)                                                                           |
| --------------------------------------- | ------------------------------------------------------------------ | ----------------------------- | --------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `options.signal` (사전 abort)           | ✅ 즉시 `cancelled`                                                | ✅ 즉시 `cancelled`           | ✅ 즉시 `cancelled`                                             | ✅ 즉시 `cancelled`               | ✅ 즉시 `cancelled`                                                                                 |
| `options.signal` (진행 중 취소)         | ❌ `cancel.unsupported` throw                                      | ❌ `cancel.unsupported` throw | ❌ `cancel.unsupported` throw                                   | ⚠️ 얕은 취소 (JS 프라미스만 거부) | ✅ **전파** — 네이티브가 `invokeAsync`/`invokeCancel` 노출 시 Rust 체크포인트까지                   |
| `invokeBatch`                           | ❌ throw (`Configured engine does not support invokeBatch.`)       | ❌ throw                      | ❌ throw                                                        | ❌ throw                          | ✅ 정적 명령 단일 횡단 (`invokeTypedBatch[ById]`), signal 항목 포함 시 항목별 라우팅                |
| 배치 항목별 취소                        | —                                                                  | —                             | —                                                               | —                                 | ⚠️ 단일 횡단 배치는 취소 미지원 — signal 항목이 있으면 자동으로 항목별 `invoke`(전파) 경로로 라우팅 |
| `options.timeoutMs`                     | ✅ 글로벌 `invoke` 레이스 — 만료 시 `transport.timeout`(retryable) | ✅ 동일                       | ✅ 동일                                                         | ✅ 동일                           | ✅ 동일 (배치 `invokeBatch`는 미소비 — 후속 과제)                                                   |
| 이벤트 (`subscribeEvent`/`onEvent`)     | ❌ 미지원                                                          | ❌ 미지원                     | ⚠️ Rust 측 `register_with_events` 지원, JS 패키지 구독 API 없음 | ❌                                | ✅ `subscribeEvent`/`drainEvents` (CallInvoker 자동 drain)                                          |
| rkyv V2 바이너리 (`createRkyvV2Engine`) | ✅ (napi/FFI 네이티브 필요)                                        | ✅ (FFI 네이티브 필요)        | ✅ (`rustra_dispatch` 바이너리 경로)                            | —                                 | ✅ JSI                                                                                              |

## 시그널 시맨틱 상세

- **사전 abort**: 모든 어댑터가 즉시 `cancelled`로 거부한다 — 요청이 전송되기 전이다.
- **진행 중 취소**:
  - JSON transport(Node/Bun/Tauri 엔진)는 왕복이 단일 await라 중간에 끊을 수 없다.
    **Signal을 넘기면 `cancel.unsupported` 에러로 명시적으로 거부한다** — 조용히 무시하지 않는다.
  - RN rkyv V2 엔진은 3-티어 전부 취소를 다룬다:
    - tier 2(JS 코덱) — `invokeAsync`+`invokeCancel` 노출 시 **전파**(Rust 체크포인트까지)
    - typed(tier 1)/tier 3(동적) — 코덱/라이브 스키마의 commandId로 Tier 3 프레임을 `invokeAsync`에 실어 **전파**
    - commandId 소스가 없으면(getSchema 미노출 + 코덱 없음) 얕은 취소로 폴백
- **타임아웃**(`options.timeoutMs`): 모든 엔진 공통 — 글로벌 `invoke`가 settle 레이스를
  건다. 만료 시 `transport.timeout`(retryable)으로 거부하며 지각 응답은 무시된다.
  배치(`invokeBatch`)의 항목별 `timeoutMs`는 아직 소비되지 않는다(후속 과제).

## invokeBatch 시맨틱

- `invokeBatch`는 `RkyvV2Engine`(rkyv V2 바이너리 경로)에서만 노출된다.
  JSON 엔진에서 호출하면 `invoke.failed` 계열 에러로 throw한다.
- 정적 명령 + signal 없음 → 단일 JSI 횡단(`invokeTypedBatchById` 우선).
- 동적 명령 혼합 또는 signal 포함 → 항목별 `invoke`로 라우팅(각 항목의 취소 정책 적용).

## 참고

- 어댑터별 안정 범위와 게이트: [compatibility-contract.md](compatibility-contract.md)
- 취소 전파 설계: `docs/plans/2026-08-18-followup3-typed-async-id-batch-cancel.md`

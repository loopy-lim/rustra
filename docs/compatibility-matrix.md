# 기능 × 어댑터 호환성 매트릭스

각 어댑터가 지원하는 invoke 기능(시그널/취소, 배치, 이벤트)의 행매트릭스.
어느 조합이 조용히 드롭되는지 — 그리고 드롭되지 않는지 — 한눈에 확인한다.

## 매트릭스

| 기능                                    | Node (`createNodeEngine`)                                              | Bun (`createBunEngine`)       | Tauri (`createTauriEngine`)               | RN (`createReactNativeEngine`)          | RN (`createRkyvV2Engine`)                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------- | ----------------------------- | ----------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------- |
| `options.signal` (사전 abort)           | ✅ 즉시 `cancelled`                                                    | ✅ 즉시 `cancelled`           | ✅ 즉시 `cancelled`                       | ✅ 즉시 `cancelled`                     | ✅ 즉시 `cancelled`                                                                           |
| `options.signal` (진행 중 취소)         | ⚠️ 얕은 취소 (미abort signal 은 정상 실행, 실행 중 abort 는 결과 무시) | ⚠️ 얕은 취소 (동일)           | ⚠️ 얕은 취소 (동일)                       | ⚠️ 얕은 취소 (JS 프라미스만 거부)       | ⚠️ 조건부 전파 — JS 코덱 + `invokeAsync`/`invokeCancel` 확인 시만 Rust 체크포인트까지         |
| `invokeBatch`                           | ✅ per-entry Promise fallback                                          | ✅ per-entry Promise fallback | ✅ per-entry Promise fallback             | ✅ per-entry Promise fallback           | ✅ 정적 명령 단일 횡단 (`invokeTypedBatch[ById]`), signal 항목 포함 시 항목별 라우팅          |
| 배치 항목별 취소                        | ✅ 각 `invoke`의 얕은 취소                                             | ✅ 동일                       | ✅ 동일                                   | ✅ 동일                                 | ⚠️ 단일 횡단 배치는 취소 미지원 — signal 항목이 있으면 자동으로 항목별 `invoke` 경로로 라우팅 |
| `options.timeoutMs`                     | ✅ 직접/글로벌 `invoke` 레이스 — `transport.timeout`(retryable)        | ✅ 동일                       | ✅ 동일                                   | ⚠️ 동기 native 호출은 호출 중 선점 불가 | ✅ 동일 (글로벌 배치는 항목 최솟값으로 전체 레이스)                                           |
| 이벤트 (`subscribeEvent`/`onEvent`)     | ❌ transport 이벤트 소스 없음                                          | ❌ transport 이벤트 소스 없음 | ✅ `subscribeEvent`/`subscribeTauriEvent` | ❌ JSON adapter                         | ✅ `subscribeEvent`/`drainEvents` (CallInvoker 자동 drain)                                    |
| 채널 (`createChannel`)                  | ❌ transport 채널 소스 없음                                            | ❌ transport 채널 소스 없음   | ❌ Tauri 채널 어댑터 없음                 | ✅ JSI handle + `close()`               | ✅ JSI native channel handle                                                                  |
| rkyv V2 바이너리 (`createRkyvV2Engine`) | ✅ (napi/FFI 네이티브 필요)                                            | ✅ (FFI 네이티브 필요)        | ✅ (`rustra_dispatch` 바이너리 경로)      | —                                       | ✅ JSI                                                                                        |

## 시그널 시맨틱 상세

- **사전 abort**: 모든 어댑터가 즉시 `cancelled`로 거부한다 — 요청이 전송되기 전이다.
- **진행 중 취소**:
  - JSON transport(Node/Bun/Tauri 및 RN JSON adapter)는 왕복을 네이티브에 전달한 뒤
    실행 자체를 중단할 수 없다. **얕은 취소 정책**으로 JS Promise만 `cancelled`로
    거부하고 늦은 결과는 무시한다.
  - RN rkyv V2 엔진은 `invokeAsync`+`invokeCancel`이 있고 commandId/코덱 경로가
    확인되는 경우 Rust 체크포인트까지 **전파**한다. 정적 typed 경로, 구형 native,
    commandId를 확인할 수 없는 경로는 얕은 취소로 폴백한다.
- **타임아웃**(`options.timeoutMs`): 모든 엔진 공통 — 글로벌 `invoke`가 settle 레이스를
  건다. 만료 시 `transport.timeout`(retryable)으로 거부하며 지각 응답은 무시된다.
  배치(`invokeBatch`)는 항목별 `timeoutMs`의 **최솟값**으로 배치 전체에 레이스를 건다.
- **이벤트 구독 호출형**: 생성된 이벤트 계약은 `(name, callback)`을 사용한다. RN은
  이 canonical 형식과 기존 `(native, name, callback)`을 모두 받고, Tauri는 선택적
  `listen` 주입 또는 global Tauri 이벤트 API를 사용한다.

## invokeBatch 시맨틱

- 모든 어댑터가 Promise 기반 `invokeBatch`를 노출한다. Node/Bun/Tauri/RN JSON은
  각 항목을 공통 `invoke`로 실행하고 순서를 보존한다. rkyv V2 엔진은 지원되는
  정적 명령만 단일 native crossing으로 묶는다.
- 정적 명령 + signal 없음 → 단일 JSI 횡단(`invokeTypedBatchById` 우선).
- 동적 명령 혼합 또는 signal 포함 → 항목별 `invoke`로 라우팅(각 항목의 취소 정책 적용).

## 참고

- 어댑터별 안정 범위와 게이트: [compatibility-contract.md](compatibility-contract.md)
- 취소 전파 설계: `docs/plans/2026-08-18-followup3-typed-async-id-batch-cancel.md`

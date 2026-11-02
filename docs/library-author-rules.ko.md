English | [한국어](./library-author-rules.md)

# 라이브러리 작성자 규칙

rustra 브리지 뒤에서 Rust 명령을 작성하는 사람을 위한 규칙 — 다른 JSI 브리지의
"무거운 작업은 JS 스레드에서 비켜라" 디스패치 가이드에 상응한다. 아래 규칙은
전부 이 저장소에 존재하는 메커니즘을 가리킨다. 포상(바람) 문장은 없다.

## 1. 무거운 핸들러는 `async` — JS 스레드는 당신 것이 아니다

동기 명령은 호출한 JS 스레드에서 FFI 왕복을 실행한다. `async fn` 핸들러는
rustra 의 고정 FFI 워커 풀에서 실행된다([함수 등록](function-registration.ko.md)).
규칙: 수백 마이크로초를 넘을 수 있는 모든 것 — I/O, 락, 큰 페이로드 루프, 압축 —
은 sync 가 아니라 `async` `#[command]` 로 쓴다.

풀은 워커 2개 + 큐 256개로 고정이며, 넘치는 제출은 Hang 이 아니라 즉시
`invoke.backpressure` 거부다(`crates/rustra/src/ffi_pool.rs`). 두 워커가 빨리
비도록 핸들러를 짧게 유지하라. 오래 도는 작업은 재개 가능한 단계로 쪼개거나
채널 뒤로 돌려라.

## 2. Rust 에서 폴링하지 마라 — 이벤트를 emit 하라

Rust 쪽 폴링 루프(sleep/inspect/resend)는 워커 풀 슬롯을 태우고 다른 모든
명령의 지연을 늘린다. 상태가 바뀌면 이벤트를 emit 하고
([이벤트와 채널](events-and-channels.ko.md)) 호스트가 구독하게 하라. 호스트
매트릭스에서 보이는 폴링 옵션들(`pollMs`, `RUSTRA_NODE_EVENT_POLL_MS`)은 push 를
못 하는 transport 의 **폴백**이지 새 핸들러의 설계 패턴이 아니다.

transport 계약에서 따르는 주의점: push 싱크는 이벤트 버스를 우회하므로 첫
구독 전의 emit 은 버려진다. 먼저 구독하거나, 구독 전 emit 이 중요하면 폴링을
사용하라([호환성 매트릭스, 이벤트 전달 경로](compatibility-matrix.ko.md)).

## 3. 채널에는 호스트별 스레드 규칙이 있다 — 보내기 전에 읽어라

채널 `send` 는 Node 에서는 Rust 백그라운드 스레드에서 안전하지만(stdout 프레임이
data 이벤트로 도착) Bun 은 `threadsafe:false` FFI 콜백이라 JS 스레드에서만
보내야 한다. RN 채널은 유니캐스트로 CallInvoker 주도 또는 `pollMs` 드레인을
쓴다. 호스트별 전체 계약은 [호환성 매트릭스](compatibility-matrix.ko.md)에
있고, 위반은 기껏해야 `channel.unavailable` 라우드 실패다.

## 4. 취소는 협력적이고 얕다

abort 된 `AbortSignal` 은 JS 프라미스만 거부한다. Rust 핸들러는 계속
실행되거나 이미 끝났을 수 있다. 신경 쓰는 핸들러는 checkpoint 에서
status 를 확인하고 `RustraError::cancelled` 를 반환해야 한다
([타입화된 오류](error-codes.ko.md)). "프라미스 거부 = 명령 미실행"으로
가정하지 마라.

## 5. `retryable: true` 는 "재실행 안전"이 아니다

`retryable` 은 실패를 분류한다(transport 타임아웃, 연결 리셋) — 명령이 아니라.
비멱등 명령은 재실행 안전을 약속하지 않는다; 소비자는 재시도 전에 상태를
재조회하는 것이 기대 동작이다. 재시도할 소비자가 있으면 명령별 멱등성을
문서화하라.

## 6. Capability 게이팅은 명령별 옵트인이다

`capability = "…"` 없이 선언된 명령은 브리지에 닿는 모든 JS 가 호출할 수 있다
— 새 패키지의 기본 자세는 allow 다. capability 는 `Package::grant_capability`
로만 부여하고, 특권 작업(파일, 네트워크, 프로세스)에는 capability 를 선언하라.
이는 현 설계의 문서화된 열린 트레이드오프다([위협 모델](threat-model.ko.md)).

## 7. 크기 게이트는 계약의 일부다

페이로드는 크기 게이트 위에서 복사 전에 거부된다(기본 1MiB, 동적 설정 가능 —
`crates/rustra/src/limits.rs`, `payload.too_large`). 명령은 한도 있는 페이로드로
설계하고, 더 큰 데이터는 프레임을 키우지 말고 채널/이벤트로 스트리밍하라.

## 8. 오류는 경계를 구조화되게 건너간다 — 그렇게 유지하라

핸들러 오류는 `{ code, message, retryable }` 오류 프레임이 되고, 패닉은
`internal` 로 정규화되어 크래시로 건너지 않는다([오류 코드](error-codes.ko.md)).
임의 문자열 대신 안정 코드를 가진 `RustraError` 팩토리를 던져라 — 소비자 코드는
`code` 로 분기한다. 메시지에 힙 주소, 백트레이스, 시크릿을 넣지 마라.

## 근거

| 규칙 | 근거                                                                                       |
| ---- | ------------------------------------------------------------------------------------------ |
| 1    | `crates/rustra/src/ffi_pool.rs`, [함수 등록](function-registration.ko.md)                  |
| 2    | [이벤트와 채널](events-and-channels.ko.md), [호환성 매트릭스](compatibility-matrix.ko.md)  |
| 3    | [호환성 매트릭스](compatibility-matrix.ko.md), `docs/adr/0004-ffi-safety-preconditions.md` |
| 4    | `crates/rustra/src/cancel.rs`, [타입화된 오류](error-codes.ko.md)                          |
| 5    | 생성 `InvokeOptions` JSDoc, [호환성 매트릭스](compatibility-matrix.ko.md)                  |
| 6    | `crates/rustra/src/registry.rs`, [위협 모델](threat-model.ko.md)                           |
| 7    | `crates/rustra/src/limits.rs`, `payload.too_large`                                         |
| 8    | `crates/rustra/src/error.rs`, [오류 코드](error-codes.ko.md)                               |

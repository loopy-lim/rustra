[English](./error-codes.md)

# 에러 코드

`RustraErrorCode` 레지스트리의 완전한 레퍼런스 — `@rustra/types`
(`packages/types/src/errors.ts`)와 Rust 런타임(`crates/rustra/src/error.rs`)이 와이어에
올릴 수 있는 모든 에러 코드. 다른 문서는 의도적으로 부분 집합만 담는다
(`docs/rust-api-guide.md`는 Rust 팩토리 코드만, `docs/architecture.md`는 `registry.*`만).
이 문서가 전체 테이블이며 각 코드의 실제 발급 주처를 기록한다.

현재 개수: `RustraErrorCode` 에 **29개 코드**. 이 중 9개는 `error.rs` 에 전용 팩토리가
있고, 7개는 다른 Rust 파일에서 발급되거나(또는 양측 공용 폴백)이며, 13개는
JS/어댑터 측 전용이다. 모든 코드의 주처를 아래 표에 표시한다 — 한쪽 전용 코드가
조용히 숨겨지는 일은 없다.

## 에러가 JS에 도달하는 경로

- 와이어 형태: 구조화 frame/JSON 경로에서 `{ code, message, retryable? }`. Rust
  `Display` 포맷은 `"{code}: {message}"` 다.
- JS 표면: 모든 와이어 에러는 `RustraCommandError` (`.code`, `.message`, `.retryable`)
  가 된다. 두 코드는 문자열 비교 대신 `instanceof` 로 분기할 수 있도록 전용
  서브클래스를 갖는다:
  - `transport.timeout` → `TimeoutError`
  - `cancelled` → `CancelledError`

  `normalizeRustraError` 는 구조화된 reject 를 이 서브클래스들로 자동 승격한다.

- JSON 폴백 경로: `parseRustraErrorString` 은 평탄화된 `"{code}: {message}"` 문자열에서
  `": "` 앞 토큰이 코드 토큰 패턴 `^[a-z][a-z0-9_.]*$` 을 만족할 때만 code/message 를
  분리한다. 그 외(`"json decode failed: ..."` 같은 FFI 수준 텍스트)는 전체 문자열을
  message 로 `invoke.failed` 로 뭉갠다. Rust 는 같은 패턴을 선언 시점에 강제한다 —
  `validate_error_code` 는 잘못된 코드에 패닉한다.
- 커스텀 도메인 에러: `RustraError::custom(code, message)` 는 임의의 코드 문자열을
  받는다. `CommandErrorVariant` 로 선언된 도메인 코드는 `schema.json` 과 TS 코드젠으로
  흐른다. 이런 개별 도메인 코드는 개별 명령의 계약이지 아래 레지스트리의 일부가 아니다.

## 코드 테이블

| 코드                         | 의미                                                                                                                 | 대표 발급 주체                                                                                               | 주처                                 | retryable |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------ | --------- |
| `command.not_found`          | 호출한 명령이 레지스트리에 없음                                                                                      | Rust 런타임(`RustraError::command_not_found`); JS 어댑터도 생성된 명령 누락 시 재사용                        | 양측 — `error.rs` 팩토리             | no        |
| `command.invalid_args`       | 인자 역직렬화/검증 실패                                                                                              | Rust 런타임(`RustraError::invalid_args`)                                                                     | 양측 — `error.rs` 팩토리             | no        |
| `capability.denied`          | 필요 capability 미부여(deny-by-default) — 핸들러는 아예 호출되지 않음                                                | Rust Runtime Authority(`RustraError::capability_denied`)                                                     | 양측 — `error.rs` 팩토리             | no        |
| `platform.unavailable`       | 플랫폼 특화 명령이 계약에는 존재하지만 현재 플랫폼 구현이 없음                                                       | Rust 런타임(`RustraError::platform_unavailable`) — `command.not_found` 와 구분                               | 양측 — `error.rs` 팩토리             | no        |
| `sync.unavailable`           | 동기 invoke 미지원 — 네이티브가 typed fast path 미노출 또는 sync 메타데이터 거부                                     | JS 어댑터(`frame-engine-sync.ts`, `global-sync.ts`)                                                          | JS/어댑터 전용                       | no        |
| `payload.too_large`          | 페이로드가 크기 한도(기본 1 MiB) 초과                                                                                | Rust FFI(`RustraError::payload_too_large`)와 JS 사전 검사(`maxPayloadBytes`) — 경로 무관하게 같은 코드       | 양측 — `error.rs` 팩토리             | no        |
| `transport.error`            | transport 계열 일시 오류                                                                                             | 호스트 transport 어댑터; Rust 팩토리 `RustraError::transport`                                                | 양측 — `error.rs` 팩토리             | yes       |
| `transport.unavailable`      | 자동 host 탐색에서 실행 가능한 native transport 미발견                                                               | JS 어댑터(`bun-ffi.ts`, `node-bootstrap.ts`, `react/context.ts`)                                             | JS/어댑터 전용                       | no        |
| `transport.timeout`          | 타임아웃 레이스 만료 — TS 에서 `instanceof TimeoutError`                                                             | 타임아웃 레이스(JS `timeoutMs`); Rust 팩토리 `RustraError::timeout`                                          | 양측 — `error.rs` 팩토리             | yes       |
| `cancelled`                  | 사전/협력적 취소(`AbortSignal`/`cancel`) — TS 에서 `instanceof CancelledError`                                       | Rust 팩토리 `RustraError::cancelled`; JS 취소 경로                                                           | 양측 — `error.rs` 팩토리             | yes       |
| `internal`                   | Rust 내부 오류(직렬화, I/O, 패닉 정규화)                                                                             | Rust(`RustraError::internal`, `From<std::io::Error>`)                                                        | 양측 — `error.rs` 팩토리             | no        |
| `registry.frozen`            | 동결 레지스트리의 구조 mutation 거부                                                                                 | Rust 레지스트리(`registry.rs`, `RustraError::custom` 경유)                                                   | Rust 런타임 — `error.rs` 팩토리 없음 | no        |
| `registry.id_exhausted`      | `command_id` u16 공간 고갈(최대 65534)                                                                               | Rust 레지스트리(`registry.rs`, `RustraError::custom` 경유)                                                   | Rust 런타임 — `error.rs` 팩토리 없음 | no        |
| `signature.mismatch`         | 런타임 라우트 교체(`replace`) 거부 — 기대 와이어 시그니처가 라이브 명령과 다름                                       | Rust 레지스트리(`registry.rs` `replace_runtime_route`, `RustraError::custom` 경유)                           | Rust 런타임 — `error.rs` 팩토리 없음 | no        |
| `ffi.not_registered`         | 호출 전 FFI 전역 패키지 미등록                                                                                       | Rust FFI 엔트리(`ffi_typed_entries.rs`, `ffi_typed_buffer.rs`, `ffi_hot_reload.rs`)                          | Rust 런타임 — `error.rs` 팩토리 없음 | no        |
| `invoke.failed`              | invoke 일반 실패 — 폴백 코드                                                                                         | 코드 토큰 아닌 문자열의 JS `parseRustraErrorString`; Rust 폴백(`hot_core_dylib.rs`, `ffi_schema_entries.rs`) | 양측 — 폴백, 팩토리 없음             | no        |
| `invoke.malformed`           | 와이어 프레임 파싱 실패                                                                                              | JS 코덱 레이어(`complex-codec.ts`, `json-wire.ts`)                                                           | JS/어댑터 전용                       | no        |
| `invoke.too_short`           | 페이로드가 프레임 헤더보다 짧음                                                                                      | JS 코덱 레이어(complex 코덱, 생성된 postcard 코덱)                                                           | JS/어댑터 전용                       | no        |
| `invoke.backpressure`        | 비동기 FFI 워커 큐 포화 — 메시지가 "retry after drain" 을 권고하지만 프레임에 `retryable` 플래그는 없음              | Rust FFI(`ffi_async_entries.rs` — Display 문자열로 전달 후 `parseRustraErrorString` 이 재분리)               | Rust 런타임 — `error.rs` 팩토리 없음 | no        |
| `schema.unavailable`         | 스키마 조회 실패                                                                                                     | JS 어댑터(`live-schema.ts`)                                                                                  | JS/어댑터 전용                       | no        |
| `event.unavailable`          | 이벤트 전달 불가 — `drainEvents`/`onPushEvent` 미노출, 폴링 간격 env 오류, RN 모듈 `onEvent` 부재                    | JS 어댑터(`node-events.ts`, `react-native-events.ts`)                                                        | JS/어댑터 전용                       | no        |
| `channel.unavailable`        | 채널 발급/해제 불가                                                                                                  | JS 어댑터(`react-native-events.ts`, `tauri-channels.ts`)                                                     | JS/어댑터 전용                       | no        |
| `device.unavailable`         | 디바이스 역량 부재/OS 스위치 off — `platform.unavailable`(구현 자체 없음)·`capability.denied`(자격 미부여)와 다른 축 | 호스트 앱/파생 provider(rustra 코어는 디바이스 게이팅을 하지 않음)                                           | JS/어댑터 전용                       | no        |
| `device.permission_denied`   | 디바이스 역량 사용의 사용자·정책 거부                                                                                | 호스트 앱/파생 provider                                                                                      | JS/어댑터 전용                       | no        |
| `contract.mismatch`          | 계약 해시 불일치(JS > native stale)                                                                                  | 계약 게이트(`frame-engine-contract.ts`, node/bun bootstrap)                                                  | JS/어댑터 전용                       | no        |
| `contract.unenforceable`     | 계약 해시 검증 불가(네이티브 미지원)                                                                                 | 계약 게이트(`frame-engine-contract.ts`, node/bun bootstrap)                                                  | JS/어댑터 전용                       | no        |
| `inspector.invalid_snapshot` | 인스펙터 스냅샷 JSON 잘림/파싱 불가(experimental)                                                                    | TS 인스펙터 디코더 — loud-fail 계약                                                                          | JS/어댑터 전용                       | no        |
| `inspector.unexpected_shape` | 스냅샷 JSON 은 유효하지만 기대한 모양이 아님(experimental)                                                           | TS 인스펙터 디코더                                                                                           | JS/어댑터 전용                       | no        |
| `unknown`                    | 분류 불가 오류 — 최후 폴백                                                                                           | 불투명 transport 문자열의 JS `normalizeRustraError`; Rust hot-core/Tauri 에러 JSON 폴백                      | 양측 — 폴백, 팩토리 없음             | no        |

## 주처 요약

- **`error.rs` Rust 팩토리(9개):** `command.not_found`, `command.invalid_args`,
  `capability.denied`, `platform.unavailable`, `payload.too_large`, `transport.error`,
  `transport.timeout`, `cancelled`, `internal`.
- **`error.rs` 팩토리 없이 Rust 가 발급(5개):** `registry.frozen`,
  `registry.id_exhausted`, `signature.mismatch`(`registry.rs`), `ffi.not_registered`
  (FFI 엔트리), `invoke.backpressure`(`ffi_async_entries.rs`).
- **팩토리 없는 양측 공용 폴백(2개):** `invoke.failed`, `unknown` — 양쪽 모두 최후
  폴백 값으로 발급한다.
- **JS/어댑터 측 전용(13개):** `sync.unavailable`, `transport.unavailable`,
  `invoke.malformed`, `invoke.too_short`, `schema.unavailable`, `event.unavailable`,
  `channel.unavailable`, `device.unavailable`, `device.permission_denied`,
  `contract.mismatch`, `contract.unenforceable`, `inspector.invalid_snapshot`,
  `inspector.unexpected_shape`.

## retryable

- Rust: `transport`, `timeout`, `cancelled` 팩토리는 `retryable: true` 로 생성하고 나머지
  팩토리는 `false` 로 생성한다. 모든 인스턴스는 `.retryable()` 빌더로 표시할 수 있고
  `custom(...)` 은 기본 `false` 다. 와이어에서는 `false` 일 때 플래그를 생략한다.
- TS: 구조화 와이어에 플래그가 있으면 그 값이 이기고, 없으면(플래그 없는 JSON 경로)
  `isRetryableCode` 가 `transport.error`, `transport.timeout`, `cancelled` 정확히 세
  코드에 대해 추론한다 — Rust 팩토리 관례의 미러다.
- `CommandErrorVariant::retryable` 은 코드젠 문서 메타데이터일 뿐이며, 런타임 retryable
  판정은 여전히 인스턴스의 코드/플래그로 도출한다.
- `retryable: true` 는 "재실행 안전"이 아니다 — 비멱등 명령을 무조건 재시도하지 마라.

## 동기화 게이트와 알려진 갭

`packages/types/src/error-codes-sync.test.ts` 가 양측을 정직하게 묶는다: `error.rs`
팩토리 코드는 모두 `RustraErrorCode` 에 있어야 하고(누락 시 코드 목록과 함께 실패),
TS 코드는 `error.rs` 팩토리 코드이거나 테스트의 스코프 밖 선언에 사유와 함께
등록되어야 하며, 낡은 선언도 양방향으로 실패한다.

게이트는 `error.rs` 만 스캔하므로 다른 파일에 사는 Rust 발급 코드는 자동 스캔 밖이다.
현재 두 개가 있다 — `signature.mismatch`(`registry.rs` `replace()` 와이어 시그니처
가드)와 `invoke.backpressure`(비동기 FFI 워커 큐 포화 — Display 문자열로 전달되고
`parseRustraErrorString` 이 코드로 재분리한다; 메시지는 "retry after drain" 이라
말하지만 `retryable` 플래그는 없다). 둘 다 2026-09-20 에 `RustraErrorCode` 상수를
얻었고 동기화 테스트의 스코프 밖 선언에 발급 주처와 함께 등록되어 있다. `error.rs`
밖에서 새 코드가 나타나면 상수와 이 문서의 선언 행을 함께 추가한다.

# Production Hardening 설계 — 4 트랙

날짜: 2026-08-18 · 브랜치: `feat/production-hardening` · 베이스: `e4f47f7c`

## 배경

rustra-bridge는 코어 엔진(FFI 메모리 안전성, 타입 안전성, 크로스 플랫폼 어댑터, 코드 생성기)이
검증된 상태. 프로덕션 투입 전 4개 갭을 순서대로 보강한다:

1. AbortSignal ↔ CancellationToken 취소 파이프라인
2. OTA 스키마 하위 호환 (명령별 폴백)
3. 동적 페이로드 한도 + 대여 슬라이스
4. 크로스 플랫폼 CI 매트릭스

## 트랙 1: 취소 파이프라인

### 현황

- 취소 인프라 전무. `rustra_ffi_invoke_async` (ffi.rs:447)는 worker 스레드에서 실행되지만
  invocation ID가 없어 개별 호출 식별/취소 불가.
- JS측 `createRkyvV2Engine.invoke` (packages/types/src/index.ts:475)는 sync 호출을
  Promise로 감싼 구조 — abort가 프라미스를 거부해도 Rust 작업은 끝까지 실행.

### 설계

1. **Rust 취소 레지스트리** (`crates/rustra/src/cancel.rs` 신설):
   `static REGISTRY: Mutex<BTreeMap<u64, CancelState>>` + atomic u64 카운터.
   `CancelState::{Running, Cancelled, Completed}` — 취소는 플래그 전환만, 스레드 강제 종료 없음.
2. **FFI 확장**:
   - `rustra_ffi_invoke_async` / `invoke_json_async` 시그니처에 `invocation_id: *mut u64`
     out-param 추가 — Rust가 ID 발급, 워커 시작 전 레지스트리에 `Running` 등록.
   - 신규 심볼 `rustra_ffi_invoke_cancel(invocation_id: u64)` — `Running`이면 `Cancelled` 전환.
   - 신규 심볼 `rustra_ffi_cancellation_status(invocation_id: u64) -> u32` —
     0=Unknown, 1=Running, 2=Cancelled, 3=Completed. 핸들러 내부 폴링용 공개 API.
3. **협력적 취소 체크포인트**: dispatch 경로의 자연스러운 지점(capability 게이트 직후,
   핸들러 종료 후 응답 인코딩 전)에서 `is_cancelled(id)` 확인 → 취소됐으면
   `RustraError::cancelled` (`retryable: true`) 응답. 핸들러가 이미 끝났다면 결과 정상 반환.
4. **JS측 배선** (`packages/types`): `invoke(command, args, { signal })` 옵션.
   abort 시 (a) JS 프라미스 즉시 거부 + (b) `native.invokeCancel(id)` 호출.
   `packages/react-native` `createAsyncEngine`에도 동일 옵션 전파.
5. **에러 코드**: `cancelled` — `isRetryableCode`에 retryable로 등록.

### 테스트

- Rust: `crates/rustra/tests/cancel_tests.rs` — 상태 전이(Running→Cancelled→완료 정리),
  cancel 후 invoke 응답이 `cancelled` 에러, 완료 후 cancel은 no-op.
- TS: `packages/types/src/index.test.ts` — mock 네이티브로 AbortSignal 즉시 거부 +
  invokeCancel 호출 검증.

### 트레이드오프

취소는 핸들러 실행 전 체크포인트에서만 효력. 실행 중 강제 중단은 unsafe하므로 제외.
무거운 핸들러는 `rustra_ffi_cancellation_status` 폴링으로 자체 협력 중단 구현 가능.

## 트랙 2: OTA 스키마 하위 호환 (명령별 폴백)

### 현황

- Unknown 필드는 이미 관용적 (디코더가 스키마에 있는 필드만 구성).
- `schema-diff.ts`의 breaking 감지 체계 존재 (CI 게이트용).
- 문제: (a) contract_hash 불일치 시 전체 엔진 거부 (`contract.mismatch` throw),
  (b) 구 JS + 신 native 조합에서 command_id 불일치 → `command.not_found` 마비.

### 설계

1. **해시 불일치 시 옵트인 폴백**: `RkyvV2EngineOptions.onContractMismatch` 콜백 추가.
   미설정 시 현행 throw 유지 (하위 호환). 콜백에서 live schema 조회 후 공통 명령만
   사용하는 엔진 구성 가능.
2. **이름 기반 라우팅 폴백**: `invoke_rkyv_v2` (lib.rs:723)에서 command_id 조회 실패 시
   에러 대신 이름 조회 경로 활용 — 구 JS codec이 신 native command_id와 무관하게 동작.
   구현: FFI postcard/JSON envelope의 `command` 이름 문자열을 그대로 사용하는 경로는
   이미 이름 기반이므로, rkyv V2 경로의 command_id 미스를 live-schema 이름 조회로 재시도.
3. **schemaVersion 협상**: 생성된 contract.ts에 `SCHEMA_VERSION` 포함.
   엔진이 live schema 버전과 비교, JS > native면 `contract.stale` 경고 이벤트 발생
   (기존 이벤트 싱크 경로 재사용, fatal 아님).
4. **코드젠**: CLI가 schema.json에 `schemaVersion` 필드 생성.

### 테스트

- Rust: `crates/rustra/tests/ota_compat_tests.rs` — 서로 다른 command_id 매핑을 가진
  두 Package 간 이름 라우팅 폴백, unknown 필드 무시 재확인.
- TS: field-order-drift 패턴 확장 — unknown 필드 추가된 newer native 시뮬레이션 +
  onContractMismatch 콜백 경로.

### 트레이드오프

postcard 필드 순서가 달라진 truly-breaking 변경은 여전히 깨짐 — 그건 `rustra diff` CI
게이트 영역. 런타임 폴백은 unknown-명령/unknown-optional-필드 조합에만 유효.

## 트랙 3: 동적 페이로드 한도 + 대여 슬라이스

### 현황

- `MAX_PAYLOAD_BYTES = 1024*1024` (ffi.rs:91) 하드코딩. JSON/postcard 경로에서만 검사
  (rkyv V2 경로는 무겐).
- 예제 calculator에 별도 복제본 존재.
- JS측 사전 검사 전무.

### 설계

1. **동적 한도 API**: `rustra_ffi_set_max_payload(bytes: usize)` +
   `rustra_ffi_get_max_payload() -> usize`. `AtomicUsize` (기본 1MB 유지).
   rkyv V2 진입점(`invoke_rkyv_v2` 호출부)에도 동일 검사 추가.
2. **JS측 노출**: `RkyvV2EngineOptions.maxPayloadBytes` — 인코딩 직후 `byteLength` 검사로
   왕복 전 조기 실패 (네이티브 호출 절약, 에러 메시지에 컨텍스트 포함).
3. **대여 슬라이스 계약 문서화 + async 사전 복사 제거**: sync 진입점은 이미
   `slice::from_raw_parts`로 빌리므로 진입 복사 없음. async 진입점의 `.to_vec()` 사전
   복사가 유일한 진입 복사 — 워커로 소유권 이전이 필요하므로 유지하되 문서로 계약 명시:
   "호출 반환 = Rust측 해당 버퍼 사용 종료". 별도 `invoke_slice` 심볼은 추가하지 않음
   (세만틱 차이 없음).
4. 예제 calculator의 복제 한도 상수 정리 — 네이티브의 동적 한도와 정렬.

### 테스트

- Rust: `payload_robustness.rs` 확장 — set/get 라운드트립, 한도 변경 즉시 반영,
  동시 변경 하의 경계값(==limit 통과, limit+1 거부), rkyv V2 경로 신규 검사.

### 트레이드오프

진짜 zero-copy(ArrayBuffer 직접 공유)는 JSI/네이티브 호스트 구조 변경을 수반 — 별트랙.
이번 스코프는 "OOM 안전한 대용량"이지 zero-copy가 아님.

## 트랙 4: 크로스 플랫폼 CI 매트릭스

### 현황

- ci.yml은 Linux-only (rust 잡 ubuntu + typescript 잡).
- windows-experiment.yml은 non-gating (`continue-on-error: true`).
- macOS 잡 없음. 아티팩트 업로드 전무 — 커밋된 `calculator-napi.darwin-arm64.node`가
  유일한 사전 빌드 (darwin-arm64 전용).

### 설계

1. **ci.yml rust 잡 매트릭스화**: `os: [ubuntu-latest, macos-latest, windows-latest]`.
   gtk/webkit 의존 스텝은 `if: runner.os == 'Linux'`로 격리. Windows는 MSVC 툴체인.
2. **프리미티브 빌드 게이트**: 각 OS에서 `cargo build -p rustra-calculator-example --release`
   - JSON invoke 왕복 스모크 (cargo test로 대체 가능 — 플랫폼별 테스트 필터 조정).
3. **아티팩트 업로드**: `actions/upload-artifact@v4` — 플랫폼별 cdylib 산출물
   (`.so`/`.dylib`/`.dll`) + rustra crate 컴파일 검증.
4. **windows-experiment 승격은 문서화만**: 실제 게이트 승격은 별도 PR (리스크 분리).

### 트레이드오프

GitHub 호스티드 러너 macOS/Windows는 Linux보다 과금 배수가 높음. 풀 매트릭스 대신
rust 잡만 매트릭스에 올리고 typescript 잡은 Linux 유지.

## 구현 순서

트랙 1 → 2 → 3 → 4 순서로 진행. 각 트랙 완료 시 커밋 + 풀 테스트 스위트 green 확인.

트랙별 예상 산출물:

- T1: cancel.rs + ffi 심볼 3종 + TS invoke 옵션 + 테스트 양측
- T2: lib.rs 라우팅 폴백 + schemaVersion 코드젠 + onContractMismatch + 테스트 양측
- T3: 동적 한도 심볼 2종 + rkyv V2 검사 추가 + JS 옵션 + payload_robustness 확장
- T4: ci.yml 매트릭스 + 아티팩트 업로드

## 완료 노트 (2026-08-18)

트랙 1-4 전부 완료. 구현 커밋 (44c1583c..4326910a):

- T1 취소: 44c1583c, 2fb75da0, c3c736d6, e0e138b2, 341b30b2, 07967243, a96b537b
- T2 OTA: dfd3a80d, a6493d0b, 318782a7, 87f937bc
- T3 페이로드: 97f7c80b, 8853eb39, 2555004c
- T4 CI: f6b3cea6, 4326910a

### 설계에서의 주요 이탈

- **T2 방향 전환**: 설계의 "이름 기반 라우팅 폴백"은 불가능했다 — rkyv V2
  와이어에 명령 이름이 없다(command_id 만). 대신 `alias_command_id` 로 신
  네이티브가 구 JS 의 id 를 alias 로 수용하는 방향으로 재설계했다.
- **displacement 재번호 할당**: 전방 선언된 alias 의 구 id 를 다른 명령이 점유하는
  성장 시나리오에서 점유 명령을 fresh id 로 밀어내는 설계를 추가했고, 그 과정에서
  순서 결함 1건을 발견/수정했다 (a6493d0b).
- **취소 전파 경로 제한**: AbortSignal 취소 전파는 JS 코덱(tier2/tier3/전파)
  경로로 한정했다 — typed/tier3 일부 경로까지 포함하면 3-tier × 취소 매트릭스가
  폭발한다. 미지원 경로는 얕은 취소(JS 프라미스만 거부)로 폴백.
- **Windows 레그**: PE 에는 생성자(`.init_array` 상당물)가 없어 calculator FFI
  테스트가 자동 등록되지 않는다 — 테스트 진입 헬퍼로 수동 등록한다 (4326910a).

### 후속 항목 (이 브랜치 범위 외)

- RN/Lynx `FastEngineOptions`에 신규 엔진 옵션(onContractMismatch,
  schemaVersion/onSchemaStale, maxPayloadBytes) 전달
- `invokeBatch` 항목별 취소 (TODO(T1))
- tier-3 `getLiveSchema` 동기 throw 경로 (사전 존재, 이번에도 미손)
- `invokeTypedAsync` id 노출 — typed 경로 취소 전파 확장의 전제
- npm 플랫폼 패키지 발행 (아티팩트 업로드는 CI 에서 준비 완료)

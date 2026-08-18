# Follow-up 1: rkyv V2 크기 게이트 + payload.too_large 코드 통일

날짜: 2026-08-18 · 상위: docs/plans/2026-08-18-production-hardening-design.md 완료 노트 후속 (1)

## 개요

production hardening T3에서 FFI JSON/postcard 경로에만 동적 페이로드 한도를 달았다.
rkyv V2 바이너리 경로(`Package::invoke_rkyv_v2`)는 이 게이트를 우회 중이다 — 100 MiB 페이로드도 곧장 postcard 디코딩으로 진입한다. 또한 크기 초과 에러가 경로별로 다른 코드로 돌아온다 (JS 사전검사: `payload.too_large` / Rust FFI: 평문 `"payload exceeds size limit"` → JSON fallback에서 `invoke.failed`로 강등). 이 plan은 두 문제를 함께 닫는다: **rkyv V2 진입점에 동적 한도 게이트를 추가하고, 크기 초과 에러를 양측 공통 `payload.too_large` 코드로 통일**한다.

## 현재 상태 분석

### 주요 발견사항

- `crates/rustra/src/ffi.rs:99-109` — `DEFAULT_MAX_PAYLOAD_BYTES = 1 MiB`, `MAX_PAYLOAD_BYTES: AtomicUsize`, 판독기 `max_payload_bytes()` 는 **모듈 프라이빗**. 소비 크레이트(calculator/template)는 이 값을 읽을 방법이 없다.
- `crates/rustra/src/lib.rs:734-770` — `Package::invoke_rkyv_v2` 는 `payload.len() < 2` / `< 8` 최소폭 검사만 있고 **크기 상한 검사가 없다**.
- `crates/rustra/src/ffi.rs:454-456, 489-495` — JSON/postcard FFI 게이트는 초과 시 `err_response("payload exceeds size limit", ...)` 평문 문자열을 반환한다 — 구조화 코드 없음.
- `packages/types/src/index.ts:595-605` — JS 사전검사 `payloadTooLargeError` 는 코드 `payload.too_large` + 메시지(실제 크기/한도 포함) 반환. JS 전용이다.
- `packages/types/src/index.ts:84-85` — `parseRustraErrorString` 주석이 정확히 이 문제를 지적한다: 평문 `"payload exceeds size limit"` 은 `": "` 프리픽스가 없어 `invoke.failed` 로 강등된다.
- 소비 크레이트 FFI: `examples/calculator/src/lib.rs:1097-1117` (`rustra_calculator_invoke_rkyv_v2`), `runner/template/backend/src/lib.rs:122-139` (`rustra_template_invoke_rkyv_v2`) — 둘 다 검사 없이 `pkg.invoke_rkyv_v2` 로 직행하므로, lib.rs 게이트 하나로 양쪽이 커버된다.
- `examples/calculator/src/lib.rs:6` — 예제 자체 `MAX_PAYLOAD_BYTES = 1 MiB` 상수 복제본 (JSON/bytes 경로에서만 사용).
- 에러 코드 체계: `crates/rustra/src/error.rs` — `RustraError { code, message, retryable }`, 코드는 `&'static str` 팩토리 (`cancelled` 등). `payload.too_large` 팩토리 없음.
- rkyv V2 에러 와이어: `crates/rustra/src/rkyv_codec.rs:359-371` `encode_rkyv_v2_error` — `postcard({code, message})` 프레임. JS `tier2Outcome`/`decodeTier3Response` 가 `{code, message}` 를 그대로 복원한다. **이 와이어를 쓰면 코드가 살아남는다.**
- 연쇄 효과(현황): JS 가 `maxPayloadBytes` 미설정 + typed(tier1) 경로로 네이티브에 도달 → Rust 게이트 적중 → JSON envelope 평문 → `parseRustraErrorString` 강등 → 사용자는 `invoke.failed` 을 본다. 반면 JS 코덱 경로(tier2/tier3)는 `payload.too_large` 를 본다. **동일 원인, 코드 상이.**

### 왜 지금인가

- T3 설계(트랙 3)는 "rkyv V2 진입점에도 동일 검사 추가"를 명시했으나 완료 노트가 이를 유예했다(예제 계층 중복 상수 정리와 함께 "YAGNI, 별트랙"). 이번이 그 별트랙이다.
- RN JSI typed fast path(tier 1)는 JS 인코딩이 없어 JS 사전검사를 건너뛰므로(`packages/types/src/index.ts:687-689` 주석 "네이티브 한도가 그대로 적용된다" 가정), Rust V2 게이트가 이 가정을 실제로 만족시키는 유일한 위치다.

## 목표 상태

1. `Package::invoke_rkyv_v2` 진입(최소폭 검사 직후)에서 `payload.len() > max_payload_bytes()` 이면 `RustraError::payload_too_large(len, limit)` 반환 — calculator/template 양쪽 FFI가 한 번에 커버된다.
2. `RustraError` 에 `payload.too_large` 팩토리 추가 (non-retryable, 메시지에 실제/한도 바이트 포함).
3. ffi.rs JSON/postcard 게이트의 평문 `"payload exceeds size limit"` → `RustraError::payload_too_large(...).to_string()` (= `"payload.too_large: payload {N}B exceeds max payload {L}B"`) 통일.
4. JS `isRetryableCode` 변화 없음 (`payload.too_large` 는 non-retryable 유지 — 결정론적 클라이언트 조건).
5. JS 측 동작 변화: JSON fallback 경로에서 크기 초과 시 `invoke.failed` 대신 `payload.too_large` 로 파싱된다 (`parseRustraErrorString` 의 `": "` 분리 규칙이 `payload.too_large` 토큰을 인식).
6. 예제 calculator의 복제 한도 상수: JSON/bytes 경로 게이트를 `rustra::ffi::max_payload_bytes()` 공개 판독기로 교체해 네이티브 동적 한도와 정렬.

## 범위 제한 (하지 않을 것)

- JS측 `maxPayloadBytes` 엔진 옵션 로직은 그대로 둔다 — 이미 tier2/tier3/전파 경로에 시행 중. RN/Lynx FastEngineOptions 전달은 **Follow-up 2** 의 범위.
- 플랫폼 셸(C++ JSI invokeTyped / desktop/iOS/Android 셸)에는 별도 검사를 추가하지 않는다 — 모든 경로가 `Package::invoke_rkyv_v2` 를 통과하므로 Rust 게이트가 단일 지점이다.
- `rustra_ffi_invoke_async` 워커 내 복사 최적화(진입 복사 2배 문제)는 건드리지 않는다 — 이미 문서화된 계약 (ffi.rs:647-650).
- zero-copy/ArrayBuffer 직접 공유는 별트랙 (T3 설계 트레이드오프 참조).
- fuzz 바이너리(`rkyv_v2_fuzz.rs` 등)의 큰 페이로드 사용 여부는 구현 시 확인 — 사용한다면 해당 크레이트에서 한도를 상향해 호출 (게이트 거부가 정상 응답임은 계약상 맞지만, 라운드트립 퍼징이 죽으면 안 된다).

## 구현 접근 방식

게이트 위치는 `Package::invoke_rkyv_v2` (lib.rs) — template/calculator FFI와 C++ typed fast path가 모두 이 함수를 통과하므로 단일 지점이다. `max_payload_bytes()` 를 `pub` 판독기로 승격한다 (이미 `rustra_ffi_get_max_payload` 심볼이 공개돼 있으므로 정보 노출 면에서 동일). lib.rs → ffi 는 기존 단방향 참조(ffi가 `crate::Package` 사용)라 순환 참조가 생기지 않는다. 에러 통일은 팩토리를 통해서만 이루어진다(평문 제거) — 기존 "size limit" 문자열 어설션은 새 메시지에 맞게 갱신한다.

## Phase 1: Rust — 게이트 + 에러 팩토리 + 테스트

### 개요

한도 판독기 공개 + `invoke_rkyv_v2` 게이트 + `payload.too_large` 팩토리 + FFI 평문 통일 + 예제 복제 상수 정리.

### 필요한 변경사항:

#### 1. `crates/rustra/src/error.rs` — 신규 팩토리

**파일**: `crates/rustra/src/error.rs`
**변경사항**: 기존 팩토리들(`invalid_args` 근처)과 동일 스타일로 추가. 모듈 상단 코드 표 주석에 `payload.too_large` 행 추가.

```rust
/// 페이로드가 동적 크기 한도를 초과함 — `rustra_ffi_set_max_payload` 로
/// 설정된 값. Code: `payload.too_large`. Non-retryable (결정론적 조건).
pub fn payload_too_large(len: usize, limit: usize) -> Self {
    Self {
        code: "payload.too_large",
        message: format!("payload {len}B exceeds max payload {limit}B"),
        retryable: false,
    }
}
```

#### 2. `crates/rustra/src/ffi.rs` — 판독기 공개 + 평문 통일

**파일**: `crates/rustra/src/ffi.rs`
**변경사항**:

1. `fn max_payload_bytes()` → `pub fn max_payload_bytes()` + 기존 문서 코멘트 유지(공개 계약으로 보강).
2. `rustra_ffi_invoke_json` / `rustra_ffi_invoke_postcard` 게이트(ffi.rs:454-456, 489-495)의 평문 교체:

```rust
if payload_len > max_payload_bytes() {
    let e = crate::RustraError::payload_too_large(payload_len, max_payload_bytes());
    return err_response(&e.to_string(), out_len, json_serialize);
}
```

(postcard 경로는 `postcard_serialize_response` 전달 — 기존 구조 유지.)

#### 3. `crates/rustra/src/lib.rs` — rkyv V2 게이트

**파일**: `crates/rustra/src/lib.rs`
**변경사항**: `invoke_rkyv_v2`(lib.rs:734-737)에 상한 검사 추가.

```rust
pub fn invoke_rkyv_v2(&self, payload: &[u8]) -> crate::Result<Vec<u8>> {
    if payload.len() < 2 {
        return Err(RustraError::invalid_args("rkyv v2: payload too short"));
    }
    // (T3 후속) 크기 게이트 — JSON/postcard FFI 경로와 동일한 동적 한도.
    // 소비 크레이트 FFI(calculator/template)와 C++ typed fast path 가 모두
    // 이 함수를 통과하므로 여기가 단일 검사 지점이다.
    let limit = crate::ffi::max_payload_bytes();
    if payload.len() > limit {
        return Err(RustraError::payload_too_large(payload.len(), limit));
    }
    let command_id = u16::from_le_bytes([payload[0], payload[1]]);
    // … 이하 기존 그대로
```

에러는 소비 크레이트의 `encode_rkyv_v2_error` 매핑을 타고 rkyv V2 error wire(postcard `{code, message}`)로 나가므로 JS가 `payload.too_large` 코드를 그대로 복원한다 — JS측 코드 불변.

#### 4. `examples/calculator/src/lib.rs` — 복제 상수 정리

**파일**: `examples/calculator/src/lib.rs`
**변경사항**:

- `MAX_PAYLOAD_BYTES` 상수(lib.rs:6) 제거. `rustra_calculator_invoke`(lib.rs:617)과 `rustra_calculator_invoke_bytes`(lib.rs:676)의 게이트를 `rustra::ffi::max_payload_bytes()` 로 교체하고 메시지도 `RustraError::payload_too_large(...).to_string()` 로 통일.
- `rustra_calculator_invoke_rkyv_v2`(lib.rs:1097)는 #3 게이트를 상속하므로 코드 불변.
- `runner/template/backend/src/lib.rs:122` 도 마찬가지로 게이트 상속 — 코드 불변.

### 성공 기준:

#### 자동 검증:

- [ ] `cargo fmt --all -- --check` 통과
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` 통과
- [ ] `cargo test --workspace` 통과 — 신규 테스트 포함:
  - `invoke_rkyv_v2` 초과 페이로드 → `code == "payload.too_large"`, 메시지에 actual/limit 바이트 포함
  - 한도 하향(1024)이 rkyv V2 경로에도 즉시 반영 (기존 `LIMIT_MUTEX` 직렬화 + 원복 guard 패턴 재사용)
  - ==limit 페이로드는 게이트가 아니라 정상 파이프라인에서 실패 (파싱 에러)
  - FFI JSON/postcard 초과 → `"payload.too_large: "` 프리픽스 에러 응답 (기존 "size limit" 어설션 갱신: `trust_baseline_ffi.rs:129`, `payload_robustness.rs:206,326`)
- [ ] `npm run test:types` (types 55) green
- [ ] `npm run test:ts:node` (32) green
- [ ] `npm run test:packages` (45) green
- [ ] `npm run test -w @rustra/cli` (28) green
- [ ] `cargo test -p rustra-calculator-example` green (게이트 상속 + 상수 제거 회귀)
- [ ] types 테스트에 JSON fallback 파싱 회귀 가드 추가: `parseRustraErrorString("payload.too_large: payload 1048577B exceeds max payload 1048576B")` → `code === 'payload.too_large'` (기존 `invoke.failed` 강등 회귀 방지)

#### 수동 검증:

- [ ] fuzz/벤치 크레이트가 여전히 green 인지 확인 — `rkyv_v2_fuzz`/`rkyv_v2_concurrency` 가 1 MiB 초과 페이로드를 쓰면 한도 상향 조정 (cargo test 대상 밖이면 기록만)
- [ ] `npm run test:runtime:node` 로 Node 예제 앱에서 2 MiB 인자 → `payload.too_large` 수신 (기존 smoke)

## 테스트 전략

### 단위/통합 테스트 (Rust)

- `payload_robustness.rs` 확장 (V2 섹션 신설):
  - over-limit → `payload.too_large` 코드/메시지 파라미터
  - 한도 상향 → 기존 거부 크기 승인 (정상 파이프라인 에러로 실패)
  - FFI JSON 경로 프리픽스 갱신
- `error.rs` 인라인 단위: 팩토리 — 코드/메시지/retryable=false.
- `rkyv_v2_wire.rs` 기존 large-payload 라운드트립(tier2 10_000 items / tier3 1_000 items)이 게이트에 걸리지 않는지 확인 — 1 MiB 이내일 것으로 예상, 초과 시 해당 테스트에 한도 상향 헬퍼 적용.

### JS (types)

- JSON fallback 파싱 회귀 가드 1건 (위 자동 검증 항목).

### 수동 테스트 단계

1. `rustra_ffi_set_max_payload(1024)` 후 C++ `invokeTyped` 큰 인자 → JSError 메시지가 `payload.too_large: …` (C++ shim 테스트 또는 xcodebuild 로 대체 가능 — 구현 시 판단).
2. `npm run test:runtime:node` smoke.

## 성능 고려사항

- 게이트는 `AtomicUsize::load(Relaxed)` 1회 + 정수 비교 — rkyv V2 fast path(~µs) 대비 무시 가능.
- 동시 set 경합 시 last-writer-wins 는 설계된 계약 (ffi.rs:647-650 문서).
- `RustraError::to_string()` 은 `format!` 1회 — 에러 경로에서만.

## 마이그레이션 참고사항

- 와이어/ABI 변경 없음 — 에러 코드/메시지 문자열 정규화만. 구 JS가 평문 "payload exceeds size limit" 을 하드코딩 검사하는 사례는 레포 내 없음 (grep 확인).
- `rustra_ffi_get_max_payload` / `rustra_ffi_set_max_payload` 시그니처 불변 — 컴파일된 호스트와 호환 유지.
- 에러 문자열 어설션을 쓰는 기존 테스트 3건(`trust_baseline_ffi.rs`, `payload_robustness.rs` 2곳)은 같은 커밋에서 갱신.

## 참고 자료

- 상위 설계: `docs/plans/2026-08-18-production-hardening-design.md` (트랙 3)
- JS 사전검사 구현: `packages/types/src/index.ts:595-605`
- rkyv V2 에러 와이어: `crates/rustra/src/rkyv_codec.rs:359-371`
- 소비 크레이트 FFI: `examples/calculator/src/lib.rs:1097-1117`, `runner/template/backend/src/lib.rs:122-139`

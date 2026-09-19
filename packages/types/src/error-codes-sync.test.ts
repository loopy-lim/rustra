/**
 * TS ↔ Rust 에러 코드 동기화 게이트 — `RustraErrorCode`(errors.ts)와
 * `crates/rustra/src/error.rs` 팩토리 코드 집합이 갈라지면 CI에서 잡는다.
 *
 * 계약(양방향):
 *  1. Rust → TS: error.rs 의 `code: "..."` 팩토리 리터럴은 모두 RustraErrorCode 에
 *     있어야 한다 — Rust 가 새 코드를 발급하기 시작하면 TS 상수가 반드시 따라온다.
 *  2. TS → Rust: RustraErrorCode 의 모든 코드는 error.rs 팩토리 코드이거나,
 *     아래 `OUTSIDE_ERROR_RS` 에 사유와 함께 선언되어야 한다 — TS 전용 코드가
 *     조용히 늘어나는 것을 막고, 한쪽 전용임을 문서로 남긴다.
 *  3. 선언 신선도: `OUTSIDE_ERROR_RS` 에 낡은 항목(이제 error.rs 에 존재하는 코드,
 *     또는 TS 에 없는 코드)이 남으면 실패한다.
 *
 * 의도적 비대칭: TS 레지스트리(27개)는 어댑터 전용 코드까지 담는 반면 error.rs 는
 * 프레임워크 팩토리(9개)만 가진다. 원시 집합 등비교는 항상 실패하므로, 이 게이트는
 * "Rust 팩토리 ⊆ TS ⊆ Rust 팩토리 ∪ 문서화된 스코프 밖 선언"이라는 참을 강제한다.
 * 스코프 밖 Rust 발급 코드(registry.rs 의 `registry.*`, FFI 엔트리의
 * `ffi.not_registered`, `signature.mismatch`·`invoke.backpressure` 등)는 게이트
 * 대상이 아니다 — 문서는 docs/error-codes.md 를 본다.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { RustraErrorCode } from './errors.js';

/** packages/types 기준 `../../crates/rustra/src/error.rs` (이 파일은 src/ 아래). */
const RUST_ERROR_RS = resolve(import.meta.dir, '../../../crates/rustra/src/error.rs');

/** TS 파서(parseRustraErrorString)와 Rust validate_error_code 가 공유하는 코드 토큰 패턴. */
const CODE_TOKEN = /^[a-z][a-z0-9_.]*$/;

/**
 * error.rs 의 팩토리 코드 리터럴 추출 — 모든 팩토리는 `Self { code: "..." }` 모양이므로
 * `code:` 뒤 따오는 문자열 리터럴만 코드로 간주한다(포맷/들여쓰기 변화에 관대). 이
 * 앵커 덕분에 `platform_unavailable` 의 `"unknown"` 폴백 문자열 같은 비코드 리터럴은
 * 섞이지 않는다.
 */
function extractRustFactoryCodes(source: string): string[] {
  const literals = [...source.matchAll(/\bcode:\s*"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]);
  return [...new Set(literals.filter((literal) => CODE_TOKEN.test(literal)))];
}

const RUST_CODES = extractRustFactoryCodes(readFileSync(RUST_ERROR_RS, 'utf8'));
const rustCodes = new Set(RUST_CODES);
const tsCodes = new Set<string>(Object.values(RustraErrorCode));

/**
 * error.rs 팩토리 리터럴이 없는 TS 코드의 명시적 선언 — 사유는 errors.ts JSDoc 과
 * 실제 발급 주체를 그대로 반영한다. `registry.*`/`ffi.not_registered`/공용 폴백
 * (`invoke.failed`, `unknown`)은 Rust 가 error.rs 밖에서 발급하고, 나머지는
 * JS/어댑터 측 전용 코드다.
 */
const OUTSIDE_ERROR_RS: Record<string, string> = {
  'registry.frozen': 'Rust registry.rs 가 RustraError::custom 으로 발급 — error.rs 팩토리 없음',
  'registry.id_exhausted':
    'Rust registry.rs 가 RustraError::custom 으로 발급 — error.rs 팩토리 없음',
  'ffi.not_registered':
    'Rust FFI 엔트리(ffi_typed_entries/buffer, ffi_hot_reload) 발급 — 팩토리 없음',
  'invoke.failed':
    '양측 폴백 코드 — JS parseRustraErrorString, Rust hot_core_dylib/ffi_schema_entries',
  unknown: '양측 최후 폴백 — JS normalizeRustraError, Rust hot_core/tauri_support 에러 JSON 폴백',
  'sync.unavailable': 'JS 어댑터 전용(frame-engine-sync/global-sync) — Rust error.rs 대응 값 없음',
  'transport.unavailable':
    'JS 어댑터 전용(bun-ffi/node-bootstrap/react context) — Rust 대응 값 없음',
  'invoke.malformed': 'JS 코덱 전용(complex-codec/json-wire) — Rust 대응 값 없음',
  'invoke.too_short': 'JS 코덱 전용(complex-codec/생성 postcard 코덱) — Rust 대응 값 없음',
  'schema.unavailable': 'JS 어댑터 전용(live-schema) — Rust 대응 값 없음',
  'event.unavailable': 'JS 어댑터 전용(node-events/react-native-events) — Rust 대응 값 없음',
  'channel.unavailable': 'JS 어댑터 전용(react-native-events/tauri-channels) — Rust 대응 값 없음',
  'device.unavailable': '호스트 앱/파생 provider 전용 — rustra 코어는 디바이스 게이팅을 하지 않음',
  'device.permission_denied':
    '호스트 앱/파생 provider 전용 — rustra 코어는 디바이스 게이팅을 하지 않음',
  'contract.mismatch': 'JS 계약 게이트 전용(frame-engine-contract) — Rust 대응 값 없음',
  'contract.unenforceable': 'JS 계약 게이트 전용(frame-engine-contract) — Rust 대응 값 없음',
  'inspector.invalid_snapshot': 'TS 인스펙터 디코더 전용(experimental) — Rust 대응 값 없음',
  'inspector.unexpected_shape': 'TS 인스펙터 디코더 전용(experimental) — Rust 대응 값 없음',
};

test('error.rs 팩토리 코드는 모두 TS RustraErrorCode 에 있다 (Rust → TS)', () => {
  const missing = RUST_CODES.filter((code) => !tsCodes.has(code)).sort();
  assert.deepEqual(
    missing,
    [],
    `crates/rustra/src/error.rs 팩토리 코드 중 TS RustraErrorCode 에 없는 코드 (${missing.length}개): ${missing.join(', ')}` +
      '\n→ errors.ts 의 RustraErrorCode 에 상수를 추가하세요 — 새 코드는 양쪽을 함께 갱신하는 단일 소스 관례다.',
  );
});

test('TS 코드는 error.rs 팩토리 코드이거나 문서화된 스코프 밖 코드다 (TS → Rust)', () => {
  const undeclared = [...tsCodes]
    .filter((code) => !rustCodes.has(code) && !(code in OUTSIDE_ERROR_RS))
    .sort();
  assert.deepEqual(
    undeclared,
    [],
    `RustraErrorCode 에 있는데 error.rs 팩토리에도 OUTSIDE_ERROR_RS 선언에도 없는 코드 (${undeclared.length}개): ${undeclared.join(', ')}` +
      '\n→ Rust error.rs 에 팩토리를 추가하거나, 한쪽 전용 코드라면 OUTSIDE_ERROR_RS 에 사유와 함께 선언하세요.',
  );
});

test('OUTSIDE_ERROR_RS 선언은 낡은 항목 없이 양방향으로 정확히 대응한다', () => {
  const stale = Object.keys(OUTSIDE_ERROR_RS)
    .filter((code) => rustCodes.has(code))
    .sort();
  assert.deepEqual(
    stale,
    [],
    `이제 error.rs 팩토리에 존재하는데 OUTSIDE_ERROR_RS 에 남아 있는 코드: ${stale.join(', ')}` +
      '\n→ 이제 스코프 안이므로 선언을 제거하세요.',
  );
  const phantom = Object.keys(OUTSIDE_ERROR_RS)
    .filter((code) => !tsCodes.has(code))
    .sort();
  assert.deepEqual(
    phantom,
    [],
    `TS RustraErrorCode 에 없는데 OUTSIDE_ERROR_RS 에 선언된 코드: ${phantom.join(', ')}` +
      '\n→ errors.ts 와 함께 정리하세요.',
  );
});

test('추출 sanity — 양쪽 집합이 비지 않았다 (정규식 부패 시 허위 통과 방지)', () => {
  assert.ok(
    RUST_CODES.length >= 9,
    `error.rs 코드 추출이 비정상적으로 적다: ${RUST_CODES.length}개 (${RUST_CODES.join(', ')}) — code: 리터럴 앵커가 깨졌는지 확인`,
  );
  assert.ok(
    tsCodes.size >= 27,
    `RustraErrorCode 가 비정상적으로 적다: ${tsCodes.size}개 — errors.ts 의 의도된 삭제인지 확인`,
  );
});

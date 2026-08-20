// Phase 3 — Task 3.4: large / zero-len / malformed payload robustness (TS 측).
//
// Rust 측(payload_robustness.rs) 의 짝. 호스트가 내보낸 *비정상 응답 프레임* 이
// TS codec.decode / engine 경로에서 절대 uncaught throw 를 내지 않고
// clean 한 { ok:false, error:{code,message} } / RustraCommandError(code,message)
// 로 정규화되는지 검증한다.
//
//   - 빈 버퍼 / 8바이트 미만 → { ok:false, error:{ code:'invoke.too_short' } }
//   - 정상 success 프레임 → { ok:true, result }  (위 음성(음성 위양성) 방지용 대조)
//   - 정상 error 프레임(divide-by-zero) → { ok:false, error:{ code,message } }
//   - engine 경로: mock native 가 too-short / error 프레임을 반환 →
//     Promise.reject(new RustraCommandError(code,message))

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { addNumbersCodec, divideCodec } from '../generated/rkyv-codecs.js';
import { rkyvV2Registry } from '../generated/rkyv-registry.js';
import { createRkyvV2Engine, RustraCommandError } from '@rustra/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist-ts/examples/calculator/ts → 저장소 루트 — transport-bench.test.ts 와 동일한
// 루트 탐색(Cargo.toml+package.json 이 함께 있는 디렉터리).
const ROOT = (() => {
  let cur = __dirname;
  while (cur !== dirname(cur)) {
    if (existsSync(join(cur, 'Cargo.toml')) && existsSync(join(cur, 'package.json'))) return cur;
    cur = dirname(cur);
  }
  return join(__dirname, '..', '..', '..');
})();

// divide-by-zero error 프레임 (Rust wire_fixtures.rs / cross-wire.test.ts 와 동일).
const DIVIDE_RESPONSE =
  '00000000000000002a00136d6174682e6469766964655f62795f7a65726f1563616e6e6f7420646976696465206279207a65726f';

function hexToBytes(hex: string): ArrayBuffer {
  const u = new Uint8Array(hex.length / 2);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return u.buffer;
}

// ── codec.decode — 비정상/경계 프레임은 clean 에러 ─────────────

test('decode empty buffer → too_short (no throw)', () => {
  const r = addNumbersCodec.decode(new ArrayBuffer(0));
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'invoke.too_short');
});

test('decode sub-8-byte buffer → too_short (no throw)', () => {
  // 4바이트, 7바이트 모두 8바이트 헤더 미만.
  for (const len of [1, 4, 7]) {
    const r = addNumbersCodec.decode(new ArrayBuffer(len));
    assert.equal(r.ok, false, `${len}-byte frame must be too_short`);
    assert.equal(r.error?.code, 'invoke.too_short');
  }
});

test('decode well-formed success frame → ok (대조: 음성 위양성 방지)', () => {
  // 2+3=5 → response body 0x0a (zigzag(5)=10). 정상 프레임은 ok=true 여야 한다.
  const r = addNumbersCodec.decode(hexToBytes('01000000000000000a'));
  assert.equal(r.ok, true);
  assert.equal(r.result?.value, 5);
});

test('decode error frame → { code, message } (divide-by-zero)', () => {
  // addNumbersCodec 라도 response 레이아웃(commandId 무관)은 균일하므로
  // divide error 프레임을 clean 하게 풀 수 있어야 한다.
  const r = addNumbersCodec.decode(hexToBytes(DIVIDE_RESPONSE));
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'math.divide_by_zero');
  assert.equal(r.error?.message, 'cannot divide by zero');
});

test('divideCodec.decode empty buffer → too_short (codec 무관 동일 가드)', () => {
  const r = divideCodec.decode(new ArrayBuffer(0));
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'invoke.too_short');
});

// ── engine 경로 — 비정상 응답 → RustraCommandError ─────────────

/// 모든 invoke 에 대해 동일한 canned 응답 프레임을 반환하는 mock native.
function nativeReturning(frame: ArrayBuffer) {
  return {
    invokeRkyvV2(_payload: ArrayBuffer): ArrayBuffer {
      return frame;
    },
  };
}

test('engine: too-short response → reject RustraCommandError(invoke.too_short)', async () => {
  const engine = createRkyvV2Engine(nativeReturning(new ArrayBuffer(4)), rkyvV2Registry);
  await assert.rejects(
    () => engine.invoke('addNumbers', { a: 2, b: 3 }),
    (err: unknown) => {
      assert.ok(err instanceof RustraCommandError, 'must be a RustraCommandError');
      assert.equal(err.code, 'invoke.too_short');
      return true;
    },
  );
});

test('engine: error response → reject RustraCommandError(command code)', async () => {
  // 호스트가 divide-by-zero error 프레임을 내면 engine 이 code/message 를
  // RustraCommandError 로 투명하게 전달해야 한다.
  const engine = createRkyvV2Engine(nativeReturning(hexToBytes(DIVIDE_RESPONSE)), rkyvV2Registry);
  await assert.rejects(
    () => engine.invoke('addNumbers', { a: 2, b: 3 }),
    (err: unknown) => {
      assert.ok(err instanceof RustraCommandError);
      assert.equal(err.code, 'math.divide_by_zero');
      assert.equal(err.message, 'cannot divide by zero');
      return true;
    },
  );
});

test('engine: empty response → reject RustraCommandError(invoke.too_short)', async () => {
  const engine = createRkyvV2Engine(nativeReturning(new ArrayBuffer(0)), rkyvV2Registry);
  await assert.rejects(
    () => engine.invoke('addNumbers', { a: 2, b: 3 }),
    (err: unknown) => {
      assert.ok(err instanceof RustraCommandError);
      assert.equal(err.code, 'invoke.too_short');
      return true;
    },
  );
});

// ── napi 와이어 — RustraError 가 평탄화(Display)되지 않고 구조로 건너는지 ──

test('napi: error crosses the wire as structured JSON (code preserved)', () => {
  const napiPath = join(
    ROOT,
    `examples/calculator-napi/calculator-napi.${process.platform}-${process.arch}.node`,
  );
  if (!existsSync(napiPath)) {
    return; // 바이너리 없으면 스킵 — CI 는 build:napi 사전 빌드 후 실행
  }
  const native = createRequire(__dirname)(napiPath) as {
    rustraInvoke: (cmd: string, args: string | undefined) => string;
  };
  assert.throws(
    () => native.rustraInvoke('definitelyNotACommand', JSON.stringify({})),
    (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      // code 가 JSON 구조로 보존되는지 — plain "code: msg" Display 는 retryable 유실
      assert.match(msg, /"code"\s*:\s*"command\.not_found"/, `code not structured: ${msg}`);
      return true;
    },
  );
});

// M3 — tier2 디코드 실패 정규화 계약 테스트(DX 감사 2.1/2.2).
// 저장소 표준(node:test + node:assert/strict, ESM) 사용 — 새 의존성 없음.
//
// 정규화 전에는 생성 코덱의 plain `Error` 가 `instanceof Error` 분기로 그대로
// 통과해 `error.code === undefined` 로 새어나갔다(실측: 'varint out of bounds').
// 여기서는 (1) code 부여, (2) 메시지 형태(명령명·오프셋·프레임 길이·RUSTRA_DEBUG
// 힌트), (3) 원본 예외/프레임 보존, (4) 기존 정상 경로 무손상을 각각 고정한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { tier2Outcome } from './frame-engine-contract.js';
import { RustraCommandError } from './errors.js';
import type { FrameCodec } from './public.js';

/** decode 가 인자로 받은 예외를 그대로 던지는 최소 코덱. */
function codecWhoseDecodeThrows(error: unknown): FrameCodec<unknown, unknown> {
  return {
    commandId: 1,
    encode: () => new ArrayBuffer(0),
    decode: () => {
      throw error;
    },
  };
}

const fail = <T>(outcome: { ok: true; value: T } | { ok: false; error: Error }): Error => {
  assert.equal(outcome.ok, false);
  return outcome.error;
};

test("plain Error from decode normalizes to RustraCommandError('invoke.malformed')", () => {
  const frame = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const error = fail(
    tier2Outcome(codecWhoseDecodeThrows(new Error('varint out of bounds')), frame, 'addNumbers'),
  );
  assert.ok(error instanceof RustraCommandError);
  assert.equal(error.code, 'invoke.malformed');
  assert.equal(error.retryable, false); // 결정론적 클라이언트 조건 — 재시도 무의미
  // 코덱 에러가 위치를 싣지 않으면 실패 지점의 최선 추정은 프레임 끝(전체 길이).
  assert.equal(
    error.message,
    "decode failed for 'addNumbers' at offset 4: varint out of bounds (4-byte frame)" +
      ' — set RUSTRA_DEBUG=1 to dump wire bytes',
  );
  // 원본 예외는 cause 로, 스택도 보존한다(normalizeRustraError 관례).
  assert.ok(error.cause instanceof Error);
  assert.equal((error.cause as Error).message, 'varint out of bounds');
  assert.equal(error.stack, (error.cause as Error).stack);
});

test('non-Error throws are normalized the same way (string throw)', () => {
  const error = fail(
    tier2Outcome(codecWhoseDecodeThrows('varint too long'), new ArrayBuffer(2), 'greet'),
  );
  assert.ok(error instanceof RustraCommandError);
  assert.equal(error.code, 'invoke.malformed');
  assert.match(error.message, /^decode failed for 'greet' at offset 2: varint too long/);
  assert.ok(error.message.includes('set RUSTRA_DEBUG=1'));
});

test("offset hint in the codec error message ('at byte 42') is honored over the frame length", () => {
  const frame = new Uint8Array(100);
  const error = fail(
    tier2Outcome(
      codecWhoseDecodeThrows(new Error('unexpected tag at byte 42')),
      frame,
      'addNumbers',
    ),
  );
  // 프레임이 100B 여도 코덱이 알려준 위치(42)를 쓴다.
  assert.match(error.message, /^decode failed for 'addNumbers' at offset 42: /);
});

test('already-structured RustraCommandError passes through unwrapped (code preserved)', () => {
  const thrown = new RustraCommandError('math.divide_by_zero', 'division by zero');
  const error = fail(tier2Outcome(codecWhoseDecodeThrows(thrown), new ArrayBuffer(4), 'divide'));
  assert.equal(error, thrown); // 이중 래핑 금지 — 기존 error.code 분기 보존
});

test('structured failure responses keep their code/retryable contract unchanged', () => {
  const codec: FrameCodec<unknown, unknown> = {
    commandId: 1,
    encode: () => new ArrayBuffer(0),
    decode: () => ({ ok: false, error: { code: 'math.divide_by_zero', message: 'div by zero' } }),
  };
  const error = fail(tier2Outcome(codec, new ArrayBuffer(4), 'divide'));
  assert.ok(error instanceof RustraCommandError);
  assert.equal(error.code, 'math.divide_by_zero');
  assert.equal(error.retryable, false);
});

test('success path is untouched', () => {
  const codec: FrameCodec<unknown, unknown> = {
    commandId: 1,
    encode: () => new ArrayBuffer(0),
    decode: () => ({ ok: true, result: 42 }),
  };
  const outcome = tier2Outcome(codec, new ArrayBuffer(4), 'addNumbers');
  assert.deepEqual(outcome, { ok: true, value: 42 });
});

test('normalized error carries an independent copy of the response frame (M8 forensics)', () => {
  // caller-buffer 스타일 뷰(byteOffset ≠ 0)로 전달해도 가시 바이트만 복사된다.
  const backing = new Uint8Array([0, 0, 0xde, 0xad, 0xbe, 0xef, 0xff]);
  const view = new Uint8Array(backing.buffer, 2, 4);
  const error = fail(
    tier2Outcome(codecWhoseDecodeThrows(new Error('varint out of bounds')), view, 'addNumbers'),
  );
  assert.ok(error instanceof RustraCommandError);
  assert.ok(error.frameBytes instanceof Uint8Array);
  assert.deepEqual(Array.from(error.frameBytes!), [0xde, 0xad, 0xbe, 0xef]);
  // 독립 복사본 — 원본 버퍼를 나중에 바꿔도 에러의 프레임은 변조되지 않는다.
  backing.fill(0);
  assert.deepEqual(Array.from(error.frameBytes!), [0xde, 0xad, 0xbe, 0xef]);
});

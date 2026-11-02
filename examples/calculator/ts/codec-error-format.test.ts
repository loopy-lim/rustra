import assert from 'node:assert/strict';
import test from 'node:test';
import { addNumbersCodec } from '../generated/frame-codecs.js';

// 생성 코덱 디코드 오류 계약 — 'rustra: <원인> (offset N)' 고정 형식.
// tier2 엔진 정규화(packages/types DECODE_OFFSET_HINT)가 이 오프셋을 그대로
// 소비한다: 가짜 코덱 단위 테스트(frame-engine-contract.test.ts)가 추출 규칙을
// 검증하고, 이 테스트는 실제 생성 코덱이 같은 형식을 내는지 고정한다.
// 형식을 바꾸려면 양쪽 계약을 함께 바꿔야 한다.

function truncatedAddNumbersFrame(): ArrayBuffer {
  // 성공 프레임 응답 형태 [cmd_id u16 LE][응답 postcard] — 최소 8바이트 가드를
  // 통과시키고, 첫 출력 필드(i64 zigzag varint)를 continuation 바이트 하나만
  // 남기고 잘라 varint 경계 실패를 만든다. 실패 지점은 필드 시작(8) + 읽은
  // 바이트(1) = 오프셋 9.
  const bytes = new Uint8Array([
    addNumbersCodec.commandId & 0xff,
    (addNumbersCodec.commandId >> 8) & 0xff,
    0,
    0,
    0,
    0,
    0,
    0,
    0x80,
  ]);
  return bytes.buffer;
}

void test('generated codec decode errors carry the rustra: prefix and a real offset', () => {
  assert.throws(
    () => addNumbersCodec.decode(truncatedAddNumbersFrame()),
    /rustra: varint out of bounds \(offset \d+\)/,
  );
});

void test('offset in the generated decode error points past the truncated varint', () => {
  try {
    addNumbersCodec.decode(truncatedAddNumbersFrame());
    assert.fail('expected decode to throw');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const match = /offset (\d+)\)/.exec(message);
    assert.ok(match, `message must carry a numeric offset: ${message}`);
    // [cmd_id 2바이트][응답 오프셋 8 가드] 후 첫 필드에서 1바이트 읽고 끊긴다.
    assert.equal(Number(match[1]), 9);
  }
});

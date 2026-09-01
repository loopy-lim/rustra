import assert from 'node:assert/strict';
import test from 'node:test';
import { demultiplexBinaryFrame } from './node-loop.js';

/**
 * 0xfffd 푸시 프레임 디멀티플렉서 테스트 — 순수 데이터 경로만 검증한다
 * (스폰 없음 → Bun/Node 양쪽 러너에서 실행). 실제 런타임 왕복(push 설치된
 * loop-stdio 스폰)은 CI node 러너 스위트(test:node-runtime)와 examples 가
 * 담당한다.
 */

const BINARY_PUSH_EVENTS_CMD = 0xfffd;

/** [len u32 LE][body] 프레임 — loop-stdio 와이어와 동일. */
function frame(body: Buffer): Buffer {
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32LE(body.length, 0);
  return Buffer.concat([prefix, body]);
}

/** 0xfffd 푸시 프레임 본문 — [cmd u16 LE][1줄 JSON {name, payload, seq}]. */
function pushBody(name: string, payloadJson: string, seq: number): Buffer {
  const json = Buffer.from(JSON.stringify({ name, payload: payloadJson, seq }));
  const body = Buffer.allocUnsafe(2 + json.length);
  body.writeUInt16LE(BINARY_PUSH_EVENTS_CMD, 0);
  json.copy(body, 2);
  return body;
}

/** rkyv V2 응답 프레임 본문 — [ok u8][pad 3][len u32][json @8]. */
function responseBody(result: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(result));
  const body = Buffer.allocUnsafe(8 + json.length);
  body[0] = 1;
  body.writeUInt32LE(json.length, 4);
  json.copy(body, 8);
  return body;
}

test('demultiplexBinaryFrame routes 0xfffd frames to push listeners', () => {
  const pushes: Array<{ name: string; payload: string; seq: number }> = [];
  let responseHits = 0;
  const body = pushBody('progress.tick', '{"step":1}', 0);
  demultiplexBinaryFrame({
    cmd: BINARY_PUSH_EVENTS_CMD,
    body,
    onPush: (event) => pushes.push(event),
    onResponse: () => {
      responseHits += 1;
    },
  });
  assert.deepEqual(pushes, [{ name: 'progress.tick', payload: '{"step":1}', seq: 0 }]);
  assert.equal(responseHits, 0, 'push frame must not resolve a response waiter');
});

test('demultiplexBinaryFrame routes non-push frames to the response queue', () => {
  const pushes: unknown[] = [];
  const responses: Uint8Array[] = [];
  const body = responseBody({ value: 42 });
  demultiplexBinaryFrame({
    // 응답 프레임의 첫 u16 LE = ok|pad — 0xfffd 가 될 수 없다(ok는 0/1).
    cmd: body[0]! | (body[1]! << 8),
    body,
    onPush: () => pushes.push('unexpected'),
    onResponse: (frameBytes) => responses.push(frameBytes),
  });
  assert.equal(responses.length, 1);
  assert.deepEqual(pushes, []);
});

test('demultiplexBinaryFrame tolerates malformed push bodies without throwing', () => {
  const pushes: unknown[] = [];
  // cmd id 뒤에 비정상 JSON — 조용히 건너뛴다(폴링 drain 파싱과 동일 정책).
  demultiplexBinaryFrame({
    cmd: BINARY_PUSH_EVENTS_CMD,
    body: Buffer.from([0xfd, 0xff, 0x6e, 0x6f, 0x70, 0x65]),
    onPush: () => pushes.push('x'),
    onResponse: () => {},
  });
  assert.deepEqual(pushes, []);
});

test('interleaved push and response frames dispatch independently', () => {
  const pushes: Array<{ name: string; payload: string; seq: number }> = [];
  const responses: string[] = [];
  // 응답-푸시-응답이 한 stdout 청크에 붙어 들어오는 시나리오 — 각 프레임이
  // 정확히 자기 경로로 간다(binQueue resolve 와 push 브로드캐스트의 무간섭).
  const stream = Buffer.concat([
    frame(responseBody({ value: 1 })),
    frame(pushBody('tick', '{"n":1}', 0)),
    frame(pushBody('done', '{"emitted":2}', 1)),
    frame(responseBody({ value: 2 })),
  ]);
  let offset = 0;
  while (offset + 4 <= stream.length) {
    const len = stream.readUInt32LE(offset);
    const body = stream.subarray(offset + 4, offset + 4 + len);
    offset += 4 + len;
    demultiplexBinaryFrame({
      cmd: body[0]! | (body[1]! << 8),
      body,
      onPush: (event) => pushes.push(event),
      onResponse: (frameBytes) => {
        // 응답 프레임 디코드 — node-loop invokeBinary 와 동일 셰이프.
        const jsonLen =
          frameBytes[4]! | (frameBytes[5]! << 8) | (frameBytes[6]! << 16) | (frameBytes[7]! << 24);
        responses.push(
          String(
            JSON.parse(
              Buffer.from(frameBytes.buffer, frameBytes.byteOffset + 8, jsonLen).toString(),
            ).value,
          ),
        );
      },
    });
  }
  assert.deepEqual(pushes, [
    { name: 'tick', payload: '{"n":1}', seq: 0 },
    { name: 'done', payload: '{"emitted":2}', seq: 1 },
  ]);
  assert.deepEqual(responses, ['1', '2']);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { configureDebug, resetDebugEnvForTests } from '@rustra/types';
import {
  UNPARSED_LINES_CAPACITY,
  attachExitContext,
  demultiplexBinaryFrame,
  recordUnparsedLine,
  type UnparsedLineState,
} from './node-loop.js';

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

// ── NDJSON 실패 라인 보존 (Task 7) — recordUnparsedLine / attachExitContext ──
// stdout 스트림 경로 자체는 스폰이 필요하므로(Bun 러너 EBADF — index.test.ts
// processTest 주석 참조), 여기선 추출된 순수 함수로 진단 경로를 단위 검증한다.
// 실 스폰 왕복(exit 첨부 포함)은 node 러너 스위트(test:node-runtime)가 담당한다.

function newState(): UnparsedLineState {
  return { buffer: [], warned: false };
}

test('recordUnparsedLine preserves lines in the ring buffer when debug is off', () => {
  delete process.env.RUSTRA_DEBUG;
  resetDebugEnvForTests(); // dump 게이트 메모이즈 무효화 — env 변경이 보이게.
  const state = newState();
  recordUnparsedLine('not json {', state);
  recordUnparsedLine('<html>oops</html>', state);
  assert.deepEqual(state.buffer, ['not json {', '<html>oops</html>']);
});

test('recordUnparsedLine ring buffer never exceeds the capacity and keeps the most recent lines', () => {
  delete process.env.RUSTRA_DEBUG;
  resetDebugEnvForTests();
  const state = newState();
  for (let i = 1; i <= UNPARSED_LINES_CAPACITY + 10; i += 1) {
    recordUnparsedLine(`garbage-${i}`, state);
    assert.ok(
      state.buffer.length <= UNPARSED_LINES_CAPACITY,
      `buffer must stay bounded (saw ${state.buffer.length} after line ${i})`,
    );
  }
  assert.equal(state.buffer.length, UNPARSED_LINES_CAPACITY);
  assert.deepEqual(
    state.buffer,
    Array.from({ length: UNPARSED_LINES_CAPACITY }, (_, i) => `garbage-${i + 11}`),
  );
});

test('recordUnparsedLine emits a ndjson.unparsed debug event and a once-only stderr warn in debug mode', () => {
  // resetDebugEnvForTests 는 env 변수도 지우므로 먼저 무효화하고 env 를 세팅한다
  // (packages/types debug.test.ts 의 관례와 동일 순서).
  resetDebugEnvForTests();
  process.env.RUSTRA_DEBUG = '1';
  const seen: unknown[] = [];
  configureDebug((event) => seen.push(event));
  const warns: string[] = [];
  const originalWarn = console.warn;
  const originalDebug = console.debug;
  console.warn = (message?: unknown) => {
    warns.push(String(message));
  };
  // debug 모드의 console.debug 미러 출력도 흡수해 테스트 출력을 깨끗하게 유지.
  console.debug = () => {};
  try {
    const state = newState();
    for (let i = 0; i < 5; i += 1) recordUnparsedLine(`nope-${i}`, state);
    // debug 모드에선 버퍼 대신 이벤트 경로 — 링 버퍼는 비어 있다.
    assert.deepEqual(state.buffer, []);
    assert.equal(seen.length, 5, 'every unparsed line reaches the sink');
    // debugRustra 가 value 백 필드를 덧붙이므로 관심 필드만 개별 단정한다.
    assert.equal((seen[0] as { kind?: string }).kind, 'ndjson.unparsed');
    assert.equal((seen[0] as { line?: string }).line, 'nope-0');
    assert.equal(warns.length, 1, 'stderr warn fires on the first occurrence only');
    assert.match(warns[0]!, /not valid NDJSON/);
  } finally {
    console.warn = originalWarn;
    console.debug = originalDebug;
    configureDebug(undefined);
    delete process.env.RUSTRA_DEBUG;
    resetDebugEnvForTests();
  }
});

test('attachExitContext keeps the original message when there is nothing to attach', () => {
  const message = 'runtime process exited before responding';
  assert.equal(attachExitContext(message, []), message);
  assert.equal(attachExitContext(message, [], undefined), message);
});

test('attachExitContext preserves the original message as prefix and appends preserved lines', () => {
  const message = attachExitContext('runtime process exited before responding', [
    'line-one',
    'line-two',
  ]);
  assert.ok(
    message.startsWith('runtime process exited before responding'),
    'original message must remain the prefix (existing assertions depend on it)',
  );
  assert.ok(message.includes('line-one'));
  assert.ok(message.includes('line-two'));
});

test('attachExitContext appends the stderr tail after the preserved lines', () => {
  const message = attachExitContext('exited', ['bad-line'], 'thread panicked at src/main.rs:7');
  assert.ok(message.includes('bad-line'));
  assert.ok(message.includes('thread panicked at src/main.rs:7'));
  const stderrIndex = message.indexOf('stderr:');
  const linesIndex = message.indexOf('bad-line');
  assert.ok(linesIndex >= 0 && stderrIndex > linesIndex, 'stderr section comes last');
});

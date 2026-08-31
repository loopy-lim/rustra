// B1 인스펙터 스냅샷 파서 테스트.
// 저장소 표준(node:test + node:assert/strict, ESM) 사용 — 새 의존성 없음.
//
// golden PINNED hex 는 UTF-8 JSON 바이트를 손으로 고정한 것이다:
// 스냅샷 blob 은 serde_json 이 만드는 UTF-8 JSON(rustra_ffi_capture_snapshot)
// 이고, hex 는 아래 GOLDEN_SNAPSHOT 객체를 JSON.stringify 로 직렬화한 바이트와
// 1:1 이다(키 순서·공백 없음까지 고정). 코덱 와이어가 아니므로 postcard 핀은
// 없고, B2 wire 뷰어(rustra inspect)가 와이어 프레임 조립을 담당한다.

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSnapshot, RustraCommandError, serializeSnapshot } from './index.js';
import type { DumpedWire } from './index.js';

function hexToBytes(hex: string): Uint8Array {
  const u = new Uint8Array(hex.length / 2);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return u;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** golden hex 의 원본 문서 — hex 와 1:1 대응(키 순서 포함). */
const GOLDEN_SNAPSHOT = {
  packageId: 'test.calculator',
  contractHash: '9f2c0a5e5d4b3a29187f6e5d4c3b2a190807060504030201fffe0d0c0b0a0908',
  schemaGeneration: 7,
  commands: [
    { id: 1, name: 'addNumbers', capability: null },
    { id: 2, name: 'adminReset', capability: 'admin' },
  ],
  limits: { maxPayloadBytes: 1048576 },
  stats: {
    registeredCommands: 2,
    grantedCapabilities: ['admin'],
    pendingEvents: 0,
    droppedEvents: 3,
  },
} as const;

// GOLDEN_SNAPSHOT 의 JSON 직렬화 바이트 — 위 객체에서 파생하지 않고 독립 고정.
// 이 hex 가 바뀌면 골든 계약(파서가 읽는 바이트 모양)이 바뀐 것이다.
const GOLDEN_HEX =
  '7b227061636b6167654964223a22746573742e63616c63756c61746f72222c22636f6e747261637448617368223a' +
  '22396632633061356535643462336132393138376636653564346333623261313930383037303630353034303330' +
  '32303166666665306430633062306130393038222c22736368656d6147656e65726174696f6e223a372c22636f6d' +
  '6d616e6473223a5b7b226964223a312c226e616d65223a226164644e756d62657273222c226361706162696c6974' +
  '79223a6e756c6c7d2c7b226964223a322c226e616d65223a2261646d696e5265736574222c226361706162696c69' +
  '7479223a2261646d696e227d5d2c226c696d697473223a7b226d61785061796c6f61644279746573223a31303438' +
  '3537367d2c227374617473223a7b2272656769737465726564436f6d6d616e6473223a322c226772616e74656443' +
  '61706162696c6974696573223a5b2261646d696e225d2c2270656e64696e674576656e7473223a302c2264726f70' +
  '7065644576656e7473223a337d7d';

test('golden PINNED hex decodes to the exact DumpedWire fields', () => {
  const dumped = parseSnapshot(hexToBytes(GOLDEN_HEX));
  assert.deepEqual(dumped, {
    packageId: 'test.calculator',
    contractHash: GOLDEN_SNAPSHOT.contractHash,
    schemaGeneration: 7,
    commands: [
      { id: 1, name: 'addNumbers', capability: null },
      { id: 2, name: 'adminReset', capability: 'admin' },
    ],
    limits: { maxPayloadBytes: 1048576 },
    stats: {
      registeredCommands: 2,
      grantedCapabilities: ['admin'],
      pendingEvents: 0,
      droppedEvents: 3,
    },
  } satisfies DumpedWire);
});

test('golden hex equals the canonical serialization of its document (byte contract)', () => {
  // serializeSnapshot(golden 문서)이 PINNED hex 와 동일 — 파서와 직렬화기가
  // 같은 표준 형태(canonical JSON, 키 순서 고정)를 공유함을 바이트로 고정.
  const roundTrip = serializeSnapshot(parseSnapshot(hexToBytes(GOLDEN_HEX)));
  assert.equal(bytesToHex(roundTrip), GOLDEN_HEX);
});

test('string input decodes identically to bytes', () => {
  const fromString = parseSnapshot(JSON.stringify(GOLDEN_SNAPSHOT));
  assert.deepEqual(fromString, parseSnapshot(hexToBytes(GOLDEN_HEX)));
});

test('unregistered degenerate snapshot (null contract) is a valid DumpedWire', () => {
  const degenerate = {
    packageId: null,
    contractHash: null,
    schemaGeneration: null,
    commands: [],
    limits: { maxPayloadBytes: 1048576 },
    stats: {
      registeredCommands: 0,
      grantedCapabilities: [],
      pendingEvents: 0,
      droppedEvents: 0,
    },
  };
  const dumped = parseSnapshot(JSON.stringify(degenerate));
  assert.equal(dumped.packageId, null);
  assert.equal(dumped.contractHash, null);
  assert.equal(dumped.schemaGeneration, null);
  assert.deepEqual(dumped.commands, []);
});

test('truncated JSON fails loudly with position or engine message context', () => {
  const full = hexToBytes(GOLDEN_HEX);
  const truncated = full.slice(0, full.length - 40);
  assert.throws(
    () => parseSnapshot(truncated),
    (error: unknown) => {
      assert.ok(error instanceof RustraCommandError);
      assert.equal(error.code, 'inspector.invalid_snapshot');
      // V8은 "… at byte N"을, JSC(Bun)는 엔진 문구를 위치 대신 실어준다 —
      // 어느 쪽이든 loud 컨텍스트가 반드시 붙는다.
      assert.match(error.message, /truncated or malformed JSON (at byte \d+|\()/);
      return true;
    },
  );
});

test('malformed JSON from a string fails loudly', () => {
  assert.throws(
    () => parseSnapshot('{"packageId": "x", '),
    (error: unknown) => {
      assert.ok(error instanceof RustraCommandError);
      assert.equal(error.code, 'inspector.invalid_snapshot');
      return true;
    },
  );
});

test('wrong top-level shape (array) fails with unexpected_shape', () => {
  assert.throws(
    () => parseSnapshot('[1,2,3]'),
    (error: unknown) => {
      assert.ok(error instanceof RustraCommandError);
      assert.equal(error.code, 'inspector.unexpected_shape');
      assert.equal(error.message, "snapshot 'package' must be an object, got array");
      return true;
    },
  );
});

test('missing commands field fails loudly', () => {
  assert.throws(
    () => parseSnapshot('{"packageId": "x"}'),
    (error: unknown) => {
      assert.ok(error instanceof RustraCommandError);
      assert.equal(error.code, 'inspector.unexpected_shape');
      assert.equal(error.message, "snapshot 'commands' must be an array, got undefined");
      return true;
    },
  );
});

test('command entry with wrong types fails with a JSON-pointer path', () => {
  assert.throws(
    () =>
      parseSnapshot(
        '{"packageId":null,"contractHash":null,"schemaGeneration":null,"commands":[{"id":"one","name":"x","capability":null}],"limits":{"maxPayloadBytes":1},"stats":{"registeredCommands":1,"grantedCapabilities":[],"pendingEvents":0,"droppedEvents":0}}',
      ),
    (error: unknown) => {
      assert.ok(error instanceof RustraCommandError);
      assert.equal(error.code, 'inspector.unexpected_shape');
      assert.equal(error.message, "snapshot 'commands[0].id' must be a finite number, got string");
      return true;
    },
  );
});

test('command id out of u16 range fails', () => {
  assert.throws(
    () =>
      parseSnapshot(
        '{"packageId":null,"contractHash":null,"schemaGeneration":null,"commands":[{"id":65536,"name":"x","capability":null}],"limits":{"maxPayloadBytes":1},"stats":{"registeredCommands":1,"grantedCapabilities":[],"pendingEvents":0,"droppedEvents":0}}',
      ),
    (error: unknown) => {
      assert.ok(error instanceof RustraCommandError);
      assert.equal(error.code, 'inspector.unexpected_shape');
      assert.match(error.message, /must be a u16 integer, got 65536/);
      return true;
    },
  );
});

test('registeredCommands/commands.length divergence is rejected', () => {
  assert.throws(
    () =>
      parseSnapshot(
        '{"packageId":"x","contractHash":null,"schemaGeneration":0,"commands":[],"limits":{"maxPayloadBytes":1},"stats":{"registeredCommands":2,"grantedCapabilities":[],"pendingEvents":0,"droppedEvents":0}}',
      ),
    (error: unknown) => {
      assert.ok(error instanceof RustraCommandError);
      assert.equal(error.code, 'inspector.unexpected_shape');
      assert.equal(
        error.message,
        "snapshot 'stats.registeredCommands' (2) must equal 'commands.length' (0)",
      );
      return true;
    },
  );
});

test('non-string contractHash and non-number limits fail with field paths', () => {
  assert.throws(
    () =>
      parseSnapshot(
        '{"packageId":null,"contractHash":123,"schemaGeneration":null,"commands":[],"limits":{"maxPayloadBytes":1},"stats":{"registeredCommands":0,"grantedCapabilities":[],"pendingEvents":0,"droppedEvents":0}}',
      ),
    /'contractHash' must be a string or null, got number/,
  );
  assert.throws(
    () =>
      parseSnapshot(
        '{"packageId":null,"contractHash":null,"schemaGeneration":null,"commands":[],"limits":{"maxPayloadBytes":"1MiB"},"stats":{"registeredCommands":0,"grantedCapabilities":[],"pendingEvents":0,"droppedEvents":0}}',
      ),
    /'limits.maxPayloadBytes' must be a finite number, got string/,
  );
});

// 타입 표면 — DumpedWire 는 타입으로만 노출된다(값 표면은 parseSnapshot/
// serializeSnapshot 두 함수뿐). satisfies 로 타입 정합을 컴파일 타임에 검증했다.

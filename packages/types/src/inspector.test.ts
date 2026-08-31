// B1 인스펙터 스냅샷 파서 테스트.
// 저장소 표준(node:test + node:assert/strict, ESM) 사용 — 새 의존성 없음.
//
// golden hex 의 정준 소스는 **실제 Rust 캡처**다:
// crates/rustra/tests/fixtures/inspector-golden.hex.txt (committed 단일
// 아티팩트) — 갱신은 RUSTRA_UPDATE_GOLDEN=1 cargo test -p rustra
// --test inspector_golden. Rust 측 테스트(inspector_golden.rs)가 같은
// 파일로 자기 캡처를 대조하므로, 한쪽 blob 필드가 드리프트하면 양쪽
// 언어에서 동시에 실패한다.
//
// GOLDEN_DOC/HEX 아래의 인라인 상수는 serializeSnapshot의 바이트 계약
// (canonical JSON, 키 순서 고정)을 검증하는 보조 fixture 이다 — 교차 언어
// 링크는 위 fixture 파일 하나뿐이다.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * Rust↔TS 단일 아티팩트 — crates/rustra/tests/fixtures/inspector-golden.hex.txt.
 * 이 파일이 사라지면(드문 리포 구조 변경) 테스트가 실패한다 — 조용히 건너뛰지
 * 않는다(loud).
 */
function loadGoldenHex(): string {
  const path = join(
    import.meta.dir,
    '../../../crates/rustra/tests/fixtures/inspector-golden.hex.txt',
  );
  const text = readFileSync(path, 'utf8');
  const hex = text
    .split('\n')
    .filter((line) => !line.startsWith('#') && line.trim() !== '')
    .join('')
    .trim();
  assert.match(hex, /^[0-9a-f]+$/, 'fixture must contain a single lowercase hex line');
  return hex;
}

const GOLDEN_HEX = loadGoldenHex();

// ── 1. 교차 언어 링크: 실제 Rust 캡처의 디코드 ────────────────

test('RUST golden fixture (real capture) decodes to the exact DumpedWire fields', () => {
  const dumped = parseSnapshot(hexToBytes(GOLDEN_HEX));
  assert.deepEqual(dumped, {
    packageId: 'inspector.golden',
    // contractHash 값 자체는 Rust 측 테스트(inspector_golden.rs)가 같은
    // fixture 로 고정한다 — 여기선 형태(SHA-256 hex)만 검증한다.
    contractHash: dumped.contractHash,
    schemaGeneration: 0,
    commands: [{ id: 1, name: 'sum', capability: null }],
    limits: { maxPayloadBytes: 1048576 },
    stats: {
      registeredCommands: 1,
      grantedCapabilities: [],
      pendingEvents: 0,
      droppedEvents: 0,
    },
  } satisfies DumpedWire);
  assert.match(dumped.contractHash ?? '', /^[0-9a-f]{64}$/, 'contractHash is SHA-256 hex');
});

// ── 2. serializeSnapshot 바이트 계약(보조, 손 고정 canonical JSON) ──

/** serializeSnapshot canonical-JSON 계약용 보조 문서 — golden fixture 와 무관하다. */
const DOC = {
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

/** DOC 의 JSON 직렬화 바이트 — 위 객체와 독립적으로 손으로 고정한 hex. */
const DOC_HEX =
  '7b227061636b6167654964223a22746573742e63616c63756c61746f72222c22636f6e747261637448617368223a' +
  '22396632633061356535643462336132393138376636653564346333623261313930383037303630353034303330' +
  '32303166666665306430633062306130393038222c22736368656d6147656e65726174696f6e223a372c22636f6d' +
  '6d616e6473223a5b7b226964223a312c226e616d65223a226164644e756d62657273222c226361706162696c6974' +
  '79223a6e756c6c7d2c7b226964223a322c226e616d65223a2261646d696e5265736574222c226361706162696c69' +
  '7479223a2261646d696e227d5d2c226c696d697473223a7b226d61785061796c6f61644279746573223a31303438' +
  '3537367d2c227374617473223a7b2272656769737465726564436f6d6d616e6473223a322c226772616e74656443' +
  '61706162696c6974696573223a5b2261646d696e225d2c2270656e64696e674576656e7473223a302c2264726f70' +
  '7065644576656e7473223a337d7d';

test('serializeSnapshot reproduces the pinned canonical-JSON byte contract', () => {
  const roundTrip = serializeSnapshot(parseSnapshot(hexToBytes(DOC_HEX)));
  assert.equal(bytesToHex(roundTrip), DOC_HEX);
});

test('string input decodes identically to bytes', () => {
  const doc = parseSnapshot(hexToBytes(DOC_HEX));
  assert.deepEqual(doc, parseSnapshot(JSON.stringify(DOC)));
});

// ── 3. degenerate 스냅샷(미등록 패키지) ──────────────────────

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

// ── 4. loud 실패 계약 ───────────────────────────────────────

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

// ── 5. 카운터/한도 수치 검증 — 음수·소수·비안전 정수는 모두 loud ──

function expectCounterError(fn: () => unknown, expectedMessage: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof RustraCommandError);
    assert.equal(error.code, 'inspector.unexpected_shape');
    assert.equal(error.message, expectedMessage);
    return true;
  });
}

const COUNTER_BASE =
  '{"packageId":null,"contractHash":null,"schemaGeneration":0,"commands":[],"limits":{"maxPayloadBytes":1048576},"stats":{"registeredCommands":0,"grantedCapabilities":[],"pendingEvents":0,"droppedEvents":0}}';

test('negative limit and fractional counters fail with field-path context', () => {
  expectCounterError(
    () => parseSnapshot(COUNTER_BASE.replace('"maxPayloadBytes":1048576', '"maxPayloadBytes":-1')),
    "snapshot 'limits.maxPayloadBytes' must be a non-negative safe integer, got -1",
  );
  expectCounterError(
    () => parseSnapshot(COUNTER_BASE.replace('"pendingEvents":0', '"pendingEvents":2.5')),
    "snapshot 'stats.pendingEvents' must be a non-negative safe integer, got 2.5",
  );
});

test('negative generation, negative counters, and non-safe integers fail loudly', () => {
  expectCounterError(
    () => parseSnapshot(COUNTER_BASE.replace('"schemaGeneration":0', '"schemaGeneration":-3')),
    "snapshot 'schemaGeneration' must be a non-negative safe integer, got -3",
  );
  expectCounterError(
    () => parseSnapshot(COUNTER_BASE.replace('"droppedEvents":0', '"droppedEvents":-1')),
    "snapshot 'stats.droppedEvents' must be a non-negative safe integer, got -1",
  );
  expectCounterError(
    () =>
      parseSnapshot(
        COUNTER_BASE.replace('"registeredCommands":0', '"registeredCommands":9007199254740992'),
      ),
    "snapshot 'stats.registeredCommands' must be a non-negative safe integer, got 9007199254740992",
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

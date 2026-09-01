// B2 `rustra inspect` 커맨드 테스트.
// 저장소 표준(node:test + node:assert/strict, ESM) 사용 — 새 의존성 없음.
//
// parseSnapshot 자체의 Rust↔TS 파리티는 B1 교차 언어 골든
// (crates/rustra/tests/fixtures/inspector-golden.hex.txt)이 이미 게이트하므로,
// 여기선 serializeSnapshot 으로 손으로 만든 작은 스냅샷을 인라인 hex 로 고정해
// CLI 경로(파일 → hex/raw 판별 → 파싱 → 필드 트리 렌더)를 검증한다.
// 렌더 결과는 **전문 고정**(pinned)이다 — 출력 형태 드리프트를 조용히
// 통과시키지 않기 위한 계약.

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeSnapshot } from '@rustra/types';
import type { DumpedWire } from '@rustra/types';
import { decodeDump, formatInspectText, runInspect } from './cli-inspect.js';
import { printHelp } from './cli-help.js';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function withTempDir(fn: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'rustra-inspect-'));
  return Promise.resolve(fn(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

/** console.log 를 가로채고 fn 실행 후 모아둔 줄을 돌려준다(cli-init.test.ts 패턴). */
async function captureConsoleLog(fn: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return lines;
}

const SNAPSHOT: DumpedWire = {
  packageId: 'test.calculator',
  contractHash: 'ab'.repeat(32),
  schemaGeneration: 7,
  commands: [
    { id: 1, name: 'sum', capability: null },
    { id: 42, name: 'admin.reset', capability: 'admin' },
  ],
  limits: { maxPayloadBytes: 1048576 },
  stats: {
    registeredCommands: 2,
    grantedCapabilities: ['admin'],
    pendingEvents: 3,
    droppedEvents: 4,
  },
};

const SNAPSHOT_BYTES = serializeSnapshot(SNAPSHOT);
const SNAPSHOT_HEX = bytesToHex(SNAPSHOT_BYTES);

const EXPECTED_TEXT = [
  'packageId:        test.calculator',
  `contractHash:     ${'ab'.repeat(32)}`,
  'schemaGeneration: 7',
  '',
  'Commands (2):',
  '  - id: 1',
  '    name: sum',
  '    capability: -',
  '  - id: 42',
  '    name: admin.reset',
  '    capability: admin',
  '',
  'Limits:',
  '  maxPayloadBytes: 1048576',
  '',
  'Stats:',
  '  registeredCommands: 2',
  '  grantedCapabilities: admin',
  '  pendingEvents: 3',
  '  droppedEvents: 4',
].join('\n');

// ── 1. 정상 경로 — hex/raw/0x+공백 모두 같은 고정 텍스트 ──────────

test('inspect renders a hex dump file as the pinned field tree', async () => {
  await withTempDir(async (root) => {
    const file = join(root, 'dump.hex');
    writeFileSync(file, SNAPSHOT_HEX);
    const lines = await captureConsoleLog(() => runInspect([file]));
    assert.equal(lines.join('\n'), EXPECTED_TEXT);
  });
});

test('inspect accepts raw snapshot bytes with the same output', async () => {
  await withTempDir(async (root) => {
    const file = join(root, 'dump.bin');
    writeFileSync(file, Buffer.from(SNAPSHOT_BYTES));
    const lines = await captureConsoleLog(() => runInspect([file]));
    assert.equal(lines.join('\n'), EXPECTED_TEXT);
  });
});

test('inspect tolerates 0x prefix and whitespace inside hex dumps', async () => {
  await withTempDir(async (root) => {
    const file = join(root, 'dump-spaced.hex');
    writeFileSync(file, `0x${SNAPSHOT_HEX.replace(/(..)/g, '$1 ')}\n`);
    const lines = await captureConsoleLog(() => runInspect([file]));
    assert.equal(lines.join('\n'), EXPECTED_TEXT);
  });
});

test('inspect strips # comment lines — the golden fixture artifact format', async () => {
  await withTempDir(async (root) => {
    const file = join(root, 'dump-commented.hex');
    // crates/rustra/tests/fixtures/inspector-golden.hex.txt 와 같은 형태:
    // # 주석 헤더 + 단일 hex 라인. (교차 패키지 파일 참조 대신 인라인 재현)
    writeFileSync(file, `# dump header comment\n# second comment\n${SNAPSHOT_HEX}\n`);
    const lines = await captureConsoleLog(() => runInspect([file]));
    assert.equal(lines.join('\n'), EXPECTED_TEXT);
  });
});

// ── 2. loud 실패 — 위치·기여·필드 경로가 살아있는지 ──────────────

test('inspect fails loud on non-hex non-JSON bytes with path context', async () => {
  await withTempDir(async (root) => {
    const file = join(root, 'garbage.bin');
    writeFileSync(file, 'zz');
    await assert.rejects(() => runInspect([file]), /inspect: .*garbage\.bin: invalid snapshot/);
    await assert.rejects(() => runInspect([file]), /malformed JSON/);
  });
});

test('inspect fails loud on hex-encoded truncated JSON with a byte position', async () => {
  await withTempDir(async (root) => {
    const file = join(root, 'truncated.hex');
    const truncated = bytesToHex(serializeSnapshot(SNAPSHOT)).slice(0, 120);
    writeFileSync(file, truncated);
    await assert.rejects(() => runInspect([file]), /inspect: .*truncated\.hex: invalid snapshot/);
    await assert.rejects(() => runInspect([file]), /malformed JSON/);
  });
});

test('inspect fails loud on valid JSON with a wrong shape, naming the field path', async () => {
  await withTempDir(async (root) => {
    const file = join(root, 'wrong-shape.json');
    // 유일한 결함이 packageId 인 문서 — 앞선 commands 검사가 아니라 이 필드 경로를 가리킨다.
    const document = { ...SNAPSHOT, packageId: 123 };
    writeFileSync(file, JSON.stringify(document));
    await assert.rejects(
      () => runInspect([file]),
      /inspect: .*wrong-shape\.json: snapshot 'packageId' must be a string or null, got number/,
    );
  });
});

test('inspect fails loud on a missing file, keeping the underlying reason', async () => {
  await withTempDir(async (root) => {
    const file = join(root, 'dump-missing.hex');
    await assert.rejects(() => runInspect([file]), /inspect: .*dump-missing\.hex: ENOENT/);
  });
});

// ── 3. 인자 계약 — positional 수, --help, 미지 플래그 ────────────

test('inspect rejects zero or multiple dump files', async () => {
  await withTempDir(async (root) => {
    await assert.rejects(() => runInspect([]), /Provide one snapshot dump file/);
    await assert.rejects(
      () => runInspect([join(root, 'a.hex'), join(root, 'b.hex')]),
      /Provide one snapshot dump file/,
    );
  });
});

test('inspect --help stays silent internally; cli-help owns the usage text', async () => {
  await withTempDir(async (root) => {
    // help 관례 통일 — 내부 분기는 아무것도 출력하지 않고 돌아온다(출력은
    // cli-main). positional 이 0개·2개여도 help 가 우선하며 파일을 읽지 않는다.
    const lines = await captureConsoleLog(() => runInspect(['--help']));
    const short = await captureConsoleLog(() => runInspect(['-h']));
    const extra = await captureConsoleLog(() => runInspect(['a.hex', 'b.hex', '--help']));
    assert.equal(lines.join('\n'), '');
    assert.equal(short.join('\n'), '');
    assert.equal(extra.join('\n'), '');
    // 도움말 호출은 존재하지 않는 파일을 읽으려 하지 않는다 — 아무것도 던지지 않음.
    assert.equal(readdirSync(root).length, 0);
    // 단일 사용자용 usage 출처 — cli-help.ts 텍스트가 실제로 존재하는지 게이트.
    const usage = await captureConsoleLog(() => printHelp('inspect'));
    assert.match(usage.join('\n'), /Usage: rustra inspect <file>/);
  });
});

test('inspect rejects unknown flags with the arg-parser hint', async () => {
  await withTempDir(async (root) => {
    const file = join(root, 'dump.hex');
    writeFileSync(file, SNAPSHOT_HEX);
    await assert.rejects(() => runInspect([file, '--rawe']), /Unknown inspect option: --rawe/);
    await assert.rejects(() => runInspect([file, '--rawe']), /Run "rustra inspect --help"/);
  });
});

// ── 4. 렌더 단위 — 미등록 스냅샷(null 필드)과 빈 목록 표기 ────────

test('formatInspectText renders null identity fields and empty lists deterministically', () => {
  const text = formatInspectText({
    packageId: null,
    contractHash: null,
    schemaGeneration: null,
    commands: [],
    limits: { maxPayloadBytes: 4096 },
    stats: {
      registeredCommands: 0,
      grantedCapabilities: [],
      pendingEvents: 0,
      droppedEvents: 0,
    },
  });
  assert.match(text, /packageId: {8}-/);
  assert.match(text, /contractHash: {5}-/);
  assert.match(text, /schemaGeneration: -/);
  assert.match(text, /Commands \(0\):/);
  assert.match(text, /grantedCapabilities: \(none\)/);
});

// ── 5. decodeDump 단위 — hex/raw 두 해석이 같은 바이트로 수렴 ─────

test('decodeDump converges hex text and raw bytes to the identical byte array', () => {
  const fromHex = decodeDump(Buffer.from(SNAPSHOT_HEX, 'utf8'));
  const fromRaw = decodeDump(SNAPSHOT_BYTES);
  assert.deepEqual(Array.from(fromHex), Array.from(SNAPSHOT_BYTES));
  assert.deepEqual(Array.from(fromHex), Array.from(fromRaw));
});

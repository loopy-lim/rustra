// codegen 텍스트 모드의 스테일 런타임 바이너리 힌트 — 감사 #3("조용한 성공 후
// contract.mismatch 사망")의 최소 컷. codegen 은 TS/C++ 만 다시 렌더하고 실제
// invoke 를 서브하는 런타임 바이너리는 재빌드되지 않는다. drift((updated) 표기)
// 가 관측된 텍스트 모드에서만 cargo build 안내를 출력한다 — JSON 계약에는
// 필드를 추가하지 않는다(cli-codegen-json.test.ts 가 스키마 핀).
//
// cargo 는 cli-codegen-json.test.ts 의 fake 스크립트 패턴을 따른다(metadata →
// generate bin 보고, run → schema.json 복사). 실제 cargo 빌드는 하지 않는다.

import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodegen, staleBinaryHint } from './cli-codegen.js';

const FAKE_BIN = 'fake-cargo-bin';

const SCHEMA = {
  packageId: 'app.hint',
  commands: [
    {
      name: 'echo',
      inputType: 'EchoInput',
      outputType: 'EchoOutput',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
      outputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    },
  ],
};

function seedProject(root: string): string {
  const project = join(root, 'proj');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(join(project, 'generated'), { recursive: true });
  mkdirSync(join(root, FAKE_BIN), { recursive: true });
  writeFileSync(join(project, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n');
  writeFileSync(join(project, 'src', 'lib.rs'), 'fn main() {}\n');
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({ name: 'proj', private: true, workspaces: [], dependencies: {} }),
  );
  writeFileSync(
    join(project, 'rustra.json'),
    JSON.stringify({ schema: './generated/schema.json', output: './generated', node: {} }),
  );
  writeFileSync(join(root, 'schema.json'), JSON.stringify(SCHEMA));
  const fakeCargo = [
    '#!/bin/bash',
    'if [ "$1" = "metadata" ]; then',
    '  manifest=""; prev=""',
    '  for a in "$@"; do [ "$prev" = "--manifest-path" ] && manifest="$a"; prev="$a"; done',
    '  dir=$(dirname "$manifest")',
    '  printf \'{"target_directory":"%s/target","packages":[{"name":"x","manifest_path":"%s",',
    '"targets":[{"name":"generate","crate_types":["bin"],"kind":["bin"]}]}]}\\n\' "$dir" "$manifest"',
    '  exit 0',
    'fi',
    'if [ "$1" = "run" ]; then',
    '  manifest=""; prev=""',
    '  for a in "$@"; do [ "$prev" = "--manifest-path" ] && manifest="$a"; prev="$a"; done',
    '  dir=$(dirname "$manifest")',
    '  mkdir -p "$dir/generated"',
    '  cp "$FAKE_SCHEMA_FILE" "$dir/generated/schema.json"',
    '  exit 0',
    'fi',
    'echo "unexpected cargo invocation: $*" >&2',
    'exit 1',
  ].join('\n');
  const fakePath = join(root, FAKE_BIN, 'cargo');
  writeFileSync(fakePath, fakeCargo);
  chmodSync(fakePath, 0o755);
  return project;
}

test('staleBinaryHint fires only on the (updated) marker and names cargo build + contract.mismatch', () => {
  const hint = staleBinaryHint(['generated/types.ts (updated)', 'generated/node.ts']);
  assert.match(hint ?? '', /cargo build/);
  assert.match(hint ?? '', /contract\.mismatch/);
  assert.equal(staleBinaryHint(['generated/types.ts']), null, 'new files are not drift — no hint');
  assert.equal(
    staleBinaryHint(['generated/types.ts (unchanged)']),
    null,
    'clean rerun is not drift — no hint',
  );
  assert.equal(staleBinaryHint([]), null, 'nothing written — no hint');
});

test('codegen text mode prints the stale runtime binary hint only when regeneration drifts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-codegen-hint-'));
  const originalPath = process.env.PATH;
  let stdout: string[] = [];
  const restore = (() => {
    const originalLog = console.log;
    console.log = (line: unknown) => stdout.push(String(line));
    return () => {
      console.log = originalLog;
    };
  })();
  try {
    const project = seedProject(root);
    process.env.PATH = `${join(root, FAKE_BIN)}:${originalPath}`;
    process.env.FAKE_SCHEMA_FILE = join(root, 'schema.json');

    // 1차 — 신규 생성((updated) 없음) → 힌트가 없어야 한다.
    stdout = [];
    await runCodegen(['--config', join(project, 'rustra.json')]);
    assert.equal(
      stdout.some((line) => line.includes('contract.mismatch')),
      false,
      `fresh generation must not hint, got: ${JSON.stringify(stdout)}`,
    );

    // 2차 — 생성물 변조 후 재실행((updated) 상황) → cargo build 힌트.
    const typesPath = join(project, 'generated', 'types.ts');
    writeFileSync(typesPath, readFileSync(typesPath, 'utf8') + '\n// drift probe\n');
    stdout = [];
    await runCodegen(['--config', join(project, 'rustra.json')]);
    const hint = stdout.find((line) => line.includes('contract.mismatch'));
    assert.ok(hint, `drifted rerun must hint, got: ${JSON.stringify(stdout)}`);
    assert.match(hint, /cargo build/);
  } finally {
    restore();
    delete process.env.FAKE_SCHEMA_FILE;
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test('codegen text mode lists written files with (unchanged)/(updated) markers like generate', async () => {
  // 감사 A3 — codegen 은 주력 경로인데 quiet 로 목록을 삼키면 drift 표기가
  // stale 힌트에만 의존한다. generate 와 동일한 파일 목록·표기를 출력해야 한다.
  const root = mkdtempSync(join(tmpdir(), 'rustra-codegen-files-'));
  const originalPath = process.env.PATH;
  const stdout: string[] = [];
  const restore = (() => {
    const originalLog = console.log;
    console.log = (line: unknown) => stdout.push(String(line));
    return () => {
      console.log = originalLog;
    };
  })();
  try {
    const project = seedProject(root);
    process.env.PATH = `${join(root, FAKE_BIN)}:${originalPath}`;
    process.env.FAKE_SCHEMA_FILE = join(root, 'schema.json');

    // 1차 — 신규 생성이어도 무엇을 썼는지 목록이 나와야 한다.
    stdout.length = 0;
    await runCodegen(['--config', join(project, 'rustra.json')]);
    assert.ok(
      stdout.some((line) => /^Generated TypeScript files in /.test(line)),
      `header line expected, got: ${JSON.stringify(stdout)}`,
    );
    assert.ok(
      stdout.some((line) => /^\s+types\.ts/.test(line)),
      `types.ts entry expected, got: ${JSON.stringify(stdout)}`,
    );
    assert.ok(
      stdout.some((line) => /^\s+node\.ts/.test(line)),
      `node.ts entry expected, got: ${JSON.stringify(stdout)}`,
    );

    // 2차 — 동일 스키마 재생성은 (unchanged) 표기로 무음 드리프트를 없앤다.
    stdout.length = 0;
    await runCodegen(['--config', join(project, 'rustra.json')]);
    assert.ok(
      stdout.some((line) => /^\s+types\.ts \(unchanged\)/.test(line)),
      `(unchanged) marker expected, got: ${JSON.stringify(stdout)}`,
    );
  } finally {
    restore();
    delete process.env.FAKE_SCHEMA_FILE;
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
});

// codegen --format json 의 drift 신호 — 실제 codegen 산출물을 변조해 재실행하는
// e2e 게이트. drift 는 runGenerate 의 "(updated)" 표기 문자열과 결합해 있으므로,
// 표기가 바뀌면 이 테스트가 깨진다(조용한 항상-false 로의 퇴행을 차단하는 핀).
//
// cargo 는 dev-parity-wiring.test.ts 의 fake 스크립트 패턴을 따른다(metadata →
// generate bin 보고, run → schema.json 복사). 실제 cargo 빌드는 하지 않는다.

import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodegen } from './cli-codegen.js';

const FAKE_BIN = 'fake-cargo-bin';

const SCHEMA = {
  packageId: 'app.drift',
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

test('codegen --explain --format json carries the schemaVersion:1 surface map', async () => {
  // 신형 explain shape 핀 — 구형 `{command:'codegen', explain}` 임의 shape 로의
  // 회귀를 잡는다. explain 은 config 해석만 하므로 cargo 없이 순수 조회 경로다.
  const root = mkdtempSync(join(tmpdir(), 'rustra-codegen-explain-'));
  const originalLog = console.log;
  const stdout: string[] = [];
  console.log = (line: unknown) => stdout.push(String(line));
  try {
    const project = seedProject(root);
    await runCodegen(['--config', join(project, 'rustra.json'), '--explain', '--format', 'json']);
    const report = JSON.parse(stdout.at(-1)!) as {
      schemaVersion: number;
      command?: string;
      explain: unknown[];
    };
    assert.equal(report.schemaVersion, 1, `got: ${stdout.at(-1)}`);
    assert.equal(report.command, undefined, 'legacy command field must not return');
    assert.ok(Array.isArray(report.explain) && report.explain.length > 0);
  } finally {
    console.log = originalLog;
    rmSync(root, { recursive: true, force: true });
  }
});

test('codegen --format json reports drift:true when regeneration rewrites existing files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-codegen-drift-'));
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

    // 1차 — 신규 생성. drift 는 false 여야 한다.
    stdout = [];
    await runCodegen(['--config', join(project, 'rustra.json'), '--format', 'json']);
    const first = JSON.parse(stdout.at(-1)!) as { drift: boolean; written: string[] };
    assert.equal(first.drift, false, `first run must not drift, got: ${stdout.at(-1)}`);
    assert.ok(
      first.written.every((entry) => !entry.endsWith('(updated)')),
      `first run writes new files without (updated), got: ${JSON.stringify(first.written)}`,
    );

    // 2차 — 변조 없이 재실행. 내용이 같으므로 (unchanged), drift=false.
    stdout = [];
    await runCodegen(['--config', join(project, 'rustra.json'), '--format', 'json']);
    const steady = JSON.parse(stdout.at(-1)!) as { drift: boolean; written: string[] };
    assert.equal(steady.drift, false, `clean rerun must not drift, got: ${stdout.at(-1)}`);
    assert.ok(
      steady.written.some((entry) => entry.endsWith('(unchanged)')),
      `clean rerun must carry (unchanged) entries, got: ${JSON.stringify(steady.written)}`,
    );

    // 3차 — 생성물 변조 후 재실행. (updated) 표기 상황에서 drift=true 여야 한다 —
    // 이 결합이 이 테스트의 대상이다. 표기 문자열을 바꾸면 여기서 깨진다.
    const typesPath = join(project, 'generated', 'types.ts');
    writeFileSync(typesPath, readFileSync(typesPath, 'utf8') + '\n// drift probe\n');
    stdout = [];
    await runCodegen(['--config', join(project, 'rustra.json'), '--format', 'json']);
    const drifted = JSON.parse(stdout.at(-1)!) as { drift: boolean; written: string[] };
    assert.equal(drifted.drift, true, `tampered rerun must drift, got: ${stdout.at(-1)}`);
    assert.ok(
      drifted.written.some((entry) => entry.endsWith('(updated)')),
      `drift signal must be coupled to the (updated) marker, got: ${JSON.stringify(drifted.written)}`,
    );
    assert.ok(
      drifted.written.some((entry) => entry.endsWith('(unchanged)')),
      `untouched files stay (unchanged), got: ${JSON.stringify(drifted.written)}`,
    );
  } finally {
    restore();
    delete process.env.FAKE_SCHEMA_FILE;
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
});

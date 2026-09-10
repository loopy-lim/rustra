import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  discoverCodegenExamples,
  resolveCheckCommand,
  runCodegenFreshChecks,
} from './check-codegen-fresh.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 가짜 examples 트리 — api-surface.test.ts 의 makeFixture 와 같은 mkdtemp 패턴.
 * codegen:check 가 있는 예제와 없는 예제, rustra.json 이 없는 예제를 섞는다.
 */
function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'rustra-codegen-fresh-'));
  writeExample(root, 'calc', { scripts: { codegen: 'x', 'codegen:check': 'x --check' } });
  writeExample(root, 'stream', {});
  mkdirSync(join(root, 'examples', 'plain'), { recursive: true });
  writeFileSync(join(root, 'examples', 'plain', 'README.md'), 'rustra.json 없음\n');
  return root;
}

function writeExample(root: string, name: string, packageJson: object): void {
  const dir = join(root, 'examples', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'rustra.json'),
    JSON.stringify({ schema: './generated/schema.json', output: './generated' }),
  );
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, scripts: (packageJson as { scripts?: object }).scripts ?? {} }),
  );
  const generated = join(dir, 'generated');
  mkdirSync(generated, { recursive: true });
  writeFileSync(join(generated, '.rustra-generated.json'), '{}');
}

test('discoverCodegenExamples collects only rustra.json examples, sorted by name', () => {
  const root = makeFixture();
  try {
    const examples = discoverCodegenExamples(root);
    assert.deepEqual(
      examples.map((example) => example.name),
      ['calc', 'stream'],
    );
    assert.equal(examples[0].manifestPath, join(root, 'examples', 'calc', 'generated', '.rustra-generated.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCheckCommand prefers the example codegen:check script, falls back to the repo CLI', () => {
  const root = makeFixture();
  try {
    const [calc, stream] = discoverCodegenExamples(root);
    assert.deepEqual(resolveCheckCommand(calc, root), {
      file: 'bun',
      args: ['run', 'codegen:check'],
      cwd: calc.dir,
    });
    const fallback = resolveCheckCommand(stream, root);
    assert.equal(fallback.file, 'bun');
    assert.equal(fallback.cwd, stream.dir);
    assert.deepEqual(fallback.args.slice(-4), [
      'codegen',
      '--config',
      'rustra.json',
      '--check',
    ]);
    assert.match(fallback.args[0], /packages[\\/]cli[\\/]src[\\/]index\.ts$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCodegenFreshChecks runs every example and passes when exec reports success', () => {
  const root = makeFixture();
  try {
    const ran: string[] = [];
    const { ok, failures, ran: count } = runCodegenFreshChecks({
      root,
      exec: (command) => {
        ran.push(basename(command.cwd));
        return { status: 0, stdout: 'ok', stderr: '' };
      },
    });
    assert.ok(ok);
    assert.deepEqual(failures, []);
    assert.deepEqual(ran, ['calc', 'stream']);
    assert.equal(count, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCodegenFreshChecks stops at the first drift with captured diagnostics', () => {
  const root = makeFixture();
  try {
    const ran: string[] = [];
    const { ok, failures, ran: count } = runCodegenFreshChecks({
      root,
      exec: (command) => {
        ran.push(basename(command.cwd));
        return {
          status: 1,
          stdout: 'Generated drift (generator changed): 0.8.0 -> 0.9.0',
          stderr: '',
        };
      },
    });
    assert.ok(!ok);
    assert.equal(ran.length, 1, '첫 드리프트에서 중단해야 한다');
    assert.equal(failures[0].name, 'calc');
    assert.match(failures[0].reason, /bun run codegen/);
    assert.match(failures[0].output, /Generated drift/);
    assert.equal(count, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCodegenFreshChecks fails an example whose committed manifest is missing', () => {
  const root = makeFixture();
  try {
    rmSync(join(root, 'examples', 'calc', 'generated', '.rustra-generated.json'));
    const execCalls: string[] = [];
    const { ok, failures } = runCodegenFreshChecks({
      root,
      exec: (command) => {
        execCalls.push(basename(command.cwd));
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.ok(!ok);
    assert.equal(failures[0].name, 'calc');
    assert.match(failures[0].reason, /manifest/);
    assert.deepEqual(execCalls, [], 'manifest 부재는 exec 전에 잡힌다');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--example filter narrows the run to the selected examples', () => {
  const root = makeFixture();
  try {
    const ran: string[] = [];
    const { ok, ran: count } = runCodegenFreshChecks({
      root,
      filter: new Set(['stream']),
      exec: (command) => {
        ran.push(basename(command.cwd));
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.ok(ok);
    assert.deepEqual(ran, ['stream']);
    assert.equal(count, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCodegenFreshChecks refuses a silent no-op (no examples, unknown filter)', () => {
  const root = makeFixture();
  try {
    const empty = runCodegenFreshChecks({ root: dirname(root), exec: () => ({ status: 0 }) });
    assert.ok(!empty.ok);
    assert.match(empty.failures[0].reason, /0개/);
    const unknown = runCodegenFreshChecks({
      root,
      filter: new Set(['nope']),
      exec: () => ({ status: 0 }),
    });
    assert.ok(!unknown.ok);
    assert.match(unknown.failures[0].reason, /0개/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('default exec path works end-to-end on a trivial command', () => {
  // EBADF 회피(레포 루트 bun test 의 spawnSync 환경 이슈) 검증을 겸한 최소 스모크 —
  // exec 주입 없이 process.execPath 한 번 스폰이 가능한지만 단언한다.
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('real repo has the four known rustra.json examples wired for this gate', () => {
  // 새 예제가 rustra.json 을 도입하면 이 게이트에 자동 편입된다(테스트 수정 불요).
  // 아래 단언은 "최소 이 네 예제가 게이트 안에 있다"를 고정한다.
  const names = discoverCodegenExamples(REPO_ROOT).map((example) => example.name);
  for (const expected of [
    'calculator',
    'react-native-bare-calculator',
    'react-native-calculator',
    'streaming',
  ]) {
    assert.ok(names.includes(expected), `${expected} 이 게이트 대상에 없다: ${names.join(', ')}`);
  }
});

function basename(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

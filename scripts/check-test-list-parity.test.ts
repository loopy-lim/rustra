import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  checkCliTestCoverage,
  checkCoverageTsCoverage,
  checkDistTsCoverage,
} from './check-test-list-parity.mjs';

const NODE_TS_SCRIPT =
  'tsc -p examples/calculator/tsconfig.json && node --test dist-ts/examples/calculator/ts/*.test.js dist-ts/examples/crud/ts/*.test.js';

test('checkDistTsCoverage: glob이 이밋 전부를 커버하고 stale이 없으면 통과', () => {
  const emitted = [
    'dist-ts/examples/calculator/ts/a.test.js',
    'dist-ts/examples/crud/ts/b.test.js',
  ];
  const { missing, stale } = checkDistTsCoverage(NODE_TS_SCRIPT, emitted);
  assert.deepEqual(missing, []);
  assert.deepEqual(stale, []);
});

test('checkDistTsCoverage: 새 이밋이 glob 밖 디렉터리면 missing으로 적발', () => {
  const emitted = ['dist-ts/examples/streaming/ts/new.test.js'];
  const { missing } = checkDistTsCoverage(NODE_TS_SCRIPT, emitted);
  assert.deepEqual(missing, ['dist-ts/examples/streaming/ts/new.test.js']);
});

test('checkDistTsCoverage: 명시 나열이 디스크보다 앞서면 stale로 적발', () => {
  const script =
    'node --test dist-ts/examples/calculator/ts/a.test.js dist-ts/examples/calculator/ts/ghost.test.js';
  const emitted = ['dist-ts/examples/calculator/ts/a.test.js'];
  const { stale } = checkDistTsCoverage(script, emitted);
  assert.deepEqual(stale, ['dist-ts/examples/calculator/ts/ghost.test.js']);
});

test('checkCliTestCoverage: bun:test 전용 테스트는 src 대응 편입으로 충족', () => {
  const script =
    'bun run test:compile && node --test dist-test/a.test.js && bun test src/generate-sync.test.ts';
  const emittedDistTest = ['dist-test/a.test.js', 'dist-test/generate-sync.test.js'];
  const emittedSrcTests = ['src/generate-sync.test.ts'];
  const { missing, stale } = checkCliTestCoverage(script, emittedDistTest, emittedSrcTests);
  assert.deepEqual(missing, []);
  assert.deepEqual(stale, []);
});

test('checkCliTestCoverage: node 전용 + bun 전용 모두 누락되면 missing으로 적발', () => {
  const script =
    'bun run test:compile && node --test dist-test/a.test.js && bun test src/keep.test.ts';
  const emittedDistTest = [
    'dist-test/a.test.js',
    'dist-test/new-node.test.js',
    'dist-test/bunonly.test.js',
  ];
  const emittedSrcTests = ['src/keep.test.ts'];
  const { missing } = checkCliTestCoverage(script, emittedDistTest, emittedSrcTests);
  assert.deepEqual(missing.sort(), ['dist-test/bunonly.test.js', 'dist-test/new-node.test.js']);
});

test('checkCliTestCoverage: bun 세그먼트의 유령 src 참조는 stale로 적발', () => {
  const script =
    'bun run test:compile && node --test dist-test/a.test.js && bun test src/ghost.test.ts';
  const { stale } = checkCliTestCoverage(script, ['dist-test/a.test.js'], []);
  assert.deepEqual(stale, ['src/ghost.test.ts']);
});

test('checkCoverageTsCoverage: react 테스트 전부 반영 시 통과, 누락 시 missing', () => {
  const emitted = ['packages/react/src/index.test.ts', 'packages/react/src/lifecycle.test.ts'];
  const full =
    'bun test --coverage packages/react/src/index.test.ts packages/react/src/lifecycle.test.ts';
  assert.deepEqual(checkCoverageTsCoverage(full, emitted), { missing: [], stale: [] });

  const partial = 'bun test --coverage packages/react/src/index.test.ts';
  const { missing, stale } = checkCoverageTsCoverage(partial, emitted);
  assert.deepEqual(missing, ['packages/react/src/lifecycle.test.ts']);
  assert.deepEqual(stale, []);
});

test('checkScriptcVersionPin: 핀과 CI 리터럴이 일치하면 통과', async () => {
  const { checkScriptcVersionPin } = await import('./check-test-list-parity.mjs');
  const root = await mkdtemp(join(tmpdir(), 'rustra-parity-'));
  try {
    const runSh = join(root, 'run.sh');
    const ci = join(root, 'ci.yml');
    await writeFile(runSh, 'SCRIPTC_VERSION=0.2.1\n');
    await writeFile(ci, '- run: npm install -g scriptc@0.2.1\n');
    assert.deepEqual(await checkScriptcVersionPin({ runShPath: runSh, ciPath: ci }), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checkScriptcVersionPin: 어느 한쪽만 올리면 드리프트로 적발', async () => {
  const { checkScriptcVersionPin } = await import('./check-test-list-parity.mjs');
  const root = await mkdtemp(join(tmpdir(), 'rustra-parity-'));
  try {
    const runSh = join(root, 'run.sh');
    const ci = join(root, 'ci.yml');
    await writeFile(runSh, 'SCRIPTC_VERSION=0.3.0\n');
    await writeFile(ci, '- run: npm install -g scriptc@0.2.1\n');
    const reports = await checkScriptcVersionPin({ runShPath: runSh, ciPath: ci });
    assert.equal(reports.length, 1);
    assert.match(reports[0], /scriptc@0\.3\.0/);
    // 핀 자체가 사라지면 출처 상실로 실패한다.
    await writeFile(runSh, 'cargo build\n');
    assert.match(
      (await checkScriptcVersionPin({ runShPath: runSh, ciPath: ci }))[0],
      /missing SCRIPTC_VERSION/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

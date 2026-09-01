import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'bun:test';
import { collectDocs, stripGeneratedHeader, verifyDocs } from './docs-gate.mjs';

// 임시 디렉토리 fixture — 저장소의 실제 docs는 절대 건드리지 않는다(hermetic).
let tmpRoot = '';

function makeTmp() {
  tmpRoot = mkdtempSync(join(tmpdir(), 'docs-gate-test-'));
  return tmpRoot;
}

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = '';
  }
});

// 생성물의 자기서술 헤더 8줄 + 뒤따르는 빈 줄 (examples/calculator/generated 실물과 동일 형태)
const GENERATED_HEADER = [
  '// ── rustra generated ────────────────────────────────────────',
  '// File:   types.ts',
  '// Source: schema.json (single source of truth for this file)',
  '// Regen:  rustra codegen --config rustra.json',
  '// Stage:  rust-probe schema → ts renderer',
  '// DO NOT EDIT — changes will be overwritten and fail codegen --check.',
  '// ────────────────────────────────────────────────────────────',
  '',
].join('\n');

/** 마커 규약 그대로의 docs:sync 영역 본문을 만든다. */
function region(path, bodyLines, lang = 'ts') {
  return [
    `<!-- docs:sync:begin ${path} -->`,
    '',
    '<!-- prettier-ignore -->',
    `\`\`\`${lang}`,
    ...bodyLines,
    '```',
    '',
    '<!-- docs:sync:end -->',
  ].join('\n');
}

/** root 밑에 문서와 참조 파일을 쓰고 root를 돌려준다. */
function fixture(docRel, docText, refRel, refBody) {
  const root = makeTmp();
  const docPath = join(root, docRel);
  mkdirSync(docPath.slice(0, docPath.lastIndexOf('/')), { recursive: true });
  writeFileSync(docPath, docText);
  const refPath = join(root, refRel);
  mkdirSync(refPath.slice(0, refPath.lastIndexOf('/')), { recursive: true });
  writeFileSync(refPath, refBody);
  return root;
}

test('잘 정합된 영역은 통과한다 — 8줄 생성 헤더 뒤 본문과 일치', () => {
  const body = ['export type A = number;', 'export const x = 1;'];
  const root = fixture(
    'docs/guide.md',
    `intro\n\n${region('gen/types.ts', body)}\n\noutro\n`,
    'gen/types.ts',
    `${GENERATED_HEADER}${body.join('\n')}\n`,
  );
  const report = verifyDocs(root);
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  assert.deepEqual(
    report.regions.map((r) => [r.doc, r.path]),
    [['docs/guide.md', 'gen/types.ts']],
  );
});

test('헤더 없는 참조 파일은 전체가 본문과 비교된다', () => {
  const body = ['plain content', 'second line'];
  const root = fixture('docs/a.md', region('f.txt', body), 'f.txt', `${body.join('\n')}\n`);
  const report = verifyDocs(root);
  assert.equal(report.ok, true, JSON.stringify(report.failures));
});

test('본문이 드리프트하면 실패하고 파일·경로·첫 불일치 줄을 이름으로 보고한다', () => {
  const body = ['export type A = number;', 'export const x = 1;'];
  const drifted = ['export type A = number;', 'export const x = 2;'];
  const root = fixture(
    'docs/guide.md',
    region('gen/types.ts', drifted),
    'gen/types.ts',
    `${GENERATED_HEADER}${body.join('\n')}\n`,
  );
  const report = verifyDocs(root);
  assert.equal(report.ok, false);
  assert.equal(report.failures.length, 1);
  const f = report.failures[0];
  assert.match(f.message, /docs\/guide\.md/);
  assert.match(f.message, /gen\/types\.ts/);
  assert.match(f.message, /line 2 differs/);
  assert.match(f.message, /x = 2/);
  assert.match(f.message, /x = 1/);
});

test('줄 끝 공백 하나까지도 드리프트로 잡는다 (byte-for-byte)', () => {
  const body = ['const a = 1;', 'const b = 2;'];
  const root = fixture(
    'docs/a.md',
    region('f.ts', ['const a = 1;', 'const b = 2; ']),
    'f.ts',
    `${GENERATED_HEADER}${body.join('\n')}\n`,
  );
  const report = verifyDocs(root);
  assert.equal(report.ok, false);
  assert.match(report.failures[0].message, /line 2 differs/);
});

test('참조 파일이 없으면 실패하고 경로를 이름으로 보고한다', () => {
  const root = fixture('docs/a.md', region('gen/missing.ts', ['x']), 'unrelated.txt', 'x\n');
  const report = verifyDocs(root);
  assert.equal(report.ok, false);
  assert.match(report.failures[0].message, /gen\/missing\.ts/);
});

test('끝나지 않은 begin 마커는 실패한다', () => {
  const root = makeTmp();
  mkdirSync(join(root, 'docs'));
  writeFileSync(
    join(root, 'docs/a.md'),
    ['<!-- docs:sync:begin gen/types.ts -->', '', '<!-- prettier-ignore -->', '```ts', 'x'].join(
      '\n',
    ),
  );
  const report = verifyDocs(root);
  assert.equal(report.ok, false);
  const f = report.failures[0];
  assert.match(f.message, /docs\/a\.md/);
  assert.match(f.message, /docs:sync:end/);
});

test('begin 없는 end 마커는 실패한다', () => {
  const root = makeTmp();
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs/a.md'), 'text\n\n<!-- docs:sync:end -->\n');
  const report = verifyDocs(root);
  assert.equal(report.ok, false);
  assert.match(report.failures[0].message, /docs:sync:begin/);
  assert.match(report.failures[0].message, /docs\/a\.md/);
});

test('prettier-ignore가 빠진 구조는 구조 위반으로 실패한다', () => {
  const body = ['x'];
  const broken = [
    '<!-- docs:sync:begin gen/types.ts -->',
    '',
    '```ts',
    ...body,
    '```',
    '',
    '<!-- docs:sync:end -->',
  ].join('\n');
  const root = fixture('docs/a.md', broken, 'gen/types.ts', `${GENERATED_HEADER}x\n`);
  const report = verifyDocs(root);
  assert.equal(report.ok, false);
  assert.match(report.failures[0].message, /prettier-ignore/);
});

test('본문 뒤 닫는 펜스가 없으면(곧장 end 마커) 구조 위반으로 실패한다', () => {
  const broken = [
    '<!-- docs:sync:begin gen/types.ts -->',
    '',
    '<!-- prettier-ignore -->',
    '```ts',
    'x',
    '<!-- docs:sync:end -->',
  ].join('\n');
  const root = fixture('docs/a.md', broken, 'gen/types.ts', `${GENERATED_HEADER}x\n`);
  const report = verifyDocs(root);
  assert.equal(report.ok, false);
  assert.match(report.failures[0].message, /펜스|fence|```/);
});

test('마커 없는 문서는 그대로 통과한다 (점진 채택)', () => {
  const root = fixture('docs/plain.md', '# 그냥 문서\n\n내용\n', 'unused.txt', 'unused\n');
  const report = verifyDocs(root);
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  assert.equal(report.regions.length, 0);
});

test('docs/plans/ 아래는 스캔에서 제외된다', () => {
  const root = makeTmp();
  mkdirSync(join(root, 'docs/plans'), { recursive: true });
  writeFileSync(
    join(root, 'docs/plans/roadmap.md'),
    '<!-- docs:sync:begin x.ts -->\n\n<!-- docs:sync:end -->\n',
  );
  const docs = collectDocs(join(root, 'docs'));
  assert.deepEqual(docs, []);
});

test('여러 실패는 하나만이 아니라 전부 보고된다', () => {
  const root = makeTmp();
  mkdirSync(join(root, 'docs'));
  writeFileSync(
    join(root, 'docs/a.md'),
    [
      '<!-- docs:sync:begin missing-1.ts -->',
      '',
      '<!-- prettier-ignore -->',
      '```ts',
      'x',
      '```',
      '',
      '<!-- docs:sync:end -->',
      '',
      '<!-- docs:sync:begin missing-2.ts -->',
      '',
      '<!-- prettier-ignore -->',
      '```ts',
      'y',
      '```',
      '',
      '<!-- docs:sync:end -->',
    ].join('\n'),
  );
  const report = verifyDocs(root);
  assert.equal(report.ok, false);
  assert.equal(report.failures.length, 2);
});

test('stripGeneratedHeader — 생성 헤더 블록과 뒤따르는 빈 줄을 제거한다', () => {
  const text = `${GENERATED_HEADER}export const a = 1;\n`;
  assert.deepEqual(stripGeneratedHeader(text), ['export const a = 1;']);
});

test('stripGeneratedHeader — 헤더가 없으면 원문을 그대로 돌려준다', () => {
  assert.deepEqual(stripGeneratedHeader('line1\nline2\n'), ['line1', 'line2']);
  assert.deepEqual(stripGeneratedHeader(''), []);
});

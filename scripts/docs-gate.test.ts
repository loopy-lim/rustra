import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { collectDocs, stripGeneratedHeader, verifyDocs } from './docs-gate.mjs';

// CLI exit 테스트에서 실제 게이트 스크립트를 spawn하기 위한 절대 경로.
const gatePath = join(resolve(dirname(fileURLToPath(import.meta.url))), 'docs-gate.mjs');

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

test('영역이 하나도 파싱되지 못해도 failures가 있으면 ok=false를 유지한다 (fail-open 차단)', () => {
  // 종결 없는 begin → regions 0개. exit 순서 결함(수정 전)에서는 이 입력이
  // "no docs:sync markers found"로 위장해 드리프트를 숨기고 통과했다.
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
  assert.equal(report.regions.length, 0);
  assert.ok(report.failures.length > 0);
});

test('CRLF 체크아웃 문서도 정상 파싱해 통과한다', () => {
  const body = ['export type A = number;', 'export const x = 1;'];
  const root = makeTmp();
  mkdirSync(join(root, 'docs'));
  // CRLF 문서 + LF 참조 파일 — git autocrlf 체크아웃 형태.
  writeFileSync(
    join(root, 'docs/a.md'),
    `${region('gen/types.ts', body)}\n`.replace(/\n/g, '\r\n'),
  );
  mkdirSync(join(root, 'gen'));
  writeFileSync(join(root, 'gen/types.ts'), `${GENERATED_HEADER}${body.join('\n')}\n`);
  const report = verifyDocs(root);
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  assert.equal(report.regions.length, 1);
});

test('begin 다음 빈 줄이 없으면 구조 위반으로 실패한다', () => {
  const broken = [
    '<!-- docs:sync:begin gen/types.ts -->',
    '<!-- prettier-ignore -->',
    '```ts',
    'x',
    '```',
    '',
    '<!-- docs:sync:end -->',
  ].join('\n');
  const root = fixture('docs/a.md', broken, 'gen/types.ts', `${GENERATED_HEADER}x\n`);
  const report = verifyDocs(root);
  assert.equal(report.ok, false);
  assert.match(report.failures[0].message, /빈 줄/);
});

test('여는 코드 펜스가 없으면 구조 위반으로 실패한다', () => {
  const broken = [
    '<!-- docs:sync:begin gen/types.ts -->',
    '',
    '<!-- prettier-ignore -->',
    '    indented code block, not a fence',
    '```',
    '',
    '<!-- docs:sync:end -->',
  ].join('\n');
  const root = fixture('docs/a.md', broken, 'gen/types.ts', `${GENERATED_HEADER}x\n`);
  const report = verifyDocs(root);
  assert.equal(report.ok, false);
  assert.match(report.failures[0].message, /펜스/);
});

test('참조 경로가 비면 실패한다', () => {
  const root = makeTmp();
  mkdirSync(join(root, 'docs'));
  writeFileSync(
    join(root, 'docs/a.md'),
    '<!-- docs:sync:begin -->\n\n<!-- prettier-ignore -->\n```ts\nx\n```\n\n<!-- docs:sync:end -->\n',
  );
  const report = verifyDocs(root);
  assert.equal(report.ok, false);
  assert.match(report.failures[0].message, /참조 경로가 없다/);
});

test('end 마커 뒤 공백이 붙어도 마커로 인식한다 (CRLF/공백 내성의 일환)', () => {
  // 종결은 되지만 정합 영역이 아닌 입력 — regions에 들어가 구조 검증을 받는다.
  const body = ['x'];
  const root = makeTmp();
  mkdirSync(join(root, 'docs'));
  writeFileSync(
    join(root, 'docs/a.md'),
    `${region('gen/types.ts', body)} \n`, // end 마커 줄 끝 공백 1개
  );
  mkdirSync(join(root, 'gen'));
  writeFileSync(join(root, 'gen/types.ts'), `${GENERATED_HEADER}x\n`);
  const report = verifyDocs(root);
  assert.equal(report.ok, true, JSON.stringify(report.failures));
});

test('begin 마커 뒤 공백이 붙어도 경로 추출이 깨지지 않는다 (end trimEnd와 대칭)', () => {
  const body = ['x'];
  const root = makeTmp();
  mkdirSync(join(root, 'docs'));
  writeFileSync(
    join(root, 'docs/a.md'),
    `${region('gen/types.ts', body).replace('-->', '--> ')}\n`, // begin 줄 끝 공백 1개
  );
  mkdirSync(join(root, 'gen'));
  writeFileSync(join(root, 'gen/types.ts'), `${GENERATED_HEADER}x\n`);
  const report = verifyDocs(root);
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  assert.equal(report.regions[0].path, 'gen/types.ts'); // `gen/types.ts -->` 같은 쓰레기 경로 아님
});

test('CLI: 종결 없는 begin은 실제 프로세스 exit 1과 begin 진단을 낸다 (fail-open 변이 방어)', () => {
  // verifyDocs 불변식만으론 run()의 exit 해석(수정 전 regions-first 순서)을 못 잡는다.
  // 실제 프로세스를 띄워 exit 코드 자체를 고정한다 — 결함 순서로 되돌리는 변이를 잡는다.
  const root = makeTmp();
  mkdirSync(join(root, 'docs'));
  writeFileSync(
    join(root, 'docs/a.md'),
    ['<!-- docs:sync:begin gen/types.ts -->', '', '<!-- prettier-ignore -->', '```ts', 'x'].join(
      '\n',
    ),
  );
  const r = spawnSync(process.execPath, [gatePath], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 1, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /docs:sync:begin/);
  assert.doesNotMatch(r.stdout, /no docs:sync markers found/);
});

test('CLI: 마커 0개 문서는 exit 0으로 통과하되 명시적 상태 메시지를 낸다 (점진 채택)', () => {
  // 결정 고정: 마커 0 허용은 점진 채택 정책 — fail 전환하지 않는다. exit 0과
  // 안내 문구를 함께 고정해, fail 전환 변이가 들어오면 이 테스트가 깨진다.
  // "조용한 통과"가 아니라 게이트가 docs를 봤다는 증거를 stdout에 남긴다.
  const root = makeTmp();
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs/plain.md'), '# 그냥 문서\n');
  const r = spawnSync(process.execPath, [gatePath], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /no docs:sync markers found/);
  assert.match(r.stdout, /마커 0이 의도인지 확인하세요/);
});

test('stripGeneratedHeader — 본문 첫 줄이 우연히 // ──로 시작해도 규약대로 strip한다 (트레이드오프 수용)', () => {
  // 결정 고정: 과잉 strip 가능성은 수용된 트레이드오프다. strip 동작을 바꿔
  // "우연한 헤더"를 구하려는 변이는 이 테스트가 잡는다. 회피 관례는 코드가
  // 아니라 docs:sync 대상 파일 선택으로 한다 — 첫 줄이 `// ──`인 파일은
  // 대상으로 쓰지 않는다.
  const accidental = ['// ── looks like a header but is the body', 'export const x = 1;'];
  assert.deepEqual(stripGeneratedHeader(`${accidental.join('\n')}\n`), ['export const x = 1;']);
});

// ── 무테스트 failure 분기 2건 (nested-begin / fence→end 간격) ────────────────

test('열린 region 안에서 begin이 재등장하면(nested-begin) 실패한다', () => {
  // verifyDocs 의 open-region 분기 — "새 begin이 이전 begin 종료 전에 나왔다".
  // 첫 region 은 정합 규약을 갖추되 end 전에 두 번째 begin 이 끼어든 형태다.
  const broken = [
    '<!-- docs:sync:begin gen/types.ts -->',
    '',
    '<!-- prettier-ignore -->',
    '```ts',
    'x',
    '<!-- docs:sync:begin gen/other.ts -->',
    '```',
    '',
    '<!-- docs:sync:end -->',
  ].join('\n');
  const root = fixture('docs/a.md', broken, 'gen/types.ts', `${GENERATED_HEADER}x\n`);
  const report = verifyDocs(root);
  assert.equal(report.ok, false);
  const f = report.failures.find((failure) => /종료 전에 나왔다/.test(failure.message));
  assert.ok(f, `nested-begin 진단이 없다: ${JSON.stringify(report.failures)}`);
  assert.match(f.message, /docs\/a\.md/);
  // 진단은 문서 위치와 방해된 이전 begin(경로+줄)을 이름으로 꼽는다.
  assert.match(f.message, /gen\/types\.ts/);
  assert.match(f.message, /1줄/);
});

test('닫는 펜스와 end 마커 사이가 빈 줄 하나가 아니면 실패한다 (fence→end 간격 위반)', () => {
  // verifyRegion 의 펜스~end 간격 분기 — 규약은 "닫는 펜스 다음 빈 줄 하나,
  // 그 다음 end 마커". 본문이 정확히 일치해도 구조 위반이면 fail 해야 한다.
  const body = ['x'];
  const broken = [
    '<!-- docs:sync:begin gen/types.ts -->',
    '',
    '<!-- prettier-ignore -->',
    '```ts',
    ...body,
    '```',
    '<!-- docs:sync:end -->', // 빈 줄 없이 바로 붙음
  ].join('\n');
  const root = fixture('docs/a.md', broken, 'gen/types.ts', `${GENERATED_HEADER}x\n`);
  const report = verifyDocs(root);
  assert.equal(report.ok, false);
  const f = report.failures.find((failure) => /빈 줄 하나여야 한다/.test(failure.message));
  assert.ok(f, `간격 위반 진단이 없다: ${JSON.stringify(report.failures)}`);
  assert.match(f.message, /docs\/a\.md/);
});

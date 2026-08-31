// B3 타임라인 리포트 테스트.
// 저장소 표준(node:test + node:assert/strict, ESM) 사용 — 새 의존성 없음.
//
// 렌더 결과는 **전문 고정**(golden)이다 — B2 inspect 의 EXPECTED_TEXT 계약과
// 같이 출력 형태 드리프트를 조용히 통과시키지 않기 위함이다. 이스케이프는
// 적대적 입력으로, 외부 자원 0개는 정규식으로 각각 게이트한다.

import assert from 'node:assert/strict';
import test from 'node:test';
import type { DevtoolsLog } from './index.js';
import { renderTimelineReport } from './index.js';

// 골든 픽스처 — invoke 성공/실패, invokeById, batch 한씩. durationMs 에 소수를
// 섞어 합계(7.25) 렌더도 함께 고정한다.
const FIXTURE: DevtoolsLog[] = [
  {
    kind: 'invoke',
    command: 'addNumbers',
    durationMs: 1.5,
    ok: true,
    payload: { a: 1, b: 2 },
    result: { sum: 3 },
  },
  {
    kind: 'invoke',
    command: 'fail',
    durationMs: 0.25,
    ok: false,
    payload: null,
    error: { code: 'E_FAIL', message: 'boom' },
  },
  {
    kind: 'invokeById',
    command: 'get.counter',
    durationMs: 2,
    ok: true,
    result: 42,
  },
  {
    kind: 'batch',
    command: 'batch(2)',
    durationMs: 3.5,
    ok: true,
    payload: [{ command: 'a' }, { command: 'b' }],
    result: [1, 2],
  },
];

const EXPECTED_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>rustra timeline report</title>
<style>
:root { color-scheme: light; }
body { font-family: system-ui, sans-serif; margin: 16px; color: #1a1a1a; }
h1 { font-size: 1.1rem; }
ul { list-style: none; padding: 0; display: flex; gap: 16px; }
li span { display: block; font-size: 0.75rem; color: #555; }
table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; vertical-align: top; }
th { background: #f2f2f2; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
td.ok { color: #0a6b2d; }
td.error { color: #b3261e; }
td.kind { font-family: monospace; }
</style>
</head>
<body>
<h1>rustra timeline report</h1>
<ul class="summary">
<li><span>entries</span><b>4</b></li>
<li><span>errors</span><b>1</b></li>
<li><span>total duration (ms)</span><b>7.25</b></li>
</ul>
<table>
<thead>
<tr><th>kind</th><th>command</th><th>ms</th><th>status</th><th>payload</th><th>result</th></tr>
</thead>
<tbody>
      <tr>
        <td class="kind">invoke</td>
        <td>addNumbers</td>
        <td class="num">1.5</td>
        <td class="ok">ok</td>
        <td>{&quot;a&quot;:1,&quot;b&quot;:2}</td>
        <td>{&quot;sum&quot;:3}</td>
      </tr>
      <tr>
        <td class="kind">invoke</td>
        <td>fail</td>
        <td class="num">0.25</td>
        <td class="error">error — E_FAIL: boom</td>
        <td>null</td>
        <td>—</td>
      </tr>
      <tr>
        <td class="kind">invokeById</td>
        <td>get.counter</td>
        <td class="num">2</td>
        <td class="ok">ok</td>
        <td>—</td>
        <td>42</td>
      </tr>
      <tr>
        <td class="kind">batch</td>
        <td>batch(2)</td>
        <td class="num">3.5</td>
        <td class="ok">ok</td>
        <td>[{&quot;command&quot;:&quot;a&quot;},{&quot;command&quot;:&quot;b&quot;}]</td>
        <td>[1,2]</td>
      </tr>
</tbody>
</table>
</body>
</html>
`;

test('golden: fixture renders the pinned full document', () => {
  assert.equal(renderTimelineReport(FIXTURE), EXPECTED_HTML);
});

test('aggregate header derives totals from the logs array itself', () => {
  const html = renderTimelineReport(FIXTURE);
  assert.ok(html.includes('<li><span>entries</span><b>4</b></li>'));
  assert.ok(html.includes('<li><span>errors</span><b>1</b></li>'));
  assert.ok(html.includes('<li><span>total duration (ms)</span><b>7.25</b></li>'));
});

test('escapes hostile command, payload, and error strings', () => {
  const html = renderTimelineReport([
    {
      kind: 'invoke',
      command: 'ev"il<cmd>',
      durationMs: 1,
      ok: false,
      payload: '<script>alert(1)</script>',
      error: { code: 'E<X>', message: '<b>bold</b> & "quoted"' },
    },
  ]);
  // 원문 <script> 는 어디에도 나타나지 않는다(정적 템플릿 자체에도 script 는 없다).
  assert.ok(!html.includes('<script'));
  // payload 문자열은 JSON 직렬화 뒤 이스케이프된다.
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  // 명령명의 따옴표·부등호도 텍스트/속성 컨텍스트에서 안전하다.
  assert.ok(html.includes('ev&quot;il&lt;cmd&gt;'));
  // 에러 code·message 도 이스케이프된다.
  assert.ok(html.includes('E&lt;X&gt;: &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot;'));
});

test('output is self-contained — zero external resources', () => {
  const html = renderTimelineReport(FIXTURE);
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<style>'));
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(html, /\b(?:src|href)\s*=/i);
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<link'));
  assert.ok(!html.includes('url('));
});

test('empty log array renders a valid document with an empty marker', () => {
  const html = renderTimelineReport([]);
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.trimEnd().endsWith('</html>'));
  assert.ok(html.includes('(no entries)'));
  assert.ok(html.includes('<b>0</b>'));
});

test('rendering is deterministic — same input, byte-identical output', () => {
  assert.equal(renderTimelineReport(FIXTURE), renderTimelineReport(FIXTURE));
});

test('batch logs render as one flat row — the instrumented command name carries the count', () => {
  // 계측기(instrumented-engine)가 batch 를 `batch(N)` 명령명의 단일 엔트리로
  // 기록하므로 리포트도 계층 없이 평면 행 하나로 렌더한다.
  const html = renderTimelineReport([
    { kind: 'batch', command: 'batch(3)', durationMs: 4, ok: true },
  ]);
  assert.equal((html.match(/<tr>/g) ?? []).length, 2); // thead 1 + batch 1
  assert.ok(html.includes('<td>batch(3)</td>'));
});

test('1000 entries render deterministically with one row per entry', () => {
  const logs: DevtoolsLog[] = Array.from({ length: 1000 }, (_, index) => ({
    kind: 'invoke' as const,
    command: `tick.${index}`,
    durationMs: 1,
    ok: true,
  }));
  const first = renderTimelineReport(logs);
  const second = renderTimelineReport(logs);
  assert.equal(first, second);
  // thead 의 1행 + 엔트리 1000행.
  assert.equal((first.match(/<tr>/g) ?? []).length, 1001);
  assert.ok(first.includes('<b>1000</b>'));
});

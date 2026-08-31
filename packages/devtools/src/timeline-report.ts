/**
 * B3 타임라인 리포트 — `DevtoolsLog[]` 를 self-contained 정적 HTML 로 렌더한다.
 *
 * 입력은 계측 엔진(`createInstrumentedEngine`)의 `report().logs` 를 그대로
 * 쓴다. 순수 함수 계약: fs·DOM·시계(Date.now)·난수에 의존하지 않으므로 같은
 * 입력은 항상 바이트 단위로 같은 문서를 만든다. 쓰기 위치는 호출자가 정한다.
 *
 * 출력 계약:
 * - 완전한 문서(`<!DOCTYPE html>` 시작, `</html>` 종료) + 인라인 `<style>` 하나.
 * - 외부 자원 0개 — `src=`, `href=`, `http(s)://`, `url(`, `<script>`, `<link>`
 *   를 의도적으로 배제한다(오프라인 아카이브 가능, XSS 면적 최소화).
 * - 모든 동적 문자열(명령명·에러·payload/result 직렬화)은 [`escapeHtml`] 을
 *   거친다. payload 가 `<script>alert(1)</script>` 여도 텍스트로만 렌더된다.
 *
 * batch 는 계측기가 `batch(N)` 명령명의 단일 엔트리로 기록하므로 리포트도
 * 계층 없이 평면 행 하나로 렌더한다(구조 분리는 로그에 없는 정보를 만들지
 * 않는다는 원칙).
 */

import type { DevtoolsLog } from './devtools-types.js';

/** HTML 특수문자를 엔티티로 바꿔 텍스트·속성(따옴표 포함) 컨텍스트를 모두 안전하게 만든다. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * payload/result 프리뷰 — JSON 직렬화 뒤 잘라낸다(길이 초과분은 … 표기).
 * 순환 참조처럼 직렬화가 실패하면 String(value) 로 낮춘다. 절단 경계가
 * 서러게이트 쌍 사이에 걸리면 한 글자 물러선다 — unpaired high surrogate
 * 가 문서에 섞이면 렌더러마다 깨진 글자/치환문자로 보이는 원인이 된다.
 */
function preview(value: unknown): string {
  if (value === undefined) return '—';
  let text: string;
  try {
    text = JSON.stringify(value) ?? 'undefined';
  } catch {
    text = String(value);
  }
  if (text.length <= 200) return text;
  const boundary = text.charCodeAt(199);
  const cut = boundary >= 0xd800 && boundary <= 0xdbff ? 199 : 200;
  return `${text.slice(0, cut)}…`;
}

/** 로그 한 건을 타임라인 테이블 행 하나로 렌더한다. */
function renderRow(log: DevtoolsLog): string {
  const status = log.ok ? 'ok' : 'error';
  const summary = log.error
    ? ` — ${log.error.code ? `${log.error.code}: ` : ''}${log.error.message}`
    : '';
  return [
    '      <tr>',
    `        <td class="kind">${escapeHtml(log.kind)}</td>`,
    `        <td>${escapeHtml(log.command)}</td>`,
    // durationMs 는 숫자 — 메타문자를 운반할 수 없으므로 이스케이프 불필요.
    `        <td class="num">${log.durationMs}</td>`,
    `        <td class="${status}">${status}${escapeHtml(summary)}</td>`,
    `        <td>${escapeHtml(preview(log.payload))}</td>`,
    `        <td>${escapeHtml(preview(log.result))}</td>`,
    '      </tr>',
  ].join('\n');
}

/**
 * 로그 배열 → self-contained HTML 문서. 결정적이며 외부 의존이 없다.
 * 집계 헤더(entries/errors/total duration)는 입력 배열 자체에서 유도한다 —
 * `DevtoolsReport` 에 의존하지 않는다.
 */
export function renderTimelineReport(logs: DevtoolsLog[]): string {
  const errors = logs.filter((log) => !log.ok).length;
  const totalMs = logs.reduce((sum, log) => sum + log.durationMs, 0);
  const rows = logs.map(renderRow).join('\n');
  return `<!DOCTYPE html>
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
td { overflow-wrap: anywhere; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
td.ok { color: #0a6b2d; }
td.error { color: #b3261e; }
td.kind { font-family: monospace; }
</style>
</head>
<body>
<h1>rustra timeline report</h1>
<ul class="summary">
<li><span>entries</span><b>${logs.length}</b></li>
<li><span>errors</span><b>${errors}</b></li>
<li><span>total duration (ms)</span><b>${totalMs}</b></li>
</ul>
<table>
<thead>
<tr><th>kind</th><th>command</th><th>ms</th><th>status</th><th>payload</th><th>result</th></tr>
</thead>
<tbody>
${rows || '      <tr><td colspan="6">(no entries)</td></tr>'}
</tbody>
</table>
</body>
</html>
`;
}

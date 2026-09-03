#!/usr/bin/env node
/**
 * docs 동기화 게이트 — 문서의 `docs:sync` 마커 영역이 참조 파일(생성물)과
 * byte-for-byte로 일치하는지 검증한다. 문서에 붙여 넣은 생성 코드 샘플이
 * 현실과 갈라지는 반복 패턴을 게이트로 종결한다. 산문이 아니라 게이트로 계약한다.
 *
 * 마커 규약(계약):
 *   <!-- docs:sync:begin <repo-relative path> -->
 *   (빈 줄)
 *   <!-- prettier-ignore -->
 *   ```<lang>
 *   (참조 파일 본문 — 생성물의 자기서술 헤더 주석 블록은 제외)
 *   ```
 *   (빈 줄)
 *   <!-- docs:sync:end -->
 *
 * - 참조 파일 첫 주석 블록(`// ── rustra generated ──`로 시작해 `//`만 쓰는 줄에서
 *   끝나는 블록)은 strip한 뒤 비교한다. 헤더가 없으면 전체를 비교한다.
 * - 마커 없는 문서는 통과한다(점진 채택).
 * - docs/plans/는 제외한다(로드맵 문서가 마커 문법 자체를 인용한다).
 *
 * fail-closed: 구조 위반·드리프트·누락은 전부 모아 한 번에 보고하고 1로 끝난다.
 * `root`(저장소 루트)를 주입받아 로직은 저장소 docs 없이 테스트 가능(docs-gate.test.ts).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BEGIN = '<!-- docs:sync:begin ';
const END_MARKER = '<!-- docs:sync:end -->';
const PRETTIER_IGNORE = '<!-- prettier-ignore -->';

/** docs 밑의 모든 .md를 재귀 수집 — docs/plans/ 제외(마커 문법 자체를 인용하므로). */
export function collectDocs(root) {
  const items = [];
  const walk = (rel) => {
    const dir = join(root, rel);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (childRel === 'plans') continue; // docs/plans/ 제외
        walk(childRel);
      } else if (entry.name.endsWith('.md')) {
        items.push(childRel);
      }
    }
  };
  walk('');
  return items.sort();
}

/**
 * 생성물의 자기서술 헤더 주석 블록을 제거한 본문 줄들을 돌려준다.
 *
 * 스코프(휴리스틱의 정확한 동작): 고정 "8행" 규칙이 아니라 — 선행 빈 줄을
 * 건너뛴 뒤 첫 줄이 `// ──`로 시작하면, `//` 프리픽스 줄만 쓰는 첫 줄(포함
 *하지 않음)까지와 그 직후 빈 줄 하나를 소비한다. 즉 헤더 행 수가 달라도
 * (`// ──` 줄과 본문 사이가 `//`만 쓰는 블록이면) strip 된다. 헤더로 판정되지
 * 않으면 원문 전체(선행 빈 줄 포함)가 비교 대상.
 *
 * 과잉 strip 가능성(본문 첫 줄이 우연히 `// ──`로 시작하는 TS 파일 등)은
 * 알려진 트레이드오프 — 후속 판단 사항으로 기록하며 코드는 바꾸지 않는다.
 */
export function stripGeneratedHeader(text) {
  const lines = text.split('\n');
  // 파일 끝 개행이 만든 마지막 빈 조각 하나만 제거한다 — 그 이상의 빈 줄은 본문의 일부로
  // 취급해 doc 쪽과 대조된다(byte-for-byte 계약).
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && lines[i].trimStart().startsWith('// ──')) {
    i++;
    while (i < lines.length && lines[i].trimStart().startsWith('//')) i++;
    // 헤더 직후의 빈 줄 하나는 소비한다 — docs 쪽 fenced body에는 없는 줄이다.
    if (i < lines.length && lines[i].trim() === '') i++;
    return lines.slice(i);
  }
  return lines; // 헤더가 아니면 원문 전체(선행 빈 줄 포함)가 비교 대상
}

/** 마커 쌍 검증 결과. ok=false면 failures에 사람이 읽는 메시지가 쌓인다. */
export function verifyDocs(root, { docsDir = 'docs' } = {}) {
  const failures = [];
  const regions = [];
  const docs = collectDocs(join(root, docsDir)).map((rel) => join(docsDir, rel));

  for (const rel of docs) {
    const docPath = join(root, rel);
    // CRLF 체크아웃에서도 마커/펜스 매칭이 깨지지 않아야 한다(\r가 end 마커 매칭과
    // begin 경로 추출을 망가뜨린다). 참조 파일은 정규화하지 않는다 — byte 정합 계약.
    const lines = readFileSync(docPath, 'utf8').split(/\r?\n/);
    let open = null; // { path, line }

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const lineNo = idx + 1;

      if (line.startsWith(BEGIN)) {
        if (open) {
          failures.push({
            message: `${rel}:${lineNo} — 새 docs:sync:begin이 이전 begin(${open.line}줄, ${open.path}) 종료 전에 나왔다`,
          });
        }
        // `-->` 뒤 눈에 보이지 않는 공백도 허용한다 — 미허용 시 `f.ts -->` 같은
        // 존재하지 않는 경로 진단이 나온다(end 마커 trimEnd와 대칭).
        const path = line.slice(BEGIN.length).replace(/\s*-->\s*$/, '').trim();
        if (path === '') {
          failures.push({ message: `${rel}:${lineNo} — docs:sync:begin에 참조 경로가 없다` });
          open = null;
        } else {
          open = { path, line: lineNo };
        }
        continue;
      }

      // end 마커 뒤 눈에 보이지 않는 공백도 마커로 인식한다 — 미인식 시 "end 없는 begin"
      // 오진이 나오고(쓰레기 진단), 본문 byte 정합 계약과는 무관한 구조 스캐폴딩이므로.
      if (line.trimEnd() === END_MARKER) {
        if (!open) {
          failures.push({
            message: `${rel}:${lineNo} — 대응하는 docs:sync:begin 없는 docs:sync:end`,
          });
          continue;
        }
        verifyRegion(root, rel, lines, open, lineNo, failures, regions);
        open = null;
      }
    }
    if (open) {
      failures.push({
        message: `${rel}:${open.line} — 닫는 docs:sync:end 없는 docs:sync:begin(${open.path})`,
      });
    }
  }

  return { ok: failures.length === 0, failures, regions };
}

/** begin..end 사이 구조를 검증하고 참조 파일과 byte-for-byte 비교한다. */
function verifyRegion(root, rel, lines, open, endLine, failures, regions) {
  const beginLine = open.line;
  regions.push({ doc: rel, path: open.path, line: beginLine });

  // 규약: begin 다음 빈 줄, prettier-ignore, 여는 펜스.
  const empty1 = beginLine; // 1-based → lines[beginLine]은 begin 바로 다음 줄
  const ignoreLine = beginLine + 1;
  const fenceLine = beginLine + 2;
  if (lines[empty1]?.trim() !== '') {
    failures.push({
      message: `${rel}:${empty1 + 1} — begin 마커 다음 빈 줄이어야 한다 (규약 위반)`,
    });
    return;
  }
  if (lines[ignoreLine] !== PRETTIER_IGNORE) {
    failures.push({
      message: `${rel}:${ignoreLine + 1} — ${PRETTIER_IGNORE} 줄이어야 한다 (규약 위반)`,
    });
    return;
  }
  if (!/^```/.test(lines[fenceLine] ?? '')) {
    failures.push({
      message: `${rel}:${fenceLine + 1} — 코드 펜스(` + '```' + `)로 열어야 한다 (규약 위반)`,
    });
    return;
  }

  // 닫는 펜스를 찾는다: 행 시작의 ``` (뒤 공백 허용).
  let closeIdx = -1;
  for (let i = fenceLine + 1; i < endLine - 1; i++) {
    if (/^```\s*$/.test(lines[i])) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    failures.push({
      message: `${rel}:${beginLine} — ${open.path}: end 마커 전에 닫는 코드 펜스가 없다 (규약 위반)`,
    });
    return;
  }
  // 펜스와 end 마커 사이 빈 줄 하나.
  if (lines[closeIdx + 1]?.trim() !== '' || closeIdx + 2 !== endLine - 1) {
    failures.push({
      message: `${rel}:${closeIdx + 2} — 닫는 펜스와 end 마커 사이는 빈 줄 하나여야 한다 (규약 위반)`,
    });
    return;
  }

  // 참조 파일 비교 — byte-for-byte(줄 끝 공백 포함), 줄 수열 정확 일치.
  const refPath = resolve(root, open.path);
  let refLines;
  try {
    refLines = stripGeneratedHeader(readFileSync(refPath, 'utf8'));
  } catch {
    failures.push({
      message: `${rel}:${beginLine} — 참조 파일을 찾을 수 없다: ${open.path} (생성 후 커밋했는지 확인)`,
    });
    return;
  }

  const docBody = lines.slice(fenceLine + 1, closeIdx);
  for (let i = 0; i < Math.max(docBody.length, refLines.length); i++) {
    const d = docBody[i];
    const r = refLines[i];
    if (d !== r) {
      const show = (s) => (s === undefined ? '<끝>' : JSON.stringify(s));
      failures.push({
        message:
          `${rel}:${beginLine} — ${open.path}: line ${i + 1} differs — doc: ${show(d)} vs file: ${show(r)}`,
      });
      return;
    }
  }
  // 여기 도달하면 일치. (docBody.length === refLines.length는 루프가 보장)
}

function run() {
  const root = process.cwd(); // bun run/node scripts는 저장소 루트에서 실행한다(api-surface와 같은 관례).
  const report = verifyDocs(root);
  // fail-closed: 불일치 판정을 마커 존재 판정보다 먼저 본다. 영역 파싱이 전부 깨진
  // 입력(CRLF, end 마커 뒤 공백, 종결 없는 begin)에서는 regions가 0이므로, 이 검사를
  // 먼저 하면 드리프트가 "no docs:sync markers found"로 위장해 거짓 통과한다.
  if (!report.ok) {
    console.error(`docs-gate: ${report.failures.length}개 불일치 — 문서와 현실이 갈라졌다:`);
    for (const f of report.failures) console.error(`  - ${f.message}`);
    process.exitCode = 1;
    return;
  }
  if (report.regions.length === 0) {
    // 마커 채택 초기라 fail 전환이 아니라 명시적 상태 유지다. 다만 이 출력이
    // "게이트가 실제로 docs를 봤는지"의 유일 증거이므로, 마커 0이 의도인지
    // 확인하라는 안내를 붙인다(fail 전환은 후속 판단 사항).
    console.log(
      'docs-gate: no docs:sync markers found (게이트 우회 없음 확인용 — 마커 0이 의도인지 확인하세요)',
    );
    return;
  }
  const files = new Set(report.regions.map((r) => r.doc)).size;
  console.log(`docs-gate: ${report.regions.length} synced region(s) in ${files} file(s) verified`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) run();

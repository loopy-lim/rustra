// API 표면 스냅샷 게이트 — Rust/TS 공개 export 를 api-surface/snapshot.json 에 고정하고
// 드리프트(추가/삭제/변경)를 감지한다. `node scripts/api-surface.mjs` (비교 — 스냅샷
// 부재는 실패) 또는 `--update`(갱신/생성).
//
// FFI 시그니처는 blind spot 이 아니다 — ffiSignatures 섹션이 각 `rustra_ffi_*` 함수의
// `fn 이름`부터 `{`/`;` 직전까지의 시그니처(매개변수·반환형 포함, 여러 줄은 공백 하나로
// 정규화)를 이름별로 고정하므로, 이름을 유지한 채 시그니처만 바꾸면 드리프트로 실패한다.
//
// 감지 범위 / known blind spots (이 형태로 export 를 추가하면 게이트가 조용히 통과한다):
// - 여러 줄 `pub use x::{ A, B, };` 그룹 (현재 lib.rs의 공개 use는 전부 한 줄)
// - `export default` (현재 9개 패키지에 없음)
// - `#[proc_macro_derive(...)]`와 attribute↔`pub fn` 사이 doc comment
// - package.json `exports` 서브패스 (src/index.ts 기준 수집이므로)
// 새 형태를 도입하려면 위에 해당하는 수집기를 먼저 확장한다.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 스냅샷 형식 버전 — compare 시 불일치하면 --update 재실행을 요구한다. */
const SNAPSHOT_VERSION = 2;

const SNAPSHOT_DIR = 'api-surface';
const SNAPSHOT_FILE = 'snapshot.json';

const uniqueSorted = (items) => [...new Set(items)].sort();

/** crates/rustra/src/lib.rs 의 `pub mod ...` / `pub use ...` 항목. */
export function collectRustModules(libRsText) {
  const items = [];
  for (const line of libRsText.split('\n')) {
    const trimmed = line.trim();
    const mod = /^pub mod ([A-Za-z_][A-Za-z0-9_]*)\s*;?$/.exec(trimmed);
    if (mod) {
      items.push(`pub mod ${mod[1]}`);
      continue;
    }
    const use =
      /^pub use ([A-Za-z_][A-Za-z0-9_:]*\{.*\}|[A-Za-z_][A-Za-z0-9_:]*(::[A-Za-z_][A-Za-z0-9_]*)*)\s*;?$/.exec(
        trimmed,
      );
    if (use) items.push(`pub use ${use[1]}`);
  }
  return uniqueSorted(items);
}

/**
 * ffi*.rs 의 C-ABI 함수 export (`pub unsafe extern "C" fn` 과 `pub extern "C" fn` 모두).
 * 이름 배열과 이름→정규화 시그니처 맵을 함께 돌려준다. 시그니처는 `fn 이름`부터
 * `{`/`;` 직전까지(여러 줄 포함)를 잡아 공백 runs를 하나로 폈고 앞뒤를 trim 한다.
 */
export function collectFfiExports(sourceTexts) {
  const signatures = {};
  for (const text of sourceTexts) {
    for (const match of text.matchAll(
      /(^|\n)\s*pub (?:unsafe )?extern "C" fn (rustra_[a-z_0-9]+)([^{;]*)/g,
    )) {
      const name = match[2];
      // 같은 이름이 여러 번 정의되는 비정상 상황에서도 파일 순서에 의존하지 않도록 사전순 최솟값을 고른다.
      const normalized = match[3].replace(/\s+/g, ' ').trim();
      if (signatures[name] === undefined || signatures[name] > normalized) {
        signatures[name] = normalized;
      }
    }
  }
  const names = uniqueSorted(Object.keys(signatures));
  return { names, signatures: Object.fromEntries(names.map((name) => [name, signatures[name]])) };
}

/** rustra-macros 의 proc-macro export 이름. */
export function collectMacros(sourceTexts) {
  const names = [];
  for (const text of sourceTexts) {
    // `#[proc_macro]` / `#[proc_macro_attribute]` 바로 다음의 pub fn.
    for (const match of text.matchAll(
      /#\[\s*proc_macro(?:_[a-z_]+)?\s*\]\s*pub fn ([a-z_0-9]+)/g,
    )) {
      names.push(match[1]);
    }
  }
  return uniqueSorted(names);
}

/** 문자열 리터럴을 건너뛰고 닫는 따옴표의 인덱스를 반환한다 (템플릿 `${}` 중첩 포함). */
function skipString(text, start) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i;
    if (quote === '`' && ch === '$' && text[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        const inner = text[i];
        if (inner === '{') depth++;
        else if (inner === '}') depth--;
        else if (inner === "'" || inner === '"' || inner === '`') i = skipString(text, i);
        i++;
      }
      continue;
    }
    i++;
  }
  return text.length - 1;
}

/**
 * export 문 단위로 분리한다. 주석/문자열을 건너뛰고, 세미콜론 또는
 * depth-0 `}` (뒤에 이어짐 토큰이 없을 때) 를 문장 종료로 본다.
 */
function extractExportStatements(indexTsText) {
  const statements = [];
  let statement = '';
  let depth = 0;
  let i = 0;
  const n = indexTsText.length;
  const flush = () => {
    const normalized = statement.replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('export ')) statements.push(normalized.replace(/;$/, ''));
    statement = '';
    depth = 0;
  };
  while (i < n) {
    const ch = indexTsText[i];
    const two = indexTsText.slice(i, i + 2);
    if (two === '//') {
      while (i < n && indexTsText[i] !== '\n') i++;
      continue;
    }
    if (two === '/*') {
      const end = indexTsText.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = skipString(indexTsText, i);
      statement += indexTsText.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === ';') {
      if (depth === 0) flush();
      else statement += ch;
      i++;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      statement += ch;
      i++;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      statement += ch;
      i++;
      if (depth === 0) {
        // `}` 뒤에 from/=//`;` 등 이어짐이 오면 문장이 계속되는 것 (`export { a } from '...'`;).
        const rest = indexTsText.slice(i).replace(/^[\s]+/, '');
        if (!/^(from\b|as\b|satisfies\b|;|[=,):+\-*/%<>&|?.[\]])/.test(rest)) flush();
      }
      continue;
    }
    statement += ch;
    i++;
  }
  flush();
  return statements;
}

/** 각 패키지 src/index.ts 의 export 문을 정규화한다. */
export function collectTsExports(indexTsText) {
  const names = [];
  for (const statement of extractExportStatements(indexTsText)) {
    // export * from '...'  |  export * as ns from '...'
    const star = /^export \*(?: as ([A-Za-z_$][\w$]*) )?\s*from (['"])(.+?)\2$/.exec(statement);
    if (star) {
      names.push(star[1] ? `* as ${star[1]} from '${star[3]}'` : `* from '${star[3]}'`);
      continue;
    }
    // export type { a, b } from '...'  |  export { a, b } [from '...']
    const braces = /^export (type )?\{([^}]*)\}(?: from (['"])(.+?)\3)?$/.exec(statement);
    if (braces) {
      for (const piece of braces[2].split(',')) {
        const spec = piece.trim();
        if (!spec) continue;
        // `type X` 인라인 한정자, `a as b` 리네임 모두 최종 이름으로 정규화.
        const renamed = /^(?:type )?([A-Za-z_$][\w$]*)(?: as (?:type )?([A-Za-z_$][\w$]*))?$/.exec(
          spec,
        );
        if (renamed) names.push(renamed[2] ?? renamed[1]);
      }
      continue;
    }
    // export type X = ...  |  export interface X  |  export function X  |  export const X  |  export class X
    const decl =
      /^export (?:declare )?(?:abstract )?(?:type|interface|class|enum|function\*?|const|let|var) ([A-Za-z_$][\w$]*)/.exec(
        statement,
      );
    if (decl) names.push(decl[1]);
  }
  return uniqueSorted(names);
}

function collectSurfaceFromFiles({ rustLibRs, rustSourceTexts, macroSourceTexts, packageIndexes }) {
  const ffi = collectFfiExports(rustSourceTexts);
  return {
    rustModules: collectRustModules(rustLibRs),
    ffiExports: ffi.names,
    ffiSignatures: ffi.signatures,
    macros: collectMacros(macroSourceTexts),
    tsExports: Object.fromEntries(
      Object.entries(packageIndexes).map(([pkg, text]) => [pkg, collectTsExports(text)]),
    ),
  };
}

/** 저장소 전체의 공개 표면을 수집한다 (배열은 정렬·중복 제거, ffiSignatures 맵은 이름 정렬). */
export function collectSurface(root = process.cwd()) {
  const rustraSrc = join(root, 'crates', 'rustra', 'src');
  const rustSourceTexts = readdirSync(rustraSrc)
    .filter((name) => /^ffi.*\.rs$/.test(name))
    .map((name) => readFileSync(join(rustraSrc, name), 'utf8'));
  const macroSourceTexts = readdirSync(join(root, 'crates', 'rustra-macros', 'src'))
    .filter((name) => name.endsWith('.rs'))
    .map((name) => readFileSync(join(root, 'crates', 'rustra-macros', 'src', name), 'utf8'));
  const packageIndexes = {};
  for (const name of readdirSync(join(root, 'packages')).sort()) {
    const indexTs = join(root, 'packages', name, 'src', 'index.ts');
    if (existsSync(indexTs)) packageIndexes[`packages/${name}`] = readFileSync(indexTs, 'utf8');
  }
  return collectSurfaceFromFiles({
    rustLibRs: readFileSync(join(rustraSrc, 'lib.rs'), 'utf8'),
    rustSourceTexts,
    macroSourceTexts,
    packageIndexes,
  });
}

/** 스냅샷 JSON 문자열 — 2-space indent + trailing newline, 키 순서 고정. */
export function serializeSurface(surface) {
  const ordered = {
    version: SNAPSHOT_VERSION,
    rustModules: surface.rustModules,
    ffiExports: surface.ffiExports,
    ffiSignatures: surface.ffiSignatures,
    macros: surface.macros,
    tsExports: surface.tsExports,
  };
  for (const key of Object.keys(ordered.tsExports)) {
    if (!Array.isArray(ordered.tsExports[key])) delete ordered.tsExports[key];
  }
  ordered.tsExports = Object.fromEntries(Object.entries(ordered.tsExports).sort());
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** 스냅샷 대비 추가/삭제/변경 항목을 섹션별로 묶어 반환한다. */
export function compareSurface(current, snapshot) {
  const added = {};
  const removed = {};
  const changed = {};
  const TS_PREFIX = 'tsExports[';
  // 섹션 키는 스냅샷 ∪ 현재 — 패키지 통째로 추가/삭제된 경우도 양쪽에서 잡힌다.
  const currentPackageKeys = Object.keys(current.tsExports ?? {});
  const sectionKeys = [
    ['rustModules', false],
    ['ffiExports', false],
    ['macros', false],
    ...[...new Set([...Object.keys(snapshot.tsExports ?? {}), ...currentPackageKeys])].map(
      (pkg) => [`tsExports[${pkg}]`, true],
    ),
  ];
  for (const [section, isTs] of sectionKeys) {
    const currentItems = isTs
      ? (current.tsExports?.[section.slice(TS_PREFIX.length, -1)] ?? [])
      : (current[section] ?? []);
    const snapshotItems = isTs
      ? (snapshot.tsExports?.[section.slice(TS_PREFIX.length, -1)] ?? [])
      : (snapshot[section] ?? []);
    const snapshotSet = new Set(snapshotItems);
    const currentSet = new Set(currentItems);
    const addedItems = currentItems.filter((item) => !snapshotSet.has(item));
    const removedItems = snapshotItems.filter((item) => !currentSet.has(item));
    if (addedItems.length > 0) added[section] = addedItems;
    if (removedItems.length > 0) removed[section] = removedItems;
  }
  // 맵 섹션(ffiSignatures): 이름→시그니처. 시그니처 변경은 `name: old → new` 로,
  // 이름 추가/삭제는 이름 그대로 잡는다. 이름 추가/삭제는 ffiExports 에서도 발화한다
  // (양쪽 섹션이 함께 보고되는 중복은 의도된 동작).
  const currentSigs = current.ffiSignatures ?? {};
  const snapshotSigs = snapshot.ffiSignatures ?? {};
  for (const name of uniqueSorted([...Object.keys(snapshotSigs), ...Object.keys(currentSigs)])) {
    const oldSig = snapshotSigs[name];
    const newSig = currentSigs[name];
    if (oldSig === newSig) continue;
    if (oldSig === undefined) (added.ffiSignatures ??= []).push(name);
    else if (newSig === undefined) (removed.ffiSignatures ??= []).push(name);
    else (changed.ffiSignatures ??= []).push(`${name}: ${oldSig} → ${newSig}`);
  }
  return { added, removed, changed };
}

function driftCount({ added, removed, changed }) {
  return (
    Object.values(added).reduce((sum, items) => sum + items.length, 0) +
    Object.values(removed).reduce((sum, items) => sum + items.length, 0) +
    Object.values(changed).reduce((sum, items) => sum + items.length, 0)
  );
}

function run() {
  const root = process.cwd();
  const snapshotPath = join(root, SNAPSHOT_DIR, SNAPSHOT_FILE);
  const update = process.argv.includes('--update');
  if (update) {
    mkdirSync(join(root, SNAPSHOT_DIR), { recursive: true });
    writeFileSync(snapshotPath, serializeSurface(collectSurface(root)));
    console.log(`snapshot updated: ${SNAPSHOT_DIR}/${SNAPSHOT_FILE}`);
    return;
  }
  // 스냅샷 부재는 비교 대상이 없는 게이트 우회다 — 현재 코드로 베이스라인을
  // 재생성해서 "통과"시키면 snapshot.json 을 지우는 PR 로 드리프트 게이트가
  // 무력화된다. 명시적 --update(의도 갱신)에서만 생성한다.
  if (!existsSync(snapshotPath)) {
    console.error(
      `snapshot missing: ${SNAPSHOT_DIR}/${SNAPSHOT_FILE} — restore it from git, or run with --update to (re)generate it intentionally and commit the result`,
    );
    process.exitCode = 1;
    return;
  }
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  if (snapshot.version !== SNAPSHOT_VERSION) {
    console.error(
      `snapshot version ${snapshot.version ?? '(missing)'} != ${SNAPSHOT_VERSION} — re-run with --update after upgrading this script`,
    );
    process.exitCode = 1;
    return;
  }
  const drift = compareSurface(collectSurface(root), snapshot);
  if (driftCount(drift) > 0) {
    console.error('API surface drift detected — update intentionally via --update:');
    for (const [section, items] of Object.entries(drift.added)) {
      for (const item of items) console.error(`  + ${section}: ${item}`);
    }
    for (const [section, items] of Object.entries(drift.changed)) {
      for (const item of items) console.error(`  ~ ${section}: ${item}`);
    }
    for (const [section, items] of Object.entries(drift.removed)) {
      for (const item of items) console.error(`  - ${section}: ${item}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log('OK: API surface matches snapshot');
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) run();

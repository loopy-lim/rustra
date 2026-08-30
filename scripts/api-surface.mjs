// API 표면 스냅샷 게이트 — Rust/TS 공개 export 를 api-surface/snapshot.json 에 고정하고
// 드리프트(추가/삭제)를 감지한다. `node scripts/api-surface.mjs` (비교) 또는 `--update`(갱신).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** ffi*.rs 의 C-ABI 함수 이름 (`pub unsafe extern "C" fn` 과 `pub extern "C" fn` 모두). */
export function collectFfiExports(sourceTexts) {
  const names = [];
  for (const text of sourceTexts) {
    for (const match of text.matchAll(
      /(^|\n)\s*pub (?:unsafe )?extern "C" fn (rustra_[a-z_0-9]+)/g,
    )) {
      names.push(match[2]);
    }
  }
  return uniqueSorted(names);
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
  return {
    rustModules: collectRustModules(rustLibRs),
    ffiExports: collectFfiExports(rustSourceTexts),
    macros: collectMacros(macroSourceTexts),
    tsExports: Object.fromEntries(
      Object.entries(packageIndexes).map(([pkg, text]) => [pkg, collectTsExports(text)]),
    ),
  };
}

/** 저장소 전체의 공개 표면을 수집한다 (모든 배열은 정렬·중복 제거됨). */
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
    rustModules: surface.rustModules,
    ffiExports: surface.ffiExports,
    macros: surface.macros,
    tsExports: surface.tsExports,
  };
  for (const key of Object.keys(ordered.tsExports)) {
    if (!Array.isArray(ordered.tsExports[key])) delete ordered.tsExports[key];
  }
  ordered.tsExports = Object.fromEntries(Object.entries(ordered.tsExports).sort());
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** 스냅샷 대비 추가/삭제 항목을 섹션별로 묶어 반환한다. */
export function compareSurface(current, snapshot) {
  const added = {};
  const removed = {};
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
  return { added, removed };
}

function driftCount({ added, removed }) {
  return (
    Object.values(added).reduce((sum, items) => sum + items.length, 0) +
    Object.values(removed).reduce((sum, items) => sum + items.length, 0)
  );
}

function run() {
  const root = process.cwd();
  const snapshotPath = join(root, SNAPSHOT_DIR, SNAPSHOT_FILE);
  const update = process.argv.includes('--update');
  if (update || !existsSync(snapshotPath)) {
    mkdirSync(join(root, SNAPSHOT_DIR), { recursive: true });
    writeFileSync(snapshotPath, serializeSurface(collectSurface(root)));
    console.log(update ? `snapshot updated: ${SNAPSHOT_DIR}/${SNAPSHOT_FILE}` : 'snapshot created');
    return;
  }
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  const drift = compareSurface(collectSurface(root), snapshot);
  if (driftCount(drift) > 0) {
    console.error('API surface drift detected — update intentionally via --update:');
    for (const [section, items] of Object.entries(drift.added)) {
      for (const item of items) console.error(`  + ${section}: ${item}`);
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

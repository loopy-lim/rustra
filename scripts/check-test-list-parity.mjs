// M2 패리티 게이트(DX_AUDIT.md) — "이밋 산물 vs 스크립트 나열" 일치 검사.
// 수동 테스트 나열 스크립트가 새 테스트 파일을 누락하거나, 삭제된 파일을
// 계속 참조하는(stale) 드리프트를 로컬/CI에서 조기 적발한다.
//
// 검사 대상:
//   1. test:ts:node        — dist-ts/examples/*/ts/*.test.js 전부가 커맨드에
//                            포함(명시 또는 glob)되어야 한다.
//   2. packages/cli "test" — dist-test/*.test.js 전부가 node --test 세그먼트에
//                            명시되거나, bun:test 전용 파일이면 src/<stem>.test.ts가
//                            bun test 세그먼트에 있어야 한다.
//   3. coverage:ts         — packages/react/src/*.test.ts 전부가 포함되어야 한다.
// 반대 방향(stale 참조: 디스크에 없는데 나열됨)도 함께 실패 처리한다.

import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CLI_PACKAGE_REL = 'packages/cli';
const REACT_SRC_REL = 'packages/react/src';

function tokenToMatcher(token) {
  const normalized = token.replace(/^\.\//, '');
  if (!normalized.includes('*')) return null;
  const escaped = normalized
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^\\s]*');
  return new RegExp(`^${escaped}$`);
}

function listTestFiles(dirRel, suffix) {
  const absolute = resolve(REPO_ROOT, dirRel);
  let entries;
  try {
    entries = readdirSync(absolute);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(suffix))
    .map((name) => join(dirRel, name))
    .sort();
}

function extractTokens(script) {
  return script.split(/\s+|&&/).filter((token) => token.includes('.test.'));
}

function isCovered(relPath, tokens) {
  return tokens.some((token) => {
    if (token === relPath) return true;
    const matcher = tokenToMatcher(token);
    return matcher !== null && matcher.test(relPath);
  });
}

/**
 * dist-ts 이밋 테스트가 test:ts:node 커맨드에 전부 반영됐는지 검사.
 * @returns {{ missing: string[], stale: string[] }}
 */
export function checkDistTsCoverage(script, emitted) {
  const tokens = extractTokens(script).filter((token) => token.startsWith('dist-ts/'));
  const missing = emitted.filter((file) => !isCovered(file, tokens));
  const stale = tokens.filter((token) => {
    if (token.includes('*')) {
      const matcher = tokenToMatcher(token);
      return matcher !== null && !emitted.some((file) => matcher.test(file));
    }
    return !emitted.includes(token);
  });
  return { missing, stale };
}

/**
 * cli dist-test 이밋이 node --test(명시) 또는 bun test(src 대응) 세그먼트에
 * 전부 반영됐는지 검사. bun:test 전용 테스트는 node에서 로드 불가(`bun:` URL
 * scheme)이므로 src/*.test.ts가 bun 세그먼트에 있으면 충분하다.
 * @returns {{ missing: string[], stale: string[] }}
 */
export function checkCliTestCoverage(cliTestScript, emittedDistTest, emittedSrcTests) {
  const commands = cliTestScript.split('&&').map((part) => part.trim());
  const nodeCommand = commands.find((command) => command.startsWith('node --test')) ?? '';
  const bunCommand = commands.find((command) => command.startsWith('bun test src/')) ?? '';
  const nodeTokens = extractTokens(nodeCommand).filter((token) => token.startsWith('dist-test/'));
  const bunSrcTokens = extractTokens(bunCommand).filter((token) => token.startsWith('src/'));

  const missing = [];
  for (const file of emittedDistTest) {
    if (nodeTokens.includes(file)) continue;
    const stem = file.slice('dist-test/'.length, -'.test.js'.length);
    const srcCounterpart = `src/${stem}.test.ts`;
    if (bunSrcTokens.includes(srcCounterpart) && emittedSrcTests.includes(srcCounterpart)) continue;
    missing.push(file);
  }

  const stale = [
    ...nodeTokens.filter((token) => !emittedDistTest.includes(token)),
    ...bunSrcTokens.filter((token) => !emittedSrcTests.includes(token)),
  ];
  return { missing, stale };
}

/**
 * react 테스트가 coverage:ts에 전부 반영됐는지 검사.
 * @returns {{ missing: string[], stale: string[] }}
 */
export function checkCoverageTsCoverage(coverageScript, emittedReactTests) {
  const tokens = extractTokens(coverageScript);
  const missing = emittedReactTests.filter((file) => !tokens.includes(file));
  const stale = tokens.filter(
    (token) => token.startsWith(`${REACT_SRC_REL}/`) && !emittedReactTests.includes(token),
  );
  return { missing, stale };
}

function formatReport(label, { missing, stale }) {
  const lines = [];
  for (const file of missing) lines.push(`  missing (실행되지 않음): ${file}`);
  for (const file of stale) lines.push(`  stale (디스크에 없음): ${file}`);
  if (lines.length > 0) lines.unshift(label);
  return lines;
}

export async function checkTestListParity({ rootPackageJsonPath, cliPackageJsonPath } = {}) {
  const rootPath = resolve(REPO_ROOT, rootPackageJsonPath ?? 'package.json');
  const cliPath = resolve(REPO_ROOT, cliPackageJsonPath ?? join(CLI_PACKAGE_REL, 'package.json'));
  const rootPackage = JSON.parse(await readFile(rootPath, 'utf8'));
  const cliPackage = JSON.parse(await readFile(cliPath, 'utf8'));

  const distTs = [
    ...listTestFiles('dist-ts/examples/calculator/ts', '.test.js'),
    ...listTestFiles('dist-ts/examples/crud/ts', '.test.js'),
  ];
  const cliDistTest = listTestFiles(join(CLI_PACKAGE_REL, 'dist-test'), '.test.js').map((file) =>
    relative(CLI_PACKAGE_REL, file),
  );
  const cliSrcTests = listTestFiles(join(CLI_PACKAGE_REL, 'src'), '.test.ts').map((file) =>
    relative(CLI_PACKAGE_REL, file),
  );
  const reactTests = listTestFiles(REACT_SRC_REL, '.test.ts');

  const reports = [
    ...formatReport(
      'test:ts:node',
      checkDistTsCoverage(rootPackage.scripts['test:ts:node'], distTs),
    ),
    ...formatReport(
      `${CLI_PACKAGE_REL} test`,
      checkCliTestCoverage(cliPackage.scripts.test, cliDistTest, cliSrcTests),
    ),
    ...formatReport(
      'coverage:ts',
      checkCoverageTsCoverage(rootPackage.scripts['coverage:ts'], reactTests),
    ),
  ];

  return {
    ok: reports.length === 0,
    reports,
  };
}

export async function main() {
  const { ok, reports } = await checkTestListParity();
  if (!ok) {
    console.error(
      'FAIL: 테스트 나열 패리티 드리프트 — 아래 파일을 scripts에 반영하거나 제거하세요.',
    );
    for (const line of reports) console.error(line);
    process.exitCode = 1;
    return;
  }
  console.log('OK: 테스트 나열 패리티 — 이밋 산물과 스크립트 나열이 일치');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

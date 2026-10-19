#!/usr/bin/env node
/**
 * react-doctor CI 게이트 — 인간모드 스캔 + 허용 클래스 표 판정.
 *
 * 실측 정리(2026-10-19, 848edf30..766c0185, 8회 CI 실행):
 *   - react-doctor@0.9.12 의 스캔은 동일 트리·동일 플래그에서도 2건↔53건이
 *     오간다(848edf30=2건, 766c0185=53건 — umbrella 선행·인간모드·사용자 ignore
 *     없음으로 동일 조건). 판정이 도구 내부 상태에 흔들린다.
 *   - 어떤 사용자 ignore 원천(doctor.config ignore.*·surfaces, .gitignore 패턴)
 *     이든 내장 제외셋을 대체해 generated/*·빌드 산물 오탐이 폭발한다
 *     (8f2f74a5·ae526c21·c266138c 실측). --json 모드는 인간모드와 다른 스캔을
 *     낳는다(c9e4fb80·90ab1d49 실측).
 *
 * 그래서 이 게이트는 "어떤 finding 클래스를 받아들이는가"를 표로 명시하고, 그
 * 외 전부 실패한다. 각 클래스에는 사유를 적는다 — 새 실수는 전부 게이트에 잡히
 * 고, 허용된 것은 아티팩트 로그로 공개된다.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 경로 클래스 허용 — [prefix, 규칙 집합, 사유]. prefix 는 정규화된 슬래시 경로의
 * 시작 일치다. 규칙 집합이 null 이면 그 경로의 모든 진단을 허용.
 */
const TOLERATED_PATH_CLASSES = [
  [
    'docs/verification/evidence/',
    ['unused-file'],
    '증거 번들 — 매니페스트가 sha256 으로 pin 한 당시 원본 소스·로그 보존물. 앱 소스가 아니고 파일 수정은 무결성을 깬다.',
  ],
  [
    'docs/api/assets/',
    null,
    '문서 사이트 정적 에셋(미리 만들어진 hierarchy·navigation js) — 앱 소스가 아니다.',
  ],
  [
    'examples/',
    ['unused-file', 'unused-export', 'circular-dependency'],
    '예제의 코드젠 생성물(generated/**)과 모듈 진입점 — 생성기가 정본이고 eslint 도 **/generated/** 를 제외한다. 도구가 생성물을 앱 소스로 읽을 때만 나오는 오탐이다.',
  ],
  [
    'packages/cli/src/cargo-metadata.ts',
    ['import-metadata-execution-risk'],
    'cargo metadata 파싱→스폰은 이 도구의 본연 — 배치 이전 소스이며 848edf30 동일 소스가 미플래그라 도구 판정이 불안정하다.',
  ],
  [
    'packages/types/src/global-batch-settled.ts',
    ['async-await-in-loop'],
    '배치 정산 루프의 순차 대기 — 848edf30 동일 소스가 미플래그라 도구 판정이 불안정하다.',
  ],
];

/** 규칙 + 파일 모양 허용 — 측정 루프는 순차 await 자체가 대상값이다. */
const TOLERATED_RULE_FILE_PATTERNS = [
  [
    'async-await-in-loop',
    /\/(apps\/(bun-ffi-bench|scriptc-bench|performance-stats)\.ts|src\/benchmark\.ts)$/,
    '지연 벤치의 측정 루프 — Promise.all 은 동시성을 추가해 수치를 바꾼다(bun-ffi-bench 는 인라인 억제 병행).',
  ],
  [
    /./, // 빌드 산물은 규칙 무관 — 컴파일 출력은 소스가 아니다.
    /(^|\/)(dist|dist-ts|dist-test|target)\/|(^|\/)\.worktrees\//,
    '빌드 산물·워크트리 — 컴파일 출력과 격리 트리라 소스 검증 대상이 아니다.',
  ],
];

const workLog = join(mkdtempSync(join(tmpdir(), 'react-doctor-gate-')), 'scan.log');
const result = spawnSync(
  'bunx',
  [
    '--bun',
    'react-doctor@0.9.12',
    '.',
    '--yes',
    '--scope',
    'full',
    '--verbose',
    '--blocking',
    'warning',
  ],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
);
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
mkdirSync(tmpdir(), { recursive: true });
writeFileSync(workLog, output);
if (result.error) {
  console.error(`react-doctor gate: scanner failed to launch: ${result.error.message}`);
  process.exit(1);
}

// 인간모드 출력 구조: "⚠ rule-key" 헤더 아래 "  rule-key" 행, 그 다음부터
// 들여쓴 파일 경로(:line 접미사 가능) 행들이 이어진다.
const tolerated = [];
const violations = [];
let currentRule = null;
const classify = (rule, file) => {
  const normalized = file.replaceAll('\\', '/');
  for (const [ruleFilePattern, pathPattern, reason] of TOLERATED_RULE_FILE_PATTERNS) {
    const ruleMatch =
      typeof ruleFilePattern === 'string' ? ruleFilePattern === rule : ruleFilePattern.test(rule);
    if (ruleMatch && pathPattern.test(normalized)) return reason;
  }
  for (const [prefix, rules, reason] of TOLERATED_PATH_CLASSES) {
    if (normalized.startsWith(prefix) && (rules === null || rules.includes(rule))) return reason;
  }
  return null;
};
for (const rawLine of output.split('\n')) {
  const line = rawLine.replace(/\x1b\[[0-9;]*m/g, '');
  const ruleHeader = line.match(/^\s{2}((?:[\w-]+)\/(?:[\w-]+))\s*$/);
  const fileLine = line.match(/^\s+(\S+)\s*$/);
  if (ruleHeader) {
    currentRule = ruleHeader[1];
    continue;
  }
  if (!fileLine || !currentRule) continue;
  // finding 경로는 :line(:column) 접미사를 달고 온다 — 분류 전에 벗긴다.
  // 규칙 id 는 출력 위치에 따라 plugin 접두사가 붙고 안 붙고 한다 — bare 형태로 정규화.
  const file = fileLine[1].replace(/:\d+(?::\d+)?$/, '');
  const ruleKey = currentRule.includes('/')
    ? currentRule.slice(currentRule.indexOf('/') + 1)
    : currentRule;
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file) === false) continue;
  const reason = classify(ruleKey, file);
  if (reason) tolerated.push(`${currentRule}: ${file} — ${reason}`);
  else violations.push(`${currentRule}: ${file}`);
}

console.log(`react-doctor gate: tolerated ${tolerated.length} finding(s) by documented classes`);
for (const line of tolerated) console.log(`  tolerated  ${line}`);
if (result.status !== 0 && violations.length === 0 && tolerated.length === 0) {
  // 허용·위반 분류가 모두 비었는데 스캐너가 실패했다 — 출력 구조 변경 가능성.
  // 로그를 남기고 실패한다(무음 통과 금지).
  console.error(`react-doctor gate: scanner exited ${result.status}; findings parse found nothing`);
  console.error(`react-doctor gate: full output at ${workLog}`);
  process.exit(result.status ?? 1);
}
if (violations.length > 0) {
  console.error(`react-doctor gate: ${violations.length} finding(s) block the gate:`);
  for (const line of violations) console.error(`  ✗ ${line}`);
  console.error(
    'react-doctor gate: findings above must be fixed. Documented tolerance classes live in\n' +
      'scripts/react-doctor-gate.mjs (TOLERATED_PATH_CLASSES / TOLERATED_RULE_FILE_PATTERNS)\n' +
      '— extend them only with a written reason.',
  );
  process.exit(1);
}
console.log('react-doctor gate: green (only documented tolerance classes)');

#!/usr/bin/env node
/**
 * react-doctor CI 게이트 — 인간모드 스캔 + 증거 번들 허용 판정.
 *
 * 실측 정리(2026-10-19, 848edf30..90ab1d49):
 *   - 인간모드(`--yes --scope full --verbose --blocking warning`) + 사용자 ignore
 *     원천 없음 + umbrella 먼저 = 2건(hello.ts unused-file + 벤치 await — 벤치는
 *     인라인 억제됨). 유일한 깨끗한 스캔 조건이다.
 *   - 어떤 설정 키(doctor.config ignore.*·surfaces)든 .gitignore 스캔 패턴이든
 *     내장 제외셋을 대체해 generated/* 등 오탐이 폭발한다(8f2f74a5·ae526c21·
 *     c266138c 실측).
 *   - --json 모드는 인간모드와 다른 스캔(102건+)을 낳는다(c9e4fb80·90ab1d49).
 *
 * 그래서 이 스크립트는 인간모드 출력을 그대로 로그에 tee 하고, 그 로그를
 * 파싱해 docs/verification/evidence/** 의 unused-file 만 허용한다. 증거 번들은
 * 매니페스트가 sha256 으로 pin 한 당시 원본 소스·로그 보존물이라 앱 소스가 아니
 * 고, 파일 수정·이동은 무결성을 깬다. 그 외 모든 진단은 기존 계약대로 실패.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOLERATED_RULES = new Set(['unused-file', 'deslop/unused-file']);
const TOLERATED_PREFIX = 'docs/verification/evidence/';

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
writeFileSync(workLog, output);
if (result.error) {
  console.error(`react-doctor gate: scanner failed to launch: ${result.error.message}`);
  process.exit(1);
}

// 인간모드 출력 구조: "⚠ rule-key" 헤더 아래 "  rule-key" 행, 그 다음부터
// 들여쓴 파일 경로 행들이 이어진다(빈 줄/다음 블록에서 끝).
const tolerated = [];
const violations = [];
let currentRule = null;
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
  const file = fileLine[1].replace(/:\d+(?::\d+)?$/, '');
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file) === false) continue;
  if (TOLERATED_RULES.has(currentRule) && file.replaceAll('\\', '/').startsWith(TOLERATED_PREFIX)) {
    tolerated.push(`${currentRule}: ${file}`);
  } else {
    violations.push(`${currentRule}: ${file}`);
  }
}

console.log(`react-doctor gate: tolerated ${tolerated.length} evidence-bundle finding(s)`);
for (const line of tolerated) console.log(`  tolerated  ${line}`);
if (result.status !== 0 && violations.length === 0) {
  // 허용 분류가 비었는데 스캐너가 실패했다 — 출력 구조 변경 가능성. 로그를
  // 남기고 실패한다(무음 통과 금지).
  console.error(`react-doctor gate: scanner exited ${result.status}; findings parse found nothing`);
  console.error(`react-doctor gate: full output at ${workLog}`);
  process.exit(result.status ?? 1);
}
if (violations.length > 0) {
  console.error(`react-doctor gate: ${violations.length} finding(s) block the gate:`);
  for (const line of violations) console.error(`  ✗ ${line}`);
  console.error(
    'react-doctor gate: findings above must be fixed or, for evidence-bundle artifacts only,\n' +
      'extended via TOLERATED in scripts/react-doctor-gate.mjs (with a written reason).',
  );
  process.exit(1);
}
console.log('react-doctor gate: green (only tolerated evidence-bundle findings)');

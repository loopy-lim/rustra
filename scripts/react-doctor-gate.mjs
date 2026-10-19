#!/usr/bin/env node
/**
 * react-doctor CI 게이트 — 스캐너는 그대로 두고 판정만 위탁한다.
 *
 * doctor.config.ts 나 .gitignore 스캔 제외를 쓰면 react-doctor 의 내장 제외셋
 * (generated/**, dist/** 등)이 통째로 대체되어 오탐이 폭발한다(8f2f74a5·
 * ae526c21·c266138c 실측). 그래서 설정 파일 없이 기본 스캔을 돌리고, JSON 진단을
 * 이 스크립트가 분류한다:
 *
 *   - docs/verification/evidence/** 의 deslop/unused-file 만 허용한다. 증거
 *     번들은 매니페스트가 sha256 으로 pin 한 당시 원본 소스·로그 보존물이라 앱
 *     소스가 아니고, 파일 수정·이동은 무결성을 깬다(도구의 어떤 설정 경로도
 *     파일 단위 제외를 내장셋 보존과 함께 제공하지 않는다).
 *   - 그 외 모든 진단은 기존 계약(--blocking warning, 100/100)대로 실패.
 *
 * 판정 근거 보존: 전체 리포트를 $RUNNER_TEMP/react-doctor-report.json 에 기록해
 * CI 아티팩트로 올린다.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TOLERATED = {
  rule: 'deslop/unused-file',
  pathPrefix: 'docs/verification/evidence/',
};

const result = spawnSync(
  'bunx',
  ['--bun', 'react-doctor@0.9.12', '.', '--json', '--blocking', 'warning'],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
);
const outputDir = process.env.RUNNER_TEMP
  ? join(process.env.RUNNER_TEMP, 'react-doctor-gate')
  : null;
if (result.error) {
  console.error(`react-doctor gate: scanner failed to launch: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0 && !result.stdout?.trim().startsWith('{')) {
  // JSON 리포트 없이 죽은 경우 — 스캐너 자체 고장이므로 그대로 실패.
  process.stderr.write(result.stderr ?? '');
  console.error(`react-doctor gate: scanner exited ${result.status} without a JSON report`);
  process.exit(result.status ?? 1);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch (error) {
  console.error(`react-doctor gate: could not parse scanner JSON: ${error.message}`);
  process.exit(1);
}
if (outputDir) {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'react-doctor-report.json'), result.stdout);
}

const tolerated = [];
const violations = [];
const walk = (node) => {
  if (Array.isArray(node)) {
    node.forEach(walk);
    return;
  }
  if (node && typeof node === 'object') {
    const rule = node.rule ?? node.id;
    const file = node.filePath ?? node.path;
    if (typeof rule === 'string' && typeof file === 'string') {
      if (rule === TOLERATED.rule && file.replaceAll('\\', '/').startsWith(TOLERATED.pathPrefix)) {
        tolerated.push(`${rule}: ${file}`);
      } else {
        violations.push(`${node.severity ?? 'finding'} ${rule}: ${file}`);
      }
      return;
    }
    Object.values(node).forEach(walk);
  }
};
walk(report);

console.log(`react-doctor gate: tolerated ${tolerated.length} evidence-bundle finding(s)`);
for (const line of tolerated) console.log(`  tolerated  ${line}`);
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

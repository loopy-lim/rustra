#!/usr/bin/env node
/**
 * 온보딩 게이트 — 신규 사용자 여정(init → doctor → codegen → demo)을 실제로
 * 수행해 CI에서 매일 검증한다. 산문("init 하면 됩니다")이 아니라 게이트로 계약한다.
 *
 * 단계:
 *   1. init    — rustra CLI로 onboarding-probe 스캐폴드 생성
 *   2. doctor  — 환경 진단(경고는 통과, 필수 fail만 중단)
 *   3. build   — cargo build (스캐폴드의 Rust 제너레이터 빌드)
 *   4. codegen — rustra codegen (Rust 계약 프로브 → schema.json → TS 표면)
 *   5. demo    — 생성된 호스트 엔트리로 데모 실행
 *
 * fail-closed: 어느 단계든 비정상 종료하면 그 단계 이름과 출력 꼬리를 남기고 1로 끝난다.
 * `runner`를 주입받아 로직은 스폰 없이 테스트 가능(onboarding-gate.test.ts).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_NAME = 'onboarding-probe';

/** 단계 정의 — name은 게이트 보고용, cmd는 실행 커맨드 구성(cwd는 스캐폴드 프로젝트). */
export const ONBOARDING_STEPS = [
  { name: 'init' },
  { name: 'doctor' },
  { name: 'build', argv: ['cargo', 'build'] },
  { name: 'codegen' },
  { name: 'demo' },
];

const OUTPUT_TAIL_CHARS = 2000;

function tail(text) {
  const trimmed = (text ?? '').trim();
  return trimmed.length <= OUTPUT_TAIL_CHARS ? trimmed : `…${trimmed.slice(-OUTPUT_TAIL_CHARS)}`;
}

function cliBin(repoRoot) {
  return resolve(repoRoot, 'packages', 'cli', 'dist', 'index.js');
}

/** 각 단계의 실제 커맨드 — init/codegen은 저장소 CLI bin을 절대 경로로 실행한다.
 *  root는 스캐프폴드가 생기는 임시 디렉토리, repoRoot는 CLI bin이 있는 저장소. */
export function commandFor(step, root, repoRoot) {
  const bin = cliBin(repoRoot ?? root);
  const projectDir = join(root, PROJECT_NAME);
  switch (step) {
    case 'init':
      return { cwd: root, argv: [process.execPath, bin, 'init', PROJECT_NAME] };
    case 'doctor':
      return {
        cwd: projectDir,
        argv: [process.execPath, bin, 'doctor', '--config', 'rustra.json'],
      };
    case 'codegen':
      return {
        cwd: projectDir,
        argv: [process.execPath, bin, 'codegen', '--config', 'rustra.json'],
      };
    case 'demo': {
      // init 스캐폴드의 데모 스크립트 그대로 — bun으로 src/index.ts를 실행한다.
      return { cwd: projectDir, argv: ['bun', 'run', 'demo'] };
    }
    default:
      throw new Error(`unknown onboarding step: ${step}`);
  }
}

export async function runOnboardingSteps({ root, repoRoot, runner }) {
  const projectDir = join(root, PROJECT_NAME);
  for (const step of ONBOARDING_STEPS) {
    const command =
      step.argv ? { cwd: projectDir, argv: step.argv } : commandFor(step.name, root, repoRoot);
    const result = await runner(step.name, command);
    if (!result.ok)
      return {
        ok: false,
        error: `onboarding gate failed at step "${step.name}":\n${tail(result.output)}`,
      };
  }
  return { ok: true };
}

function defaultRunner(step, command) {
  const label = `[onboarding:${step}] ${command.argv.join(' ')} (cwd ${command.cwd})`;
  console.log(label);
  const spawned = spawnSync(command.argv[0], command.argv.slice(1), {
    cwd: command.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  const output = `${spawned.stdout ?? ''}${spawned.stderr ?? ''}`;
  if (output.trim()) console.log(tail(output));
  return {
    ok: spawned.status === 0,
    output: spawned.status === 0 ? '' : output,
  };
}

async function main() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const scratch = mkdtempSync(join(tmpdir(), 'rustra-onboarding-'));
  process.exitCode = 1;
  try {
    const report = await runOnboardingSteps({
      root: scratch,
      repoRoot: root,
      runner: defaultRunner,
    });
    if (!report.ok) {
      console.error(report.error);
      return;
    }
    console.log('[onboarding] init → doctor → build → codegen → demo: all green');
    process.exitCode = 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// 실행(entry)으로 직접 구동될 때만 실제 게이트를 돌린다 — 테스트 import는 부작용 없음.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  await main();

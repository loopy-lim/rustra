#!/usr/bin/env node
/**
 * 온보딩 게이트 — 신규 사용자 여정(init → doctor → codegen → demo)과 유지보수
 * 사이클(스키마 변경 → 재코드젠 → 재호출)을 실제로 수행해 CI에서 매일 검증한다.
 * 산문("init 하면 됩니다")이 아니라 게이트로 계약한다.
 *
 * 단계:
 *   1. init          — rustra CLI로 onboarding-probe 스캐폴드 생성
 *   2. doctor        — 환경 진단(경고는 통과, 필수 fail만 중단)
 *   3. build         — cargo build (스캐폴드의 Rust 제너레이터 빌드)
 *   4. codegen       — rustra codegen (Rust 계약 프로브 → schema.json → TS 표면)
 *   5. demo          — 생성된 호스트 엔트리로 데모 실행
 *   6. codegen-check — rustra codegen --check (check 계약의 행위 커버: 스키마 재산출 + 드리프트 0)
 *   7. mutate        — 게이트가 스캐폴드를 직접 고친다: EchoInput/EchoOutput 에 repeat: u32 추가,
 *                      호출부(index.ts)에도 repeat 을 넣는다(필수 필드라 serde 가 누락을 거절한다)
 *   8. regen         — rustra codegen 재실행 (cargo 가 lib.rs 변경을 감지해 재빌드 → 스키마 재산출)
 *   9. verify        — 생성된 types.ts 에 repeat 이 선언됐는지 단정 + demo 재실행(재호출 성공)
 *
 * fail-closed: 어느 단계든 실패하면 그 단계 이름과 출력 꼬리를 남기고 1로 끝난다.
 * 각 단계의 durationMs 를 보고한다(로드맵 지표 "온보딩 게이트 E2E 시간"의 측정 근거 —
 * 임계 게이팅은 의도적으로 하지 않는다).
 * `runner`를 주입받아 스폰 없이 테스트 가능하고, mutate(fs 조작)도 주입 가능하다
 * (onboarding-gate.test.ts).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_NAME = 'onboarding-probe';

/** 단계 정의 — name은 게이트 보고용, argv가 있으면 프로젝트 디렉터리에서 그대로 실행하고,
 *  없으면 commandFor 가 커맨드를 구성한다. mutate/verify 는 루프에서 이름으로 특수 처리된다. */
export const ONBOARDING_STEPS = [
  { name: 'init' },
  { name: 'doctor' },
  { name: 'build', argv: ['cargo', 'build'] },
  { name: 'codegen' },
  { name: 'demo' },
  { name: 'codegen-check' },
  { name: 'mutate' },
  { name: 'regen' },
  { name: 'verify' },
];

/** mutate 가 스캐폴드에 새로 심는 필드 — regen 후 types.ts 에 나타나야 한다. */
const MUTATED_FIELD_PATTERN = /\brepeat\s*:\s*number\b/;

const OUTPUT_TAIL_CHARS = 2000;

function tail(text) {
  const trimmed = (text ?? '').trim();
  return trimmed.length <= OUTPUT_TAIL_CHARS ? trimmed : `…${trimmed.slice(-OUTPUT_TAIL_CHARS)}`;
}

function cliBin(repoRoot) {
  return resolve(repoRoot, 'packages', 'cli', 'dist', 'index.js');
}

/** 각 단계의 실제 커맨드 — init/codegen은 저장소 CLI bin을 절대 경로로 실행한다.
 *  root는 스캐프폴드가 생기는 임시 디렉토리, repoRoot는 CLI bin이 있는 저장소.
 *  mutate/verify 는 커맨드가 아니라 게이트 자신의 fs 동작이라 여기에 없다. */
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
    case 'codegen-check':
      // check 모드는 직전 codegen 이 남긴 .rustra-generated.json 매니페스트를 요구하고
      // RUSTRA_SCHEMA_OUT 임시 디렉터리로 스키마를 재산출한 뒤 드리프트 0을 단정한다.
      return {
        cwd: projectDir,
        argv: [process.execPath, bin, 'codegen', '--config', 'rustra.json', '--check'],
      };
    case 'regen':
      // 재코드젠 — 일반 codegen 과 같은 커맨드. cargo run 이 lib.rs 변경을 감지해 재빌드한다.
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

function applyReplacements(source, label, replacements) {
  let updated = source;
  for (const [anchor, replacement] of replacements) {
    if (!updated.includes(anchor))
      throw new Error(
        `scaffold anchor not found in ${label} — the init template changed; ` +
          `edit mutateScaffoldSources in scripts/onboarding-gate.mjs to match:\n${anchor}`,
      );
    updated = updated.replace(anchor, replacement);
  }
  return updated;
}

/** 스키마 변경 재현(순수 함수) — EchoInput/EchoOutput 에 repeat: u32 를 추가하고 핸들러가
 *  받은 값을 되돌리며, TS 호출부에도 repeat 을 넣는다. 앵커는 init 템플릿의 결정적 산출물에
 *  고정하고, 어긋나면 fail-closed 로 죽는다(템플릿 변경이 게이트를 빨객게 만들어 함께 갱신).
 *  이미 변형된 입력엔 앵커가 없으므로 재적용도 실패한다 — 이중 변형은 불가능하다. */
export function mutateScaffoldSources({ libRs, appTs }) {
  return {
    libRs: applyReplacements(libRs, 'src/lib.rs', [
      [
        'pub struct EchoInput {\n    pub message: String,\n}',
        'pub struct EchoInput {\n    pub message: String,\n    pub repeat: u32,\n}',
      ],
      [
        'pub struct EchoOutput {\n    pub message: String,\n}',
        'pub struct EchoOutput {\n    pub message: String,\n    pub repeat: u32,\n}',
      ],
      [
        'Ok(EchoOutput { message: input.message })',
        'Ok(EchoOutput { message: input.message, repeat: input.repeat })',
      ],
    ]),
    appTs: applyReplacements(appTs, 'src/index.ts', [
      [
        "await echo({ message: 'hello from TypeScript' })",
        "await echo({ message: 'hello from TypeScript', repeat: 3 })",
      ],
    ]),
  };
}

/** 기본 mutate — 스캐폴드의 lib.rs 와 index.ts 를 직접 고친다(스폰 없는 fs 조작). */
export function mutateScaffoldProject(projectDir) {
  const libRsPath = join(projectDir, 'src', 'lib.rs');
  const appTsPath = join(projectDir, 'src', 'index.ts');
  const mutated = mutateScaffoldSources({
    libRs: readFileSync(libRsPath, 'utf8'),
    appTs: readFileSync(appTsPath, 'utf8'),
  });
  writeFileSync(libRsPath, mutated.libRs);
  writeFileSync(appTsPath, mutated.appTs);
}

/** regen 산출물 단정 — 변형된 필드가 types.ts 에 도달했는지. 문제 문장 또는 null. */
export function verifyRegenerated(projectDir) {
  const typesPath = join(projectDir, 'src', 'generated', 'types.ts');
  let content;
  try {
    content = readFileSync(typesPath, 'utf8');
  } catch {
    return `generated types.ts not found at ${typesPath} — regen must produce it before verify`;
  }
  if (!MUTATED_FIELD_PATTERN.test(content))
    return `regenerated types.ts at ${typesPath} does not declare the mutated field (expected /${MUTATED_FIELD_PATTERN.source}/); the schema change did not propagate through codegen`;
  return null;
}

export async function runOnboardingSteps({
  root,
  repoRoot,
  runner,
  mutate = mutateScaffoldProject,
}) {
  const projectDir = join(root, PROJECT_NAME);
  const steps = [];
  for (const step of ONBOARDING_STEPS) {
    const startedAt = Date.now();
    let failure = null;
    if (step.name === 'mutate') {
      // 스키마 변경은 스폰이 아니라 fs 조작으로 재현한다 — runner 를 거치지 않는다.
      try {
        mutate(projectDir);
      } catch (cause) {
        failure = cause instanceof Error ? cause.message : String(cause);
      }
    } else if (step.name === 'verify') {
      const drift = verifyRegenerated(projectDir);
      if (drift) failure = drift;
      else {
        // 재호출 — 변경된 계약으로 demo 가 다시 돌아가는 것까지가 사이클의 끝이다.
        const result = await runner(step.name, commandFor('demo', root, repoRoot));
        if (!result.ok) failure = result.output;
      }
    } else {
      const command = step.argv
        ? { cwd: projectDir, argv: step.argv }
        : commandFor(step.name, root, repoRoot);
      const result = await runner(step.name, command);
      if (!result.ok) failure = result.output;
    }
    steps.push({ name: step.name, durationMs: Date.now() - startedAt });
    if (failure)
      return {
        ok: false,
        steps,
        error: `onboarding gate failed at step "${step.name}":\n${tail(failure)}`,
      };
  }
  return { ok: true, steps };
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
    console.log(`[onboarding] ${report.steps.map((step) => step.name).join(' → ')}: all green`);
    console.log(
      `[onboarding] timings: ${report.steps
        .map((step) => `${step.name} ${step.durationMs}ms`)
        .join(', ')}`,
    );
    process.exitCode = 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// 실행(entry)으로 직접 구동될 때만 실제 게이트를 돌린다 — 테스트 import는 부작용 없음.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'bun:test';
import { renderInitProjectFiles, templateVersions } from '../packages/cli/src/init-template.ts';
import {
  commandFor,
  mutateScaffoldProject,
  mutateScaffoldSources,
  runOnboardingSteps,
  verifyRegenerated,
  ONBOARDING_STEPS,
} from './onboarding-gate.mjs';

const ROOT = '/tmp/unused';
const PROJECT_DIR = join(ROOT, 'onboarding-probe');

/** runner 가 도달하는 단계 — patch(fs 전제 주입)와 mutate(fs 조작)는 스폰이 아니라
 *  runner 를 거치지 않는다. */
const RUNNER_STEPS = ONBOARDING_STEPS.map((step) => step.name).filter(
  (name) => name !== 'patch' && name !== 'mutate',
);

/** 사용자 여정 전체 순서 — 보고서에 기록되는 단계(patch 제외, mutate 포함). */
const CYCLE_STEPS = ONBOARDING_STEPS.filter((step) => step.report !== false).map(
  (step) => step.name,
);

/** 검증용 스크래치 프로젝트 — verify 가 읽는 생성물만 심어둔다(스폰 없는 단위 실험). */
function scratchProject({ typesTs }: { typesTs?: string }) {
  const root = mkdtempSync(join(tmpdir(), 'rustra-onboarding-test-'));
  const projectDir = join(root, 'onboarding-probe');
  mkdirSync(join(projectDir, 'src', 'generated'), { recursive: true });
  if (typesTs !== undefined)
    writeFileSync(join(projectDir, 'src', 'generated', 'types.ts'), typesTs);
  return { root, projectDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 실제 init 템플릿 산출물로 스캐폴드를 재현한다 — 게이트 변형이 Task-1 템플릿과 맞는지
 *  행위로 확인하는 결정적 픽스처다. */
function scaffoldFromTemplate() {
  const files = renderInitProjectFiles(templateVersions('0.7.0', '^0.7.0', '^0.5.0'));
  const root = mkdtempSync(join(tmpdir(), 'rustra-onboarding-scaffold-'));
  const projectDir = join(root, 'onboarding-probe');
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, 'src', 'lib.rs'), files.libRs);
  writeFileSync(join(projectDir, 'src', 'index.ts'), files.appTs);
  return { root, projectDir, files, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('gate runs the full maintenance cycle in order: init → … → codegen-check → mutate → regen → verify', async () => {
  const events: string[] = [];
  const { root, cleanup } = scratchProject({
    typesTs: 'export type EchoInput = {\n  repeat: number;\n};',
  });
  try {
    const report = await runOnboardingSteps({
      root,
      runner: async (step) => {
        events.push(step);
        return { ok: true, output: '' };
      },
      mutate: () => events.push('mutate'),
    });
    assert.ok(report.ok);
    // runner 시퀀스 — mutate(fs 조작)와 patch(fs 전제 주입)만 빠지고 나머지는 전부 runner.
    assert.deepEqual(
      events.filter((step) => step !== 'mutate'),
      RUNNER_STEPS,
    );
    // 전체 사이클 순서 — mutate 포함, patch(스폰 없는 fs 전제) 제외, 정의 순서 그대로.
    assert.deepEqual(events, CYCLE_STEPS);
  } finally {
    cleanup();
  }
});

test('gate fails when any step exits non-zero and names the failed step', async () => {
  const report = await runOnboardingSteps({
    root: ROOT,
    mutate: () => {},
    runner: async (step) =>
      step === 'codegen' ? { ok: false, output: 'schema not found' } : { ok: true, output: '' },
  });
  assert.equal(report.ok, false);
  assert.match(report.error ?? '', /codegen/);
  assert.match(report.error ?? '', /schema not found/);
});

test('gate aborts at the first failed step without running later steps', async () => {
  const ran: string[] = [];
  const report = await runOnboardingSteps({
    root: ROOT,
    mutate: () => ran.push('mutate'),
    runner: async (step) => {
      ran.push(step);
      return step === 'doctor' ? { ok: false, output: 'rustc missing' } : { ok: true, output: '' };
    },
  });
  assert.equal(report.ok, false);
  assert.deepEqual(ran, ['init', 'doctor'], 'steps after a failure must not run');
});

test('scaffold generate bin honors RUSTRA_SCHEMA_OUT (codegen:check contract)', () => {
  // cli-codegen.ts check 모드는 RUSTRA_SCHEMA_OUT=<mkdtemp 디렉터리> 를 넘기고
  // resolve(checkRoot, 'schema.json') 이 존재하는지 요구한다. 스캐폴드의 generate bin
  // (src/bin/generate.rs)은 env 디렉터리 안에 schema.json 을 써야 codegen:check 가 녹색이다.
  const files = renderInitProjectFiles(templateVersions('0.7.0', '^0.7.0', '^0.5.0'));
  const generateRs = files.generateRs;
  // 1) env 를 읽는다.
  assert.match(generateRs, /RUSTRA_SCHEMA_OUT/);
  // 2) env 값은 디렉터리 — 그 안에 schema.json 을 붙여 쓴다 (<env>/schema.json 합성).
  assert.match(generateRs, /PathBuf::from\(p\)\.join\("schema\.json"\)/);
  // 3) env 가 없으면 기존처럼 generated/schema.json 폴백 (docs 가 가르치는 기본 흐름).
  assert.match(generateRs, /PathBuf::from\("generated"\)\.join\("schema\.json"\)/);
  // 구버전 결함 회귀 방지 — 쓰기는 env 분기 이후 out 이라는 단일 대상으로만.
  assert.match(generateRs, /std::fs::write\(&out/);
  // write_to_dir, write_schema_to_dir 모두 금지 — 발행 보장이 없는 헬퍼 의존 차단.
  assert.doesNotMatch(generateRs, /write(_schema)?_to_dir/);
});

test('every runner command runs inside the onboarding scratch project; verify reruns the demo', async () => {
  const commands: { cwd: string; argv: string[] }[] = [];
  const { root, cleanup } = scratchProject({ typesTs: '  repeat: number;' });
  try {
    await runOnboardingSteps({
      root,
      runner: async (_step, cmd) => {
        commands.push(cmd);
        return { ok: true, output: '' };
      },
      mutate: () => {},
    });
    const [initCmd, ...rest] = commands;
    // init은 저장소 루트에서, 나머지(regen/verify 데모 재실행 포함)는 스캐폴드 프로젝트 안에서 실행된다.
    assert.equal(initCmd.cwd, root);
    assert.ok(rest.length > 0, 'post-init steps must exist');
    for (const cmd of rest) assert.equal(cmd.cwd, join(root, 'onboarding-probe'));
    // verify 는 demo 커맨드를 재실행한다 — 재호출이 사이클의 끝.
    const last = rest[rest.length - 1];
    assert.deepEqual(last.argv, ['bun', 'run', 'demo']);
  } finally {
    cleanup();
  }
});

test('codegen-check gate step mirrors codegen plus --check; regen reuses codegen', () => {
  const codegen = commandFor('codegen', ROOT, ROOT);
  const check = commandFor('codegen-check', ROOT, ROOT);
  const regen = commandFor('regen', ROOT, ROOT);
  assert.deepEqual(check.argv, [...codegen.argv, '--check']);
  assert.match(check.argv.join(' '), /codegen --config rustra\.json --check$/);
  assert.deepEqual(regen.argv, codegen.argv, 'regen is the same codegen command');
  for (const cmd of [codegen, check, regen]) assert.equal(cmd.cwd, PROJECT_DIR);
});

test('mutate adds repeat to EchoInput/EchoOutput of the real Task-1 scaffold template', () => {
  // 템플릿이 echo 모양을 바꾸면 이 테스트가 빨객게 죽는다 — 게이트 변형과 템플릿은
  // 이 픽스처로 결합돼 함께 갱신된다(fail-closed).
  const files = renderInitProjectFiles(templateVersions('0.7.0', '^0.7.0', '^0.5.0'));
  const mutated = mutateScaffoldSources({ libRs: files.libRs, appTs: files.appTs });
  assert.match(
    mutated.libRs,
    /pub struct EchoInput \{\s*pub message: String,\s*pub repeat: u32,\s*\}/,
  );
  assert.match(
    mutated.libRs,
    /pub struct EchoOutput \{\s*pub message: String,\s*pub repeat: u32,\s*\}/,
  );
  assert.match(
    mutated.libRs,
    /Ok\(EchoOutput \{ message: input\.message, repeat: input\.repeat \}\)/,
  );
  // TS 호출부도 필수 필드를 채운다 — serde 가 누락된 repeat 을 거절하기 때문이다.
  assert.match(mutated.appTs, /echo\(\{ message: 'hello from TypeScript', repeat: 3 \}\)/);
});

test('mutate refuses to re-apply over an already-mutated scaffold (anchor gone)', () => {
  const files = renderInitProjectFiles(templateVersions('0.7.0', '^0.7.0', '^0.5.0'));
  const once = mutateScaffoldSources({ libRs: files.libRs, appTs: files.appTs });
  assert.throws(
    () => mutateScaffoldSources({ libRs: once.libRs, appTs: once.appTs }),
    /anchor not found/,
  );
});

test('mutateScaffoldProject rewrites lib.rs and index.ts on disk', () => {
  const { projectDir, cleanup } = scaffoldFromTemplate();
  try {
    mutateScaffoldProject(projectDir);
    const libRs = readFileSync(join(projectDir, 'src', 'lib.rs'), 'utf8');
    const appTs = readFileSync(join(projectDir, 'src', 'index.ts'), 'utf8');
    assert.match(libRs, /pub repeat: u32/);
    assert.match(appTs, /repeat: 3/);
  } finally {
    cleanup();
  }
});

test('verify accepts generated types.ts declaring the mutated field and rejects drift', () => {
  // 통과 — regen 이 변형을 전파한 경우.
  const pass = scratchProject({
    typesTs: 'export type EchoInput = {\n  message: string;\n  repeat: number;\n};',
  });
  try {
    assert.equal(verifyRegenerated(pass.projectDir), null);
  } finally {
    pass.cleanup();
  }
  // 드리프트 — regen 을 안 했거나(구 필드만) 스키마 변경이 전파되지 않은 경우.
  const drift = scratchProject({ typesTs: 'export type EchoInput = {\n  message: string;\n};' });
  try {
    const error = verifyRegenerated(drift.projectDir);
    assert.match(error ?? '', /does not declare the mutated field/);
    assert.match(error ?? '', /repeat/);
  } finally {
    drift.cleanup();
  }
  // 생성물 자체가 없으면(regen 누락) 명시적으로 실패한다.
  const missing = scratchProject({});
  try {
    assert.match(verifyRegenerated(missing.projectDir) ?? '', /not found/);
  } finally {
    missing.cleanup();
  }
});

test('gate fails at verify when the mutation did not reach the generated surface', async () => {
  // 적대적 시나리오 — regen 이 옛 스키마를 다시 쓴 세계: verify 가 게이트를 막는다.
  const drift = scratchProject({ typesTs: 'export type EchoInput = {\n  message: string;\n};' });
  try {
    const report = await runOnboardingSteps({
      root: drift.root,
      mutate: () => {},
      runner: async () => ({ ok: true, output: '' }),
    });
    assert.equal(report.ok, false);
    assert.match(report.error ?? '', /step "verify"/);
  } finally {
    drift.cleanup();
  }
});

test('full offline cycle: real mutate + simulated regen propagates the field to verify', async () => {
  // cargo 없이 실제 fs 사이클을 검증한다 — mutate 는 진짜(fs), regen 만 runner 로
  // 시뮬레이션(진짜 codegen 이라면 변형된 lib.rs 에서 repeat 을 뽑아낸다).
  const { projectDir, cleanup } = scaffoldFromTemplate();
  const runnerLog: string[] = [];
  try {
    const report = await runOnboardingSteps({
      root: projectDir.replace(/\/onboarding-probe$/, ''),
      mutate: mutateScaffoldProject,
      runner: async (step) => {
        runnerLog.push(step);
        if (step === 'regen') {
          mkdirSync(join(projectDir, 'src', 'generated'), { recursive: true });
          writeFileSync(
            join(projectDir, 'src', 'generated', 'types.ts'),
            'export type EchoInput = {\n  message: string;\n  repeat: number;\n};\n',
          );
        }
        return { ok: true, output: '' };
      },
    });
    assert.ok(report.ok, report.error);
    // runner 기록 — patch/mutate 는 fs 동작이라 runner 로그에 없다.
    assert.deepEqual(runnerLog, RUNNER_STEPS);
    assert.match(readFileSync(join(projectDir, 'src', 'lib.rs'), 'utf8'), /pub repeat: u32/);
    assert.match(readFileSync(join(projectDir, 'src', 'index.ts'), 'utf8'), /repeat: 3/);
  } finally {
    cleanup();
  }
});

test('report records per-step timing without threshold gating', async () => {
  const { root, cleanup } = scratchProject({ typesTs: '  repeat: number;' });
  try {
    const report = await runOnboardingSteps({
      root,
      runner: async () => ({ ok: true, output: '' }),
      mutate: () => {},
    });
    assert.ok(report.ok);
    // 보고서는 발행 전 patch 우회 단계를 제외한 사용자 여정 단계만 기록한다.
    assert.deepEqual(
      report.steps.map((step) => step.name),
      ONBOARDING_STEPS.filter((step) => step.report !== false).map((step) => step.name),
    );
    for (const step of report.steps) {
      assert.equal(typeof step.durationMs, 'number');
      assert.ok(step.durationMs >= 0, `duration for ${step.name} must be measured, not negative`);
    }
  } finally {
    cleanup();
  }
});

test('failed report carries timings for every step that ran', async () => {
  const report = await runOnboardingSteps({
    root: ROOT,
    mutate: () => {},
    runner: async (step) =>
      step === 'build' ? { ok: false, output: 'rustc exploded' } : { ok: true, output: '' },
  });
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.steps.map((step) => step.name),
    ['init', 'doctor', 'build'],
  );
  for (const step of report.steps) assert.ok(step.durationMs >= 0);
});

test('gate fails at mutate when the fs mutation throws (catch branch)', async () => {
  const ran: string[] = [];
  const report = await runOnboardingSteps({
    root: ROOT,
    mutate: () => {
      throw new Error('anchor gone');
    },
    runner: async (step) => {
      ran.push(step);
      return { ok: true, output: '' };
    },
  });
  assert.equal(report.ok, false);
  assert.match(report.error ?? '', /step "mutate"/);
  assert.match(report.error ?? '', /anchor gone/);
  assert.deepEqual(
    ran,
    ['init', 'doctor', 'build', 'codegen', 'demo', 'codegen-check'],
    'steps after a throwing mutate must not run',
  );
});

test('gate fails at verify when the demo re-invocation exits non-zero', async () => {
  // 재호출 실패 — verify 의 fs 단정은 통과했지만 demo 재실행이 죽은 세계.
  const pass = scratchProject({ typesTs: '  repeat: number;' });
  try {
    const report = await runOnboardingSteps({
      root: pass.root,
      mutate: () => {},
      runner: async (step) =>
        step === 'verify'
          ? { ok: false, output: 'bun: command not found' }
          : { ok: true, output: '' },
    });
    assert.equal(report.ok, false);
    assert.match(report.error ?? '', /step "verify"/);
    assert.match(report.error ?? '', /command not found/);
  } finally {
    pass.cleanup();
  }
});

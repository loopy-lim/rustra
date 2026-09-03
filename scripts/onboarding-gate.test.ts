import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { renderInitProjectFiles, templateVersions } from '../packages/cli/src/init-template.ts';
import { runOnboardingSteps, ONBOARDING_STEPS } from './onboarding-gate.mjs';

function okRunner() {
  return async (step) => ({ step, ok: true, output: '' });
}

test('gate runs steps in order: init, doctor, cargo build, codegen, demo', async () => {
  const calls = [];
  const report = await runOnboardingSteps({
    root: '/tmp/unused',
    runner: async (step, cmd) => {
      calls.push([step, cmd]);
      return { ok: true, output: '' };
    },
  });
  assert.deepEqual(
    calls.map(([step]) => step),
    ONBOARDING_STEPS.map((step) => step.name),
  );
  assert.ok(report.ok);
});

test('gate fails when any step exits non-zero and names the failed step', async () => {
  const report = await runOnboardingSteps({
    root: '/tmp/unused',
    runner: async (step) =>
      step === 'codegen' ? { ok: false, output: 'schema not found' } : { ok: true, output: '' },
  });
  assert.equal(report.ok, false);
  assert.match(report.error ?? '', /codegen/);
  assert.match(report.error ?? '', /schema not found/);
});

test('gate aborts at the first failed step without running later steps', async () => {
  const ran = [];
  const report = await runOnboardingSteps({
    root: '/tmp/unused',
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

test('every step command runs inside the onboarding scratch project', async () => {
  const commands = [];
  await runOnboardingSteps({
    root: '/tmp/unused',
    runner: async (_step, cmd) => {
      commands.push(cmd);
      return { ok: true, output: '' };
    },
  });
  const [initCmd, ...rest] = commands;
  // init은 저장소 루트에서, 나머지는 스캐폴드 프로젝트 안에서 실행된다.
  assert.equal(initCmd.cwd, '/tmp/unused');
  assert.ok(rest.length > 0, 'post-init steps must exist');
  for (const cmd of rest) assert.equal(cmd.cwd, '/tmp/unused/onboarding-probe');
  assert.ok(okRunner);
});

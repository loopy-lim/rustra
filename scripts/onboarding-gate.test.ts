import assert from 'node:assert/strict';
import { test } from 'bun:test';
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

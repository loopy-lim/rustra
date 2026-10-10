import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  checkCriterionRegression,
  parseRegressionArgs,
  provenanceDrifts,
  renderRegressionReport,
} from './check-criterion-regression.mjs';

type TestLogger = {
  logs: string[];
  errors: string[];
  log(message: unknown): void;
  error(message: unknown): void;
};

function logger(): TestLogger {
  const output: TestLogger = {
    logs: [],
    errors: [],
    log(message) {
      output.logs.push(String(message));
    },
    error(message) {
      output.errors.push(String(message));
    },
  };
  return output;
}

/** 벤치 프로비넌스 쌍 — benchmark-environment.mjs 가 기록하는 형태의 최소 본뜩물. */
function environmentRecord(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    capturedAt: '2026-10-10T00:00:00.000Z',
    restoredEnvironmentAvailable: true,
    workflow: { GITHUB_SHA: 'deadbeef' },
    host: { platform: 'linux', architecture: 'x64', logicalCpuCount: 4 },
    tools: { rustc: 'rustc 1.95.0', cargo: 'cargo 1.95.0', bun: '1.4.1' },
    configurationDigests: { RUSTFLAGS: null },
    ...overrides,
  };
}

async function writeProvenance(
  root: string,
  { restored = environmentRecord(), current = environmentRecord() } = {},
) {
  await Bun.write(join(root, 'runner-environment.json'), JSON.stringify(current));
  await Bun.write(join(root, 'restored-runner-environment.json'), JSON.stringify(restored));
}

async function fixture(point: number, lower: number, upper: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rustra-criterion-'));
  await mkdir(join(root, 'group/case/new'), { recursive: true });
  await Bun.write(join(root, 'group/case/new/estimates.json'), '{}');
  const change = join(root, 'group', 'case', 'change');
  await mkdir(change, { recursive: true });
  await Bun.write(
    join(change, 'estimates.json'),
    JSON.stringify({
      mean: {
        point_estimate: point,
        confidence_interval: { lower_bound: lower, upper_bound: upper },
      },
    }),
  );
  await writeProvenance(root);
  return root;
}

test('parseRegressionArgs validates the budget and resolves the root', () => {
  const parsed = parseRegressionArgs([
    '--max-regression',
    '0.05',
    '--criterion-root',
    'custom/criterion',
  ]);
  assert.equal(parsed.maxRegression, 0.05);
  assert.equal(parsed.maxImprovement, 0.35);
  assert.equal(parsed.improvementShare, 0.2);
  assert.ok(parsed.criterionRoot.endsWith('custom/criterion'));
  assert.throws(() => parseRegressionArgs(['--max-regression', '-1']), /non-negative/);
  assert.throws(() => parseRegressionArgs(['--max-improvement', '-1']), /non-negative/);
  assert.throws(() => parseRegressionArgs(['--improvement-share', '1.5']), /ratio in \(0,1\)/);
});

test('missing Criterion changes fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rustra-criterion-empty-'));
  try {
    const output = logger();
    const result = await checkCriterionRegression({
      criterionRoot: root,
      maxRegression: 0.1,
      logger: output,
    });
    assert.equal(result.exitCode, 2);
    assert.match(output.errors[0], /No Criterion change estimates/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing Criterion root fails closed without a stack trace', async () => {
  const output = logger();
  const result = await checkCriterionRegression({
    criterionRoot: join(tmpdir(), `rustra-criterion-missing-${crypto.randomUUID()}`),
    maxRegression: 0.1,
    logger: output,
  });
  assert.equal(result.exitCode, 2);
  assert.match(output.errors[0], /No Criterion change estimates/);
});

test('a regression below budget passes', async () => {
  const root = await fixture(0.05, 0.02, 0.08);
  try {
    const result = await checkCriterionRegression({
      criterionRoot: root,
      maxRegression: 0.1,
      logger: logger(),
    });
    assert.equal(result.exitCode, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an uncertain slowdown does not fail the statistical gate', async () => {
  const root = await fixture(0.15, -0.01, 0.3);
  try {
    const result = await checkCriterionRegression({
      criterionRoot: root,
      maxRegression: 0.1,
      logger: logger(),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.rows[0]?.statisticallySlower, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a statistically significant slowdown over budget fails', async () => {
  const root = await fixture(0.15, 0.11, 0.2);
  try {
    const result = await checkCriterionRegression({
      criterionRoot: root,
      maxRegression: 0.1,
      maxImprovement: 0.35,
      improvementShare: 0.2,
      logger: logger(),
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.rows[0]?.statisticallySlower, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a comparison without baseline-era provenance is unmeasurable, not a pass', async () => {
  const root = await fixture(0.05, 0.02, 0.08);
  try {
    await rm(join(root, 'restored-runner-environment.json'));
    const output = logger();
    const result = await checkCriterionRegression({
      criterionRoot: root,
      maxRegression: 0.1,
      logger: output,
    });
    // 판정 보류(exit 2) — 출처 불명 기준선과의 상대 비교를 통과로 판정하지 않는다.
    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.rows, []);
    assert.match(output.errors[0], /provenance is incomplete/);
    assert.match(output.errors[0], /restored-runner-environment\.json/);
    assert.match(output.errors[0], /unmeasurable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a comparison without the current-era record is unmeasurable too', async () => {
  const root = await fixture(0.05, 0.02, 0.08);
  try {
    await rm(join(root, 'runner-environment.json'));
    const output = logger();
    const result = await checkCriterionRegression({
      criterionRoot: root,
      maxRegression: 0.1,
      logger: output,
    });
    assert.equal(result.exitCode, 2);
    assert.match(output.errors[0], /runner-environment\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a corrupted provenance record is treated as unknown provenance', async () => {
  const root = await fixture(0.05, 0.02, 0.08);
  try {
    await Bun.write(join(root, 'restored-runner-environment.json'), '{broken');
    const output = logger();
    const result = await checkCriterionRegression({
      criterionRoot: root,
      maxRegression: 0.1,
      logger: output,
    });
    assert.equal(result.exitCode, 2);
    assert.match(output.errors[0], /provenance is incomplete/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a toolchain drift between eras is advisory and reported, not a refusal', async () => {
  const root = await fixture(0.05, 0.02, 0.08);
  try {
    await writeProvenance(root, {
      restored: environmentRecord({
        tools: { rustc: 'rustc 1.94.0', cargo: 'cargo 1.94.0', bun: '1.4.1' },
      }),
    });
    const output = logger();
    const result = await checkCriterionRegression({
      criterionRoot: root,
      maxRegression: 0.1,
      logger: output,
    });
    // 자문 판정 — ImageVersion 패치 같은 흔한 드리프트까지 거부하면 게이트가
    // 인프라 이유로 상시 실패한다. 드리프트 사실만 리포트에 남긴다.
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.provenanceDrifts, ['tools']);
    assert.match(output.logs[0], /WARN provenance drift in "tools"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('provenanceDrifts compares only the stable sections', () => {
  const current = environmentRecord({ workflow: { GITHUB_SHA: 'aaa' }, capturedAt: 'a' });
  const restored = environmentRecord({ workflow: { GITHUB_SHA: 'bbb' }, capturedAt: 'b' });
  // workflow/capturedAt 은 매 실행 변하는 값 — 어긋나도 드리프트가 아니다.
  assert.deepEqual(provenanceDrifts(current, restored), []);
  assert.deepEqual(provenanceDrifts(current, environmentRecord({ host: {} })), ['host']);
  assert.deepEqual(
    provenanceDrifts(current, environmentRecord({ configurationDigests: { RUSTFLAGS: 'x' } })),
    ['configurationDigests'],
  );
});

test('regression amid widespread implausible improvement flags baseline mismatch', async () => {
  // 2026-08-29 실측 사고 재현: baseline(runner A, 느림) vs 현재(runner B, 빠름)
  // — 대다수 벤치가 -40%대 '개선'을 보이는 가운데 일부가 +70%대 '회귀'.
  const root = await mkdtemp(join(tmpdir(), 'rustra-criterion-mixed-'));
  try {
    for (const [name, point] of [
      ['groupA/case1', -0.44],
      ['groupA/case2', -0.45],
      ['groupA/case3', -0.71],
      ['groupB/case1', -0.33],
      ['groupB/case2', 0.71],
    ] as const) {
      await mkdir(join(root, name, 'new'), { recursive: true });
      await Bun.write(join(root, name, 'new/estimates.json'), '{}');
      const change = join(root, name, 'change');
      await mkdir(change, { recursive: true });
      // lower/upper 부호: point가 음수면 CI 전체가 음수(통계적 유의한 개선),
      // 양수면 전체 양수(유의한 회귀).
      await Bun.write(
        join(change, 'estimates.json'),
        JSON.stringify({
          mean: {
            point_estimate: point,
            confidence_interval: {
              lower_bound: point - 0.02,
              upper_bound: point + 0.02,
            },
          },
        }),
      );
    }
    const output = logger();
    await writeProvenance(root);
    const result = await checkCriterionRegression({
      criterionRoot: root,
      maxRegression: 0.1,
      maxImprovement: 0.35,
      improvementShare: 0.2,
      logger: output,
    });
    assert.equal(result.exitCode, 3);
    assert.match(output.errors[0], /Mixed performance changes/);
    assert.doesNotMatch(output.errors[0], /re-run with bootstrap_baseline=true/);
    assert.match(output.errors[0], /same environment/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a lone regression with normal improvements stays a genuine failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rustra-criterion-lone-'));
  try {
    for (const [name, point] of [
      ['groupA/case1', -0.1],
      ['groupA/case2', 0.2],
    ] as const) {
      await mkdir(join(root, name, 'new'), { recursive: true });
      await Bun.write(join(root, name, 'new/estimates.json'), '{}');
      const change = join(root, name, 'change');
      await mkdir(change, { recursive: true });
      await Bun.write(
        join(change, 'estimates.json'),
        JSON.stringify({
          mean: {
            point_estimate: point,
            confidence_interval: {
              lower_bound: point - 0.02,
              upper_bound: point + 0.02,
            },
          },
        }),
      );
    }
    const output = logger();
    await writeProvenance(root);
    const result = await checkCriterionRegression({
      criterionRoot: root,
      maxRegression: 0.1,
      maxImprovement: 0.35,
      improvementShare: 0.2,
      logger: output,
    });
    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(output.errors[0], /mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('renderRegressionReport renders verdict badges per exit code', () => {
  const rows = [
    {
      name: 'g/fast',
      point: -0.44,
      lower: -0.46,
      upper: -0.42,
      statisticallySlower: false,
      statisticallyFaster: true,
    },
    {
      name: 'g/slow',
      point: 0.15,
      lower: 0.11,
      upper: 0.2,
      statisticallySlower: true,
      statisticallyFaster: false,
    },
  ];
  assert.match(
    renderRegressionReport({ exitCode: 1, rows }, { thresholdPercent: 10 }),
    /❌ \*\*회귀 감지\*\*/u,
  );
  assert.match(renderRegressionReport({ exitCode: 0, rows }), /✅ \*\*통과\*\*/u);
  assert.match(renderRegressionReport({ exitCode: 3, rows }), /⚠️ \*\*혼합 성능 변화\*\*/u);
  assert.match(renderRegressionReport({ exitCode: 2, rows: [] }), /⚠️ \*\*비교 불가\*\*/u);

  const report = renderRegressionReport({ exitCode: 1, rows }, { thresholdPercent: 10 });
  assert.match(report, /`g\/slow` \| 15\.00% \| 11\.00% \.\. 20\.00% \| ❌ 회귀/u);
  assert.match(report, /`g\/fast` \| -44\.00% \| -46\.00% \.\. -42\.00% \| ⚠️ 개선 이상/u);
  assert.doesNotMatch(report, /provenance drift/u);

  const drifted = renderRegressionReport(
    { exitCode: 0, rows: [], provenanceDrifts: ['host', 'tools'] },
    { thresholdPercent: 10 },
  );
  assert.match(drifted, /provenance drift: host, tools/u);
});

test('an inconclusive comparison never claims a new baseline was accepted', () => {
  const report = renderRegressionReport({ exitCode: 3, rows: [] });
  assert.doesNotMatch(report, /채택했습니다/);
  assert.match(report, /미채택|not adopted/);
});

test('malformed numeric estimates cannot become a successful zero-percent change', async () => {
  const root = await fixture(0.5, 0.4, 0.6);
  try {
    for (const [point, lower, upper] of [
      [null, -0.05, 0.05],
      [0.5, null, 0.6],
      [0.5, 0.4, null],
      ['0.0', -0.05, 0.05],
      [false, -0.05, 0.05],
      [0.5, 0.6, 0.4],
    ]) {
      await Bun.write(
        join(root, 'group/case/change/estimates.json'),
        JSON.stringify({
          mean: {
            point_estimate: point,
            confidence_interval: { lower_bound: lower, upper_bound: upper },
          },
        }),
      );
      await assert.rejects(
        checkCriterionRegression({
          criterionRoot: root,
          maxRegression: 0.1,
          logger: logger(),
        }),
        /Malformed Criterion estimate/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reports use the configured CLI budget including fractional percentages', () => {
  for (const [ratio, percent] of [
    ['0.2', '20'],
    ['0.005', '0.5'],
  ]) {
    const options = parseRegressionArgs(['--max-regression', ratio]);
    for (const exitCode of [0, 1]) {
      assert.ok(renderRegressionReport({ exitCode, rows: [] }, options).includes(`${percent}%`));
    }
  }
});

test('a malformed CLI input replaces an old successful report with the failure', async () => {
  const root = await fixture(0.5, 0.4, 0.6);
  try {
    await Bun.write(join(root, 'group/case/change/estimates.json'), '{broken json');
    const report = join(root, 'report.md');
    await Bun.write(report, '✅ **통과** — previous run');
    const result = Bun.spawnSync([
      process.execPath,
      fileURLToPath(new URL('./check-criterion-regression.mjs', import.meta.url)),
      '--criterion-root',
      root,
      '--report',
      report,
    ]);
    assert.equal(result.exitCode, 2);
    const content = await Bun.file(report).text();
    assert.match(content, /비교 불가/);
    assert.doesNotMatch(content, /previous run|✅ \*\*통과/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fresh measurements without a matching change estimate fail closed', async () => {
  const root = await fixture(0.01, -0.01, 0.02);
  try {
    await mkdir(join(root, 'new-route/new'), { recursive: true });
    await Bun.write(join(root, 'new-route/new/estimates.json'), '{}');
    const result = await checkCriterionRegression({
      criterionRoot: root,
      maxRegression: 0.1,
      logger: logger(),
    });
    assert.equal(result.exitCode, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preparation removes restored measurements while retaining comparison baselines', async () => {
  const { prepareCriterionRun } = await import('./check-criterion-regression.mjs');
  const root = await mkdtemp(join(tmpdir(), 'rustra-criterion-prepare-'));
  try {
    for (const phase of ['base', 'new', 'change']) {
      await mkdir(join(root, 'retired-route', phase), { recursive: true });
      await Bun.write(join(root, 'retired-route', phase, 'estimates.json'), '{}');
    }
    await prepareCriterionRun(root);
    assert.equal(await Bun.file(join(root, 'retired-route/base/estimates.json')).exists(), true);
    assert.equal(await Bun.file(join(root, 'retired-route/new/estimates.json')).exists(), false);
    assert.equal(await Bun.file(join(root, 'retired-route/change/estimates.json')).exists(), false);
    assert.equal(
      (
        await checkCriterionRegression({
          criterionRoot: root,
          maxRegression: 0.1,
          logger: logger(),
        })
      ).exitCode,
      2,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  checkCriterionRegression,
  parseRegressionArgs,
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

async function fixture(point: number, lower: number, upper: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rustra-criterion-'));
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
    const result = await checkCriterionRegression({
      criterionRoot: root,
      maxRegression: 0.1,
      maxImprovement: 0.35,
      improvementShare: 0.2,
      logger: output,
    });
    assert.equal(result.exitCode, 3);
    assert.match(output.errors[0], /Baseline environment mismatch/);
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
  assert.match(renderRegressionReport({ exitCode: 3, rows }), /⚠️ \*\*baseline 환경 불일치\*\*/u);
  assert.match(renderRegressionReport({ exitCode: 2, rows: [] }), /⚠️ \*\*baseline 없음\*\*/u);

  const report = renderRegressionReport({ exitCode: 1, rows }, { thresholdPercent: 10 });
  assert.match(report, /`g\/slow` \| 15\.00% \| 11\.00% \.\. 20\.00% \| ❌ 회귀/u);
  assert.match(report, /`g\/fast` \| -44\.00% \| -46\.00% \.\. -42\.00% \| ⚠️ 개선 이상/u);
});

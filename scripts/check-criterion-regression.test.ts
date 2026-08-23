import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkCriterionRegression, parseRegressionArgs } from './check-criterion-regression.mjs';

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
  assert.ok(parsed.criterionRoot.endsWith('custom/criterion'));
  assert.throws(() => parseRegressionArgs(['--max-regression', '-1']), /non-negative/);
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
      logger: logger(),
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.rows[0]?.statisticallySlower, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

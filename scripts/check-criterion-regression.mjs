#!/usr/bin/env bun

import { resolve, relative, dirname } from 'node:path';
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export function parseRegressionArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index]?.startsWith('--')) {
      args.set(argv[index], argv[index + 1]);
    }
  }

  const maxRegression = Number(args.get('--max-regression') ?? '0.10');
  if (!Number.isFinite(maxRegression) || maxRegression < 0) {
    throw new Error('--max-regression must be a non-negative ratio (0.10 = 10%)');
  }

  // 큰 개선과 회귀가 섞이면 환경 차이와 실제 회귀를 수치만으로 구분할 수 없다.
  // 결과를 미채택하고 같은 환경에서의 비교를 요구한다. 원래 baseline은 보존한다.
  const maxImprovement = Number(args.get('--max-improvement') ?? '0.35');
  if (!Number.isFinite(maxImprovement) || maxImprovement < 0) {
    throw new Error('--max-improvement must be a non-negative ratio (0.35 = 35%)');
  }
  // 회귀와 함께 나타난 큰 개선의 비율로 혼합 결과를 감지한다.
  const improvementShare = Number(args.get('--improvement-share') ?? '0.2');
  if (!Number.isFinite(improvementShare) || improvementShare <= 0 || improvementShare >= 1) {
    throw new Error('--improvement-share must be a ratio in (0,1) (0.2 = 20%)');
  }

  return {
    prepare: argv.includes('--prepare'),
    maxRegression,
    maxImprovement,
    improvementShare,
    criterionRoot: resolve(args.get('--criterion-root') ?? 'target/criterion'),
    report: args.get('--report'),
  };
}

/** Keep only historical base data; old new/change files are not fresh evidence. */
export async function prepareCriterionRun(criterionRoot) {
  if (!existsSync(criterionRoot)) return;
  for await (const path of new Bun.Glob('**/{new,change}/estimates.json').scan({
    cwd: criterionRoot,
    absolute: true,
    followSymlinks: false,
  })) {
    await rm(dirname(path), { recursive: true, force: true });
  }
}

export async function checkCriterionRegression({
  criterionRoot,
  maxRegression,
  maxImprovement,
  improvementShare,
  logger = console,
}) {
  const files = [];
  if (existsSync(criterionRoot)) {
    for await (const path of new Bun.Glob('**/change/estimates.json').scan({
      cwd: criterionRoot,
      absolute: true,
    })) {
      files.push(path);
    }
  }

  if (files.length === 0) {
    logger.error(
      'No Criterion change estimates found. Restore a previous target/criterion baseline or run the explicit bootstrap workflow.',
    );
    return { exitCode: 2, rows: [] };
  }

  const measured = [];
  for await (const path of new Bun.Glob('**/new/estimates.json').scan({
    cwd: criterionRoot,
    absolute: true,
  })) {
    measured.push(path.replace(/[/\\]new[/\\]estimates\.json$/, ''));
  }
  const changes = new Set(
    files.map((path) => path.replace(/[/\\]change[/\\]estimates\.json$/, '')),
  );
  const missing = measured.filter((path) => !changes.has(path));
  if (measured.length === 0 || missing.length > 0 || measured.length !== changes.size) {
    logger.error(
      `Incomplete Criterion comparison: ${measured.length} fresh measurements, ${changes.size} changes; ` +
        `missing comparisons: ${missing.map((path) => relative(criterionRoot, path)).join(', ') || '(stale or absent measurements)'}. ` +
        'Prepare the run first; new routes require an explicit bootstrap baseline.',
    );
    return { exitCode: 2, rows: [] };
  }

  const regressions = [];
  const rows = [];
  for (const file of files.sort()) {
    const estimate = await Bun.file(file).json();
    const mean = estimate?.mean;
    const point = mean?.point_estimate;
    const lower = mean?.confidence_interval?.lower_bound;
    const upper = mean?.confidence_interval?.upper_bound;
    if (![point, lower, upper].every(Number.isFinite) || lower > upper) {
      throw new Error(`Malformed Criterion estimate: ${file}`);
    }
    const name = relative(criterionRoot, file).replace('/change/estimates.json', '');
    const statisticallySlower = point > maxRegression && lower > 0;
    // 개선 방향 이상도 추적한다 — 전체가 비정상적으로 빠르면 baseline 이
    // 다른 runner 시대에서 왔다는 신호(아래 fail-closed 판정에 쓴다).
    const statisticallyFaster = point < -maxImprovement && upper < 0;
    rows.push({ name, point, lower, upper, statisticallySlower, statisticallyFaster });
    if (statisticallySlower) regressions.push(name);
  }

  for (const row of rows) {
    const mark = row.statisticallySlower ? 'FAIL' : row.statisticallyFaster ? 'WARN' : 'PASS';
    logger.log(
      `${mark} ${row.name}: mean ${(row.point * 100).toFixed(2)}% ` +
        `(95% CI ${(row.lower * 100).toFixed(2)}%..${(row.upper * 100).toFixed(2)}%)`,
    );
  }

  // runner 시대 불일치 방어 — 회귀가 관측됐고, 동시에 벤치의 상당수가
  // 비정상 개선을 보이면 환경 차이를 의심할 수 있지만 코드 회귀와 구분할 근거는 부족하다.
  // 원인 확정이나 baseline 교체 대신 같은 환경의 재측정을 요구한다.
  const fasterCount = rows.filter((row) => row.statisticallyFaster).length;
  const mixedPerformanceChanges =
    regressions.length > 0 && fasterCount / rows.length >= improvementShare;
  if (mixedPerformanceChanges) {
    logger.error(
      `Mixed performance changes: ${regressions.length} regression(s) alongside ` +
        `${fasterCount}/${rows.length} implausibly large improvements (>= ${(maxImprovement * 100).toFixed(0)}%). ` +
        `Timing changes alone cannot identify the cause. Compare both revisions in the same environment; ` +
        `preserve the accepted baseline until the cause is resolved.`,
    );
    return { exitCode: 3, rows };
  }

  if (regressions.length > 0) {
    logger.error(
      `Performance regression gate failed: ${regressions.length} benchmark(s) exceed ${(maxRegression * 100).toFixed(1)}%.`,
    );
    return { exitCode: 1, rows };
  }

  logger.log(`Performance regression gate passed (${rows.length} benchmark estimates).`);
  return { exitCode: 0, rows };
}

// GitHub 자동 댓글용 마크다운 리포트 — 게이트가 이미 계산한 rows 를
// 재파싱하지 않고 그대로 렌더링한다.
export function renderRegressionReport(result, { thresholdPercent, maxRegression = 0.1 } = {}) {
  const budgetPercent = Number((thresholdPercent ?? maxRegression * 100).toPrecision(12));
  const badge =
    result.exitCode === 3
      ? '⚠️ **혼합 성능 변화** — 원인 미확정, 새 baseline 미채택. 기존 기준선을 보존하고 같은 환경에서 재측정하세요.'
      : result.exitCode === 1
        ? `❌ **회귀 감지** — 예산 ${budgetPercent}% 초과`
        : result.exitCode === 2
          ? '⚠️ **비교 불가** — 입력·기준선 확인 필요, 새 baseline 미채택'
          : `✅ **통과** — ${budgetPercent}% 회귀 예산 이내`;

  const lines = [badge, '', '| Benchmark | mean | 95% CI | 판정 |', '| --- | --- | --- | --- |'];
  for (const row of result.rows) {
    const mark = row.statisticallySlower
      ? '❌ 회귀'
      : row.statisticallyFaster
        ? '⚠️ 개선 이상'
        : '✅';
    lines.push(
      `| \`${row.name}\` | ${(row.point * 100).toFixed(2)}% ` +
        `| ${(row.lower * 100).toFixed(2)}% .. ${(row.upper * 100).toFixed(2)}% | ${mark} |`,
    );
  }
  if (result.rows.length === 0) {
    lines.push('| — | — | — | 판정 대상 없음 |');
  }
  if (result.error) lines.push('', `Error: ${result.error}`);
  lines.push('', '<sub>Generated by scripts/check-criterion-regression.mjs</sub>');
  return lines.join('\n');
}

if (import.meta.main) {
  const options = parseRegressionArgs(process.argv.slice(2));
  if (options.prepare) {
    await prepareCriterionRun(options.criterionRoot);
    process.exit(0);
  }
  let result;
  try {
    result = await checkCriterionRegression(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    result = { exitCode: 2, rows: [], error: message };
  }
  if (options.report) {
    await Bun.write(options.report, renderRegressionReport(result, options));
  }
  process.exitCode = result.exitCode;
}

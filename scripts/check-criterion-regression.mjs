#!/usr/bin/env bun

import { resolve, relative } from 'node:path';
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

  // runner-to-runner 성능 변동 방어: baseline 보다 비정상적으로 빠르게 측정되면
  // 이 baseline 자체가 서로 다른 runner 시대에서 온 것 — 그 baseline 으로는
  // 회귀 판정 자체가 무의미하다. 개선 쪽 진폭이 maxRegression 을 넘는 벤치가
  // 일정 비율을 넘으면 전체 판정을 fail-closed 로 돌린다(이 baseline 폐기).
  const maxImprovement = Number(args.get('--max-improvement') ?? '0.35');
  if (!Number.isFinite(maxImprovement) || maxImprovement < 0) {
    throw new Error('--max-improvement must be a non-negative ratio (0.35 = 35%)');
  }
  // 개선 이상 벤치가 이 비율을 넘으면 runner 시대 불일치로 본다.
  const improvementShare = Number(args.get('--improvement-share') ?? '0.2');
  if (!Number.isFinite(improvementShare) || improvementShare <= 0 || improvementShare >= 1) {
    throw new Error('--improvement-share must be a ratio in (0,1) (0.2 = 20%)');
  }

  return {
    maxRegression,
    maxImprovement,
    improvementShare,
    criterionRoot: resolve(args.get('--criterion-root') ?? 'target/criterion'),
    report: args.get('--report'),
  };
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

  const regressions = [];
  const rows = [];
  for (const file of files.sort()) {
    const estimate = await Bun.file(file).json();
    const mean = estimate?.mean;
    const point = Number(mean?.point_estimate);
    const lower = Number(mean?.confidence_interval?.lower_bound);
    const upper = Number(mean?.confidence_interval?.upper_bound);
    if (![point, lower, upper].every(Number.isFinite)) {
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
  // 비정상 개선을 보이면 이 diff 는 코드가 아니라 측정 환경의 문제다.
  // baseline 이 오염된 것으로 간주하고 재측정(baseline 미채택)을 요구한다.
  const fasterCount = rows.filter((row) => row.statisticallyFaster).length;
  const environmentMismatch =
    regressions.length > 0 && fasterCount / rows.length >= improvementShare;
  if (environmentMismatch) {
    logger.error(
      `Baseline environment mismatch: ${regressions.length} regression(s) alongside ` +
        `${fasterCount}/${rows.length} implausibly large improvements (>= ${(maxImprovement * 100).toFixed(0)}%). ` +
        `The restored baseline likely came from a different runner generation — ` +
        `re-run with bootstrap_baseline=true to rebuild it.`,
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
export function renderRegressionReport(result, { thresholdPercent } = {}) {
  const badge =
    result.exitCode === 3
      ? '⚠️ **baseline 환경 불일치** — 이번 결과를 새 baseline 으로 채택했습니다.'
      : result.exitCode === 1
        ? `❌ **회귀 감지** — 예산 ${(thresholdPercent ?? 10).toFixed(0)}% 초과`
        : result.exitCode === 2
          ? '⚠️ **baseline 없음** — 비교 대상이 부족해 판정 생략'
          : `✅ **통과** — ${(thresholdPercent ?? 10).toFixed(0)}% 회귀 예산 이내`;

  const lines = [badge, '', '| Benchmark | mean | 95% CI | 판정 |', '| --- | --- | --- | --- |'];
  for (const row of result.rows) {
    const mark = row.statisticallySlower ? '❌ 회귀' : row.statisticallyFaster ? '⚠️ 개선 이상' : '✅';
    lines.push(
      `| \`${row.name}\` | ${(row.point * 100).toFixed(2)}% ` +
        `| ${(row.lower * 100).toFixed(2)}% .. ${(row.upper * 100).toFixed(2)}% | ${mark} |`,
    );
  }
  if (result.rows.length === 0) {
    lines.push('| — | — | — | 판정 대상 없음 |');
  }
  lines.push('', '<sub>Generated by scripts/check-criterion-regression.mjs</sub>');
  return lines.join('\n');
}

if (import.meta.main) {
  const options = parseRegressionArgs(process.argv.slice(2));
  const result = await checkCriterionRegression(options);
  if (options.report) {
    await Bun.write(options.report, renderRegressionReport(result, options));
  }
  process.exitCode = result.exitCode;
}

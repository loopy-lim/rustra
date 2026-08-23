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

  return {
    maxRegression,
    criterionRoot: resolve(args.get('--criterion-root') ?? 'target/criterion'),
  };
}

export async function checkCriterionRegression({
  criterionRoot,
  maxRegression,
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
    rows.push({ name, point, lower, upper, statisticallySlower });
    if (statisticallySlower) regressions.push(name);
  }

  for (const row of rows) {
    const mark = row.statisticallySlower ? 'FAIL' : 'PASS';
    logger.log(
      `${mark} ${row.name}: mean ${(row.point * 100).toFixed(2)}% ` +
        `(95% CI ${(row.lower * 100).toFixed(2)}%..${(row.upper * 100).toFixed(2)}%)`,
    );
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

if (import.meta.main) {
  const options = parseRegressionArgs(process.argv.slice(2));
  const result = await checkCriterionRegression(options);
  process.exitCode = result.exitCode;
}

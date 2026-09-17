#!/usr/bin/env bun
/** Analyze archived samples only. Never launch a device or change acceptance rules. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import {
  aggregate,
  type Receipt,
  type ExperimentManifest,
} from '../examples/react-native-calculator/src/nitro-parity/receipt';
import {
  confidence,
  summary,
} from '../examples/react-native-calculator/src/nitro-parity/measurement';

type Archive = Record<
  'ios' | 'android',
  {
    runs: Receipt[];
    experiment: ExperimentManifest;
    results: ReturnType<typeof aggregate>;
  }
> & { source: { fingerprint: { fingerprint: string } } };
const frameworks = ['rustra', 'nitro'] as const;

const input = 'docs/benchmark-receipts/2026-09-16-nitro-parity-candidate.json';
const baselinePath = 'docs/benchmark-receipts/2026-09-16-nitro-parity-baseline.json';
const bytes = await readFile(input);
const receipt = JSON.parse(bytes.toString()) as Archive;
const baselineBytes = await readFile(baselinePath);
const baseline = JSON.parse(baselineBytes.toString()) as Archive;
const accepted = new Set(['superior', 'equivalent', 'at-least-equivalent']);
const platforms = ['ios', 'android'] as const;
const lanes = ['sync-public', 'async-public', 'sync-internal-diagnostic'] as const;
const getCase = (run: Receipt, lane: string, id: string) => {
  const found = run.cases.find((c) => c.lane === lane && c.id === id);
  assert(found, `${lane}/${id}`);
  return found;
};
const gaps = [];
const tails = [];
const summaries = [];
const controls = [];
const historical = [];
let currentAggregateRows = 0;
let baselineAggregateRows = 0;
for (const platform of platforms) {
  const data = receipt[platform];
  const results = aggregate(data.runs, data.experiment);
  assert.deepEqual(results, data.results, `${platform} archived aggregates changed`);
  assert.equal(results.length, 90);
  currentAggregateRows += results.length;
  const oldResults = aggregate(baseline[platform].runs, baseline[platform].experiment);
  assert.deepEqual(
    oldResults,
    baseline[platform].results,
    `${platform} baseline aggregates changed`,
  );
  baselineAggregateRows += oldResults.length;
  for (const lane of lanes) {
    const rows = results.filter((r) => r.lane === lane);
    const counts = Object.fromEntries(
      ['superior', 'equivalent', 'at-least-equivalent', 'slower', 'inconclusive'].map((s) => [
        s,
        rows.filter((r) => r.classification === s).length,
      ]),
    );
    summaries.push({
      platform,
      lane,
      total: rows.length,
      accepted: rows.filter((r) => accepted.has(r.classification)).length,
      counts,
    });
  }
  for (const r of results) {
    if (!accepted.has(r.classification))
      gaps.push({
        platform,
        lane: r.lane,
        id: r.id,
        nodes: r.nodes,
        classification: r.classification,
        ratio: r.confidence95,
        medianGapNs: r.rustra.p50 - r.nitro.p50,
        rustra: r.rustra,
        nitro: r.nitro,
        pointEstimateReductionTo105Percent: Math.max(0, 100 * (1 - 1.05 / r.confidence95.estimate)),
        upperBoundReductionTo105Percent: Math.max(0, 100 * (1 - 1.05 / r.confidence95.upper)),
      });
    if (r.id.startsWith('buffer')) {
      const samples = data.runs.flatMap((run, launch) => {
        const c = getCase(run, r.lane, r.id);
        return c.rustra.flatMap((_: number, round: number) =>
          frameworks.map((framework) => ({
            launch: launch + 1,
            round,
            framework,
            nsPerOperationBatchMean: c[framework][round],
            firstFramework: round % 2 === 0 ? 'rustra' : 'nitro',
            batch: c.batch,
          })),
        );
      });
      for (const framework of frameworks) {
        const own = samples.filter((s) => s.framework === framework);
        const values = own.map((s) => s.nsPerOperationBatchMean);
        const s = summary(values);
        const descending = [...own].sort(
          (a, b) => b.nsPerOperationBatchMean - a.nsPerOperationBatchMean,
        );
        const total = values.reduce((a, b) => a + b, 0);
        tails.push({
          platform,
          lane: r.lane,
          id: r.id,
          framework,
          count: own.length,
          ...s,
          max: descending[0],
          top5: descending.slice(0, 5),
          top5SharePercent:
            (100 * descending.slice(0, 5).reduce((a, b) => a + b.nsPerOperationBatchMean, 0)) /
            total,
          above5xMedianCount: values.filter((v) => v > 5 * s.p50).length,
          byOrder: Object.fromEntries(
            ['first', 'second'].map((order) => {
              const selected = own
                .filter((x) => (x.firstFramework === framework) === (order === 'first'))
                .map((x) => x.nsPerOperationBatchMean);
              return [order, { count: selected.length, ...summary(selected) }];
            }),
          ),
          perLaunch: data.runs.map((run, launch) => {
            const values = getCase(run, r.lane, r.id)[framework];
            return {
              launch: launch + 1,
              ...summary(values),
              byOrder: Object.fromEntries(
                ['first', 'second'].map((order) => {
                  const selected = values.filter(
                    (_, round) =>
                      ((round % 2 === 0 ? 'rustra' : 'nitro') === framework) ===
                      (order === 'first'),
                  );
                  return [order, { count: selected.length, ...summary(selected) }];
                }),
              ),
            };
          }),
        });
      }
    }
  }
  for (const id of results.filter((r) => r.lane === 'sync-public').map((r) => r.id)) {
    const ratios = data.runs.map(
      (run) =>
        summary(getCase(run, 'sync-public', id).nitro).mean /
        summary(getCase(run, 'sync-internal-diagnostic', id).nitro).mean,
    );
    controls.push({
      platform,
      id,
      ratios,
      confidence95: confidence(ratios),
      interpretation:
        'Same Nitro method measured in two sequential lane phases; exploratory phase association, not Rustra guard overhead or a causal order test.',
    });
  }
  for (const old of oldResults.filter((r) => r.lane === 'async-public')) {
    const current = results.find((r) => r.lane === old.lane && r.id === old.id)!;
    historical.push({
      platform,
      id: old.id,
      rustraP50ChangePercent: 100 * (current.rustra.p50 / old.rustra.p50 - 1),
      nitroP50ChangePercent: 100 * (current.nitro.p50 / old.nitro.p50 - 1),
      oldWithinLaunchRatio: old.confidence95.estimate,
      currentWithinLaunchRatio: current.confidence95.estimate,
      ratioOfEstimates: current.confidence95.estimate / old.confidence95.estimate,
      independentCohorts: true,
      newConfidenceIntervalClaimed: false,
      bufferBaselineAccountingUnequal: old.id.startsWith('buffer'),
    });
  }
}
const result = {
  schemaVersion: 1,
  status: 'analysis-of-existing-measurements',
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  baseline: {
    path: baselinePath,
    sha256: createHash('sha256').update(baselineBytes).digest('hex'),
  },
  input,
  inputSha256: createHash('sha256').update(bytes).digest('hex'),
  measuredFingerprint: receipt.source.fingerprint.fingerprint,
  methodology: {
    validatedAggregateRows: { current: currentAggregateRows, baseline: baselineAggregateRows },
    freshDeviceRuns: 0,
    sampledCasesExcluded: 0,
    acceptanceRulesChanged: false,
    sampleUnit: 'ns per operation averaged inside one timed batch; not individual call latency',
    upperBoundMargin:
      'Hypothetical proportional reduction needed to move existing ratio CI upper bound to 1.05 with unchanged log variance. A planning margin, not an estimated optimization gain or guarantee of future acceptance.',
    tails:
      'Top five samples and >5x own pooled median counts are descriptive only; all samples remain in official means/CIs.',
    order:
      'The frozen runner alternates framework order by round. Fixed lane sequence, preflight and shared heap confound causal order/GC attribution.',
    historical:
      'Different five-launch cohorts and v1/v2 lane matrices; descriptive changes only. No new paired CI between old and current runs.',
  },
  summary: summaries,
  remaining: gaps,
  bufferTails: tails,
  nitroLaneControls: controls,
  historicalContext: historical,
};
await writeFile(
  'docs/benchmark-receipts/2026-09-16-nitro-parity-gap-analysis.json',
  JSON.stringify(result, null, 2) + '\n',
);
const publicGaps = gaps.filter((g) => g.lane !== 'sync-internal-diagnostic');
console.log(
  JSON.stringify(
    { summaries, publicGaps: publicGaps.length, diagnosticGaps: gaps.length - publicGaps.length },
    null,
    2,
  ),
);
for (const x of tails.filter(
  (x) =>
    x.platform === 'android' &&
    x.lane === 'sync-public' &&
    ['buffer65536', 'buffer1048571'].includes(x.id),
)) {
  console.log(
    JSON.stringify({
      id: x.id,
      framework: x.framework,
      p50: x.p50,
      p95: x.p95,
      mean: x.mean,
      top5SharePercent: x.top5SharePercent,
      above5xMedianCount: x.above5xMedianCount,
      max: x.max,
      byOrder: x.byOrder,
      perLaunch: x.perLaunch,
    }),
  );
}
const unmet = gaps.filter((g) => g.lane === 'sync-public');
console.log(
  `Public sync: ${unmet.length}/60 cases unproven or slower; target ${unmet.length ? 'unmet' : 'met'} in archived data. No new native measurements.`,
);
console.log(`All public lanes: ${publicGaps.length}/120 cases unproven or slower.`);
if (process.argv.includes('--require-public-parity') && publicGaps.length) process.exitCode = 1;

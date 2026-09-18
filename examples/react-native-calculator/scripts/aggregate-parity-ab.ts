#!/usr/bin/env bun
/** Aggregate the interleaved A/B receipts and compare candidate vs legacy per case. */
import { readFileSync, writeFileSync } from 'node:fs';
import { aggregate, type Receipt } from '../src/nitro-parity/receipt';
import { createExperimentManifest } from './parity-manifest';
import { computeBuildFingerprint } from './generate-build-fingerprint.mjs';

const RUNS = '/tmp/parity-ab';
const C_RUNS = [1, 4, 5, 8, 10];
const L_RUNS = [2, 3, 6, 7, 9];

function loadArm(runs: number[]): Receipt[] {
  return runs.map((n) => {
    const wrapper = JSON.parse(readFileSync(`${RUNS}/run-${n}/receipt.json`, 'utf8'));
    return wrapper.receipt as Receipt;
  });
}

// aggregate() validates each receipt against the manifest fingerprint of the LIVE
// tree — toggle the generated hpp per arm exactly like the protocol did.
async function manifestFor(arm: 'C' | 'L') {
  const hpp = 'modules/rustra-jsi/generated/rustra-generated-codecs.hpp';
  const define = '#define RUSTRA_GENERATED_BOUND_CODEC_CONTEXT 1\n';
  const patched = '// legacy A/B arm: per-call by-id name ownership\n';
  const original = readFileSync(hpp, 'utf8');
  const want = arm === 'L' ? original.replace(define, patched) : original;
  writeFileSync(hpp, want);
  const manifest = createExperimentManifest((await computeBuildFingerprint()).fingerprint);
  return { manifest, restore: () => writeFileSync(hpp, original) };
}

const out: Record<string, unknown>[] = [];
for (const [arm, runs] of [
  ['C', C_RUNS],
  ['L', L_RUNS],
] as const) {
  const receipts = loadArm(runs);
  const { manifest, restore } = await manifestFor(arm);
  const agg = aggregate(receipts, manifest) as Array<{
    id: string;
    lane: string;
    nodes: number;
    inputBytes: number;
    rustra: { mean: number; median?: number };
    nitro: { mean: number };
    ratios: number[];
    confidence95: [number, number];
  }>;
  restore();
  out.push({ arm, runs, cases: agg });
}
writeFileSync('/tmp/parity-ab/aggregate-raw.json', JSON.stringify(out, null, 1));

// Compare per case+lane: candidate/legacy ratio of rustra means.
const cand = new Map(out[0].cases.map((c) => [`${c.lane}/${c.id}`, c]));
const leg = new Map(out[1].cases.map((c) => [`${c.lane}/${c.id}`, c]));
const rows: Array<{ key: string; c: number; l: number; ratio: number }> = [];
for (const [key, c] of cand) {
  const l = leg.get(key);
  if (!l) continue;
  rows.push({ key, c: c.rustra.mean, l: l.rustra.mean, ratio: c.rustra.mean / l.rustra.mean });
}
rows.sort((a, b) => a.ratio - b.ratio);
console.log('ratio  candidate/legacy   (lower=candidate faster)');
for (const r of rows)
  console.log(`${r.ratio.toFixed(4)}  ${r.key}  C=${r.c.toFixed(1)}ns L=${r.l.toFixed(1)}ns`);
const lanes = new Map<string, number[]>();
for (const r of rows) {
  const lane = r.key.split('/')[0];
  if (!lanes.has(lane)) lanes.set(lane, []);
  lanes.get(lane)!.push(r.ratio);
}
console.log('\nper-lane geomean of ratios:');
for (const [lane, rs] of lanes) {
  const g = Math.exp(rs.reduce((a, b) => a + Math.log(b), 0) / rs.length);
  console.log(`${lane}: ${g.toFixed(4)} (n=${rs.length})`);
}
const all = rows.map((r) => r.ratio);
const g = Math.exp(all.reduce((a, b) => a + Math.log(b), 0) / all.length);
console.log(`overall geomean: ${g.toFixed(4)} (n=${all.length})`);

// Paired log-ratio analysis: protocol pairs (C1,L2)(L3,C4)(C5,L6)(L7,C8)(L9,C10).
import { statSync } from 'node:fs';
const pairDefs: Array<[number, number]> = [
  [1, 2],
  [4, 3],
  [5, 6],
  [8, 7],
  [10, 9],
];
function receiptOf(n: number): Receipt {
  return JSON.parse(readFileSync(`${RUNS}/run-${n}/receipt.json`, 'utf8')).receipt as Receipt;
}
const pairs = pairDefs.map(([c, l]) => ({ c: receiptOf(c), l: receiptOf(l) }));
const cRuns = pairs.map((p) => p.c);
const lRuns = pairs.map((p) => p.l);
// mean rustra per case per run
function caseMean(r: Receipt, id: string, lane: string): number {
  const c = r.cases.find((v) => v.id === id && v.lane === lane)!;
  return c.rustra.reduce((a, b) => a + b, 0) / c.rustra.length;
}
const caseKeys = pairs[0].c.cases.map((c) => ({ id: c.id, lane: c.lane }));
const paired = caseKeys.map(({ id, lane }) => {
  const logs = pairs.map((p) => Math.log(caseMean(p.c, id, lane) / caseMean(p.l, id, lane)));
  const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
  const sd = Math.sqrt(logs.reduce((a, b) => a + (b - mean) ** 2, 0) / (logs.length - 1));
  // t(4, 0.975) = 2.776
  const ci = (2.776 * sd) / Math.sqrt(logs.length);
  return {
    id,
    lane,
    logRatioMean: mean,
    ratio: Math.exp(mean),
    ci95: [Math.exp(mean - ci), Math.exp(mean + ci)],
  };
});
const sigWin = paired.filter((p) => p.ci95[1] < 1).length;
const sigLose = paired.filter((p) => p.ci95[0] > 1).length;
console.log(
  `\npaired log-ratio t(4): candidate significantly faster in ${sigWin}/90, slower in ${sigLose}/90 (nominal 95%)`,
);
const laneWin: Record<string, number> = {};
for (const p of paired) {
  if (p.ci95[1] < 1) laneWin[p.lane] = (laneWin[p.lane] ?? 0) + 1;
}
console.log('significant wins per lane:', laneWin);
const slow = paired.filter((p) => p.ratio > 1.05);
console.log(
  'cases >5% slower:',
  slow.map(
    (p) => `${p.lane}/${p.id}@${p.ratio.toFixed(3)} [${p.ci95.map((x) => x.toFixed(3)).join(',')}]`,
  ),
);
writeFileSync('/tmp/parity-ab/paired-cases.json', JSON.stringify(paired, null, 1));

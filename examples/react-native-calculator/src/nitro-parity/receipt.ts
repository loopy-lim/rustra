import { EXPECTED_IDS, lanesForContract, type Lane } from './contract';
import { classify, confidence, summary, type Samples } from './measurement';
export type CaseReceipt = Samples & {
  id: string;
  lane: Lane;
  verified: true;
  nodes: number;
  inputBytes: number;
  byteMeaning: string;
};
export type Receipt = {
  contract: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  status: 'complete';
  runtime: string;
  release: boolean;
  platform: string;
  environment: string;
  fingerprint: string;
  generatedContract: string;
  nitroVersion: string;
  nitrogenVersion: string;
  rustraVersion: string;
  representation: string;
  baseline: string;
  setupLifecycle: 'warm-full-build-and-replacement';
  cases: CaseReceipt[];
};
export type CasePlan = Pick<
  CaseReceipt,
  'id' | 'lane' | 'nodes' | 'inputBytes' | 'byteMeaning' | 'batch'
> & { rounds: number };
export type ExperimentManifest = {
  contract: string;
  fingerprint: string;
  generatedContract: string;
  baseline: string;
  cases: CasePlan[];
};
type Expected = ExperimentManifest & { after?: number };
function expectedPlans(expected: Expected): Map<string, CasePlan> {
  if (
    !expected ||
    !/^[a-f0-9]{64}$/.test(expected.fingerprint) ||
    !/^[a-f0-9]{64}$/.test(expected.generatedContract) ||
    !/^[a-f0-9]{40}$/.test(expected.baseline)
  )
    throw new Error('invalid experiment manifest identity');
  const wanted = new Set(
    lanesForContract(expected.contract).flatMap((lane) =>
      EXPECTED_IDS.map((id) => `${lane}:${id}`),
    ),
  );
  if (!Array.isArray(expected.cases) || expected.cases.length !== wanted.size)
    throw new Error('incomplete experiment manifest');
  const plans = new Map<string, CasePlan>();
  for (const plan of expected.cases) {
    const key = `${plan.lane}:${plan.id}`;
    if (
      !wanted.delete(key) ||
      !Number.isInteger(plan.nodes) ||
      plan.nodes < 0 ||
      !Number.isInteger(plan.inputBytes) ||
      plan.inputBytes <= 0 ||
      !Number.isInteger(plan.batch) ||
      plan.batch < 1 ||
      typeof plan.byteMeaning !== 'string' ||
      !plan.byteMeaning ||
      plan.rounds !== 31
    )
      throw new Error('invalid experiment case plan');
    plans.set(key, plan);
  }
  return plans;
}
export function validateReceipt(value: unknown, expected: Expected): asserts value is Receipt {
  const plans = expectedPlans(expected);
  const r = value as Receipt;
  if (
    !r ||
    r.contract !== expected.contract ||
    r.status !== 'complete' ||
    r.runtime !== 'Hermes' ||
    r.release !== true ||
    r.nitroVersion !== '0.37.1' ||
    r.nitrogenVersion !== '0.37.1' ||
    r.rustraVersion !== '0.10.2' ||
    r.representation !== 'flat-arena' ||
    r.setupLifecycle !== 'warm-full-build-and-replacement'
  )
    throw new Error('unsupported receipt contract/runtime/version/status');
  if (
    r.fingerprint !== expected.fingerprint ||
    !/^[a-f0-9]{64}$/.test(r.fingerprint) ||
    !/^[a-f0-9]{64}$/.test(r.generatedContract)
  )
    throw new Error('stale or absent fingerprint');
  if (r.generatedContract !== expected.generatedContract || r.baseline !== expected.baseline)
    throw new Error('receipt does not match frozen generated contract/baseline');
  if (
    typeof r.runId !== 'string' ||
    !r.runId ||
    !Number.isFinite(Date.parse(r.startedAt)) ||
    Date.parse(r.finishedAt) < Date.parse(r.startedAt) ||
    !Number.isFinite(Date.parse(r.finishedAt)) ||
    (expected.after != null && Date.parse(r.startedAt) < expected.after)
  )
    throw new Error('stale run');
  if (
    !['ios', 'android'].includes(r.platform) ||
    !['simulator', 'physical'].includes(r.environment)
  )
    throw new Error('unsupported environment');
  const wanted = new Set(plans.keys());
  if (!Array.isArray(r.cases) || r.cases.length !== wanted.size)
    throw new Error('incomplete case matrix');
  for (const c of r.cases) {
    if (!wanted.delete(`${c.lane}:${c.id}`) || c.verified !== true)
      throw new Error('duplicate/unsupported/unverified case');
    if (
      !Number.isInteger(c.batch) ||
      c.batch < 1 ||
      !Number.isFinite(c.checksum) ||
      c.checksum <= 0 ||
      !Number.isInteger(c.inputBytes) ||
      c.inputBytes <= 0 ||
      !Number.isInteger(c.nodes) ||
      c.nodes < 0
    )
      throw new Error('invalid case provenance');
    const plan = plans.get(`${c.lane}:${c.id}`)!;
    for (const field of ['nodes', 'inputBytes', 'byteMeaning', 'batch'] as const)
      if (c[field] !== plan[field])
        throw new Error(`case ${c.id} ${field} does not match frozen manifest`);
    if (
      !Array.isArray(c.rustra) ||
      !Array.isArray(c.nitro) ||
      c.rustra.length !== plan.rounds ||
      c.nitro.length !== plan.rounds
    )
      throw new Error('mismatched or insufficient paired samples');
    summary(c.rustra);
    summary(c.nitro);
  }
}
export function aggregate(values: unknown[], expected: Expected) {
  if (values.length < 5) throw new Error('five independent launches required');
  values.forEach((value) => validateReceipt(value, expected));
  const receipts = values as Receipt[];
  if (new Set(receipts.map((r) => r.runId)).size !== receipts.length)
    throw new Error('duplicate launch');
  const first = receipts[0];
  for (const r of receipts)
    for (const key of [
      'platform',
      'environment',
      'fingerprint',
      'generatedContract',
      'baseline',
    ] as const)
      if (r[key] !== first[key]) throw new Error(`mixed ${key}`);
  return first.cases.map((c) => {
    const runs = receipts.map((r) => r.cases.find((v) => v.id === c.id && v.lane === c.lane)!);
    if (
      runs.some((r) => r.batch !== c.batch || r.nodes !== c.nodes || r.inputBytes !== c.inputBytes)
    )
      throw new Error('mismatched case metadata');
    const ratios = runs.map((r) => summary(r.rustra).mean / summary(r.nitro).mean),
      ci = confidence(ratios);
    return {
      id: c.id,
      lane: c.lane,
      nodes: c.nodes,
      inputBytes: c.inputBytes,
      launches: runs.length,
      ratios,
      confidence95: ci,
      method: 'paired-launch-log-ratio-t',
      classification: classify(ci),
      rustra: summary(runs.flatMap((r) => r.rustra)),
      nitro: summary(runs.flatMap((r) => r.nitro)),
    };
  });
}

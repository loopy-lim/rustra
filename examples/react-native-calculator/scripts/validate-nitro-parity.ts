#!/usr/bin/env bun
/** Revalidate immutable historical receipts against their original build manifest. */
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { aggregate, type ExperimentManifest } from '../src/nitro-parity/receipt';
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    directory: { type: 'string' },
    manifest: { type: 'string' },
    output: { type: 'string' },
  },
});
if (!values.directory || !values.manifest || !values.output)
  throw new Error('--directory, --manifest and new --output are required');
const directory = resolve(values.directory),
  manifestText = await readFile(resolve(values.manifest), 'utf8');
const manifest: ExperimentManifest = JSON.parse(manifestText);
const names = (await readdir(directory))
  .filter((name) => /^launch-\d+\.json$/.test(name))
  .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
const texts = await Promise.all(names.map((name) => readFile(join(directory, name), 'utf8')));
const receipts = texts.map((text) => JSON.parse(text));
const results = aggregate(receipts, manifest);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const report = {
  validation: 'frozen-experiment-manifest/v1',
  historicalFingerprint: manifest.fingerprint,
  generatedContract: manifest.generatedContract,
  baseline: manifest.baseline,
  manifestSha256: sha(manifestText),
  receipts: names.map((name, i) => ({ name, sha256: sha(texts[i]), runId: receipts[i].runId })),
  results,
};
// Exclusive creation preserves original receipts, summaries and previous validation evidence.
await writeFile(resolve(values.output), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(
  `Revalidated ${receipts.length} historical launches, ${results.length} cases: ${manifest.fingerprint}`,
);

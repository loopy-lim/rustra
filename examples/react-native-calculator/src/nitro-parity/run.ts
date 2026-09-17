import { Platform } from 'react-native';
import { NitroModules } from 'react-native-nitro-modules';
import type { NitroBench } from 'nitro-bench';
import { configure, bindSync } from '@rustra/types';
import { installRustraJSI, getRustraNative } from '@rustra/generated-react-native';
import RustraCalculator from 'rustra-calculator';
import { createFrameEngine } from '../adapters/frame-adapter';
import { GENERATED_CONTRACT_HASH } from '../../generated/contract';
import { RUSTRA_BUILD_FINGERPRINT } from '../build-fingerprint';
import { createCases } from './cases';
import { emitAndroidReceiptChunks } from './android-receipt-transport';
import { CONTRACT, LANES } from './contract';
import { measureAsyncPair, measureSyncPair, summary } from './measurement';
import type { CaseReceipt, Receipt } from './receipt';
import nitroPackage from 'react-native-nitro-modules/package.json';
import fixturePackage from '../../modules/nitro-bench/nitro-bench/package.json';

export async function runParity(progress: (message: string) => void): Promise<Receipt> {
  if (__DEV__) throw new Error('parity requires Release');
  if (!(globalThis as unknown as { HermesInternal?: unknown }).HermesInternal)
    throw new Error('parity requires Hermes');
  if (nitroPackage.version !== '0.37.1' || fixturePackage.devDependencies.nitrogen !== '0.37.1')
    throw new Error('parity version mismatch');
  const startedAt = new Date().toISOString();
  await installRustraJSI();
  const native = getRustraNative();
  configure(createFrameEngine(native));
  const nitro = NitroModules.createHybridObject<NitroBench>('NitroBench');
  const cases = createCases(native, nitro, (command) => bindSync<unknown, unknown>(command)),
    results: CaseReceipt[] = [];
  for (const lane of LANES)
    for (const entry of cases) {
      progress(`${lane}: ${entry.id} (verify)`);
      // 케이스별 네이티브 준비가 끝나야 다음 측정이 의미 있다 — 순차 검증이 계약이다.
      // react-doctor-disable-next-line async-await-in-loop
      await entry.preflight();
      const options = { batch: entry.batch, rounds: 31, warmup: 3 };
      const samples =
        lane === 'async-public'
          ? await measureAsyncPair(entry.rustraAsync, entry.nitroAsync, options)
          : measureSyncPair(
              lane === 'sync-public' ? entry.rustraPublicSync : entry.rustra,
              entry.nitro,
              options,
            );
      summary(samples.rustra);
      summary(samples.nitro);
      results.push({
        id: entry.id,
        lane,
        verified: true,
        nodes: entry.nodes,
        inputBytes: entry.inputBytes,
        byteMeaning: entry.byteMeaning,
        ...samples,
      });
      progress(`${lane}: ${entry.id} complete`);
    }
  const receipt: Receipt = {
    contract: CONTRACT,
    runId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: 'complete',
    runtime: 'Hermes',
    release: true,
    platform: Platform.OS,
    environment:
      process.env.EXPO_PUBLIC_PARITY_ENVIRONMENT === 'physical' ? 'physical' : 'simulator',
    fingerprint: RUSTRA_BUILD_FINGERPRINT,
    generatedContract: GENERATED_CONTRACT_HASH,
    nitroVersion: nitroPackage.version,
    nitrogenVersion: fixturePackage.devDependencies.nitrogen,
    rustraVersion: '0.10.2',
    representation: 'flat-arena',
    setupLifecycle: 'warm-full-build-and-replacement',
    baseline: '8db7279cd30cf50ab1ba625f325a11a832697891',
    cases: results,
  };
  const json = JSON.stringify(receipt);
  if (Platform.OS === 'ios') {
    if (!RustraCalculator.writeBenchmarkReceipt) throw new Error('receipt writer unavailable');
    const filename = RustraCalculator.writeBenchmarkReceipt(json);
    if (filename !== 'rustra-nitro-parity.json') throw new Error('stale native receipt writer');
  } else {
    // Android runner may reconstruct indexed chunks from a fresh, PID-filtered logcat capture.
    await emitAndroidReceiptChunks(
      json,
      receipt.runId,
      (line) => console.log(line),
      (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    );
  }
  return receipt;
}

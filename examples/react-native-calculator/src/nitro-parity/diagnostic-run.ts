import { Linking, Platform } from 'react-native';
import { configure, bindSync } from '@rustra/types';
import { installRustraJSI, getRustraNative } from '@rustra/generated-react-native';
import { NitroModules } from 'react-native-nitro-modules';
import type { NitroBench } from 'nitro-bench';
import RustraCalculator from 'rustra-calculator';
import { createFrameEngine } from '../adapters/frame-adapter';
import { RUSTRA_BUILD_FINGERPRINT } from '../build-fingerprint';
import { GENERATED_CONTRACT_HASH } from '../../generated/contract';
import { emitAndroidReceiptChunks } from './android-receipt-transport';
import {
  DIAGNOSTIC_CONTRACT,
  diagnosticOrder,
  parseDiagnosticURL,
  sampleDiagnostic,
  type Framework,
} from './diagnostic';
import { verifyDiagnosticPreflight } from './diagnostic-verify';

export async function runDiagnostic(progress: (message: string) => void) {
  if (__DEV__ || !(globalThis as unknown as { HermesInternal?: unknown }).HermesInternal)
    throw Error('diagnostic requires Hermes Release');
  const plan = parseDiagnosticURL(
    (await Linking.getInitialURL()) ?? process.env.EXPO_PUBLIC_PARITY_DIAGNOSTIC_URL ?? null,
  );
  const startedAt = new Date().toISOString();
  await installRustraJSI();
  configure(createFrameEngine(getRustraNative()));
  const nitro = NitroModules.createHybridObject<NitroBench>('NitroBench');
  const bytes = plan.caseId.startsWith('buffer') ? Number(plan.caseId.slice(6)) : 0;
  const data = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) data[i] = (i * 17) % 251;
  const input = bytes
    ? { data: data.buffer }
    : plan.caseId === 'add'
      ? { a: 42, b: 58 }
      : plan.caseId === 'string'
        ? { value: 'Rustra ↔ Nitro: 문자열' }
        : { name: 'pair', value: 123.5 };
  const command = bytes
    ? 'benchEchoBytes'
    : plan.caseId === 'add'
      ? 'benchAdd'
      : plan.caseId === 'string'
        ? 'benchEchoString'
        : 'benchEchoPair';
  const bound = bindSync<unknown, unknown>(command);
  const calls: Record<Framework, () => unknown> = {
    rustra: () => bound(input),
    nitro: () =>
      bytes
        ? nitro.echoBuffer(input as { data: ArrayBuffer })
        : plan.caseId === 'add'
          ? nitro.benchAdd(input as { a: number; b: number })
          : plan.caseId === 'string'
            ? nitro.echoString(input as { value: string })
            : nitro.echoPair(input as { name: string; value: number }),
  };
  // Validate only frameworks selected by this diagnostic schedule. No competitor output in isolated runs.
  for (const framework of diagnosticOrder(plan.schedule, 0)) {
    const first = calls[framework](),
      second = calls[framework]();
    verifyDiagnosticPreflight(plan.caseId, input, first, second);
  }
  const batch = bytes === 65536 ? 8 : bytes ? 1 : 256;
  progress(`diagnostic ${plan.caseId} ${plan.schedule}`);
  const samples = sampleDiagnostic(calls, plan.schedule, batch);
  const receipt = {
    contract: DIAGNOSTIC_CONTRACT,
    ...plan,
    startedAt,
    finishedAt: new Date().toISOString(),
    platform: Platform.OS,
    runtime: 'Hermes',
    release: true,
    fingerprint: RUSTRA_BUILD_FINGERPRINT,
    generatedContract: GENERATED_CONTRACT_HASH,
    protocol: {
      rounds: 31,
      warmup: 3,
      batch,
      preflight: 'selected-frameworks-only-two-fresh-values',
      memoryPressure: 'unchanged-native4',
      forcedGC: false,
    },
    samples,
  };
  const json = JSON.stringify(receipt);
  if (Platform.OS === 'android')
    await emitAndroidReceiptChunks(
      json,
      plan.runId,
      (line) => console.log(line),
      (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    );
  else if (RustraCalculator.writeBenchmarkReceipt) RustraCalculator.writeBenchmarkReceipt(json);
  else throw Error('diagnostic writer unavailable');
  return receipt;
}

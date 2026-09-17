import { Linking, Platform } from 'react-native';
import { configure, bindSync } from '@rustra/types';
import { installRustraJSI, getRustraNative } from '@rustra/generated-react-native';
import { NitroModules } from 'react-native-nitro-modules';
import type { NitroBench } from 'nitro-bench';
import RustraCalculator from 'rustra-calculator';
import nitroPackage from 'react-native-nitro-modules/package.json';
import fixturePackage from '../../modules/nitro-bench/nitro-bench/package.json';
import { createFrameEngine } from '../adapters/frame-adapter';
import { RUSTRA_BUILD_FINGERPRINT } from '../build-fingerprint';
import { GENERATED_CONTRACT_HASH } from '../../generated/contract';
import { emitAndroidReceiptChunks } from './android-receipt-transport';
import { createCases } from './cases';
import { PROFILE_CONTRACT, parseProfileURL, profileValue, runProfile } from './profile';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const IOS_RECEIPT = 'rustra-benchmark-receipt.json';

async function waitForProfileURL(startedAt: string): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let receiveURL: (url: string) => void = () => {};
  const urlEvent = new Promise<string>((resolve) => {
    receiveURL = resolve;
  });
  // Install before checking the initial URL so an openurl during startup is retained.
  const subscription = Linking.addEventListener('url', ({ url }) => receiveURL(url));
  try {
    const initial = (await Linking.getInitialURL()) ?? process.env.EXPO_PUBLIC_PARITY_PROFILE_URL;
    if (initial != null) return initial;
    if (Platform.OS === 'ios') {
      if (!RustraCalculator.writeBenchmarkReceipt) throw Error('profile writer unavailable');
      const filename = RustraCalculator.writeBenchmarkReceipt(
        JSON.stringify({
          contract: PROFILE_CONTRACT,
          status: 'awaiting-url',
          fingerprint: RUSTRA_BUILD_FINGERPRINT,
          generatedContract: GENERATED_CONTRACT_HASH,
          startedAt,
          phaseAt: new Date().toISOString(),
        }),
      );
      if (filename !== IOS_RECEIPT) throw Error('stale native receipt writer');
    }
    return await Promise.race([
      urlEvent,
      new Promise<string>((_, reject) => {
        timeout = setTimeout(() => reject(Error('profile URL wait timed out')), 20000);
      }),
    ]);
  } finally {
    subscription.remove();
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function runProfileDiagnostic(progress: (message: string) => void) {
  if (__DEV__ || !(globalThis as unknown as { HermesInternal?: unknown }).HermesInternal)
    throw Error('profile requires Hermes Release');
  if (nitroPackage.version !== '0.37.1' || fixturePackage.devDependencies.nitrogen !== '0.37.1')
    throw Error('profile version mismatch');
  const startedAt = new Date().toISOString();
  const plan = parseProfileURL(await waitForProfileURL(startedAt));
  await installRustraJSI();
  const native = getRustraNative();
  configure(createFrameEngine(native));
  const nitro = NitroModules.createHybridObject<NitroBench>('NitroBench');
  const entry = createCases(native, nitro, (command) => bindSync<unknown, unknown>(command)).find(
    (candidate) => candidate.id === plan.caseId,
  );
  if (!entry) throw Error('profile case unavailable');

  // The existing case verifies all its lanes, freshness and alias policy before capture.
  progress(`profile ${plan.caseId} ${plan.framework} (preflight)`);
  await entry.preflight();
  const call = plan.framework === 'rustra' ? entry.rustraPublicSync : entry.nitro;
  const expectedPerCall = profileValue(call());
  if (profileValue(call()) !== expectedPerCall) throw Error('profile preflight checksum mismatch');

  const identity = {
    contract: PROFILE_CONTRACT,
    ...plan,
    startedAt,
    platform: Platform.OS,
    runtime: 'Hermes',
    release: true,
    environment:
      process.env.EXPO_PUBLIC_PARITY_ENVIRONMENT === 'physical' ? 'physical' : 'simulator',
    fingerprint: RUSTRA_BUILD_FINGERPRINT,
    generatedContract: GENERATED_CONTRACT_HASH,
    nitroVersion: nitroPackage.version,
    nitrogenVersion: fixturePackage.devDependencies.nitrogen,
    rustraVersion: '0.10.2',
    batch: entry.batch,
    expectedPerCall,
  };
  const writeIOSPhase = (status: 'ready' | 'active', phaseAt: string) => {
    if (Platform.OS !== 'ios') return;
    if (!RustraCalculator.writeBenchmarkReceipt) throw Error('profile writer unavailable');
    const filename = RustraCalculator.writeBenchmarkReceipt(
      JSON.stringify({ ...identity, status, phaseAt }),
    );
    if (filename !== IOS_RECEIPT) throw Error('stale native receipt writer');
  };
  const readyAt = new Date().toISOString();
  console.log(`RUSTRA_PROFILE_READY=${plan.runId}`);
  writeIOSPhase('ready', readyAt);
  await sleep(3000);
  const activeAt = new Date().toISOString();
  console.log(`RUSTRA_PROFILE_ACTIVE=${plan.runId}`);
  writeIOSPhase('active', activeAt);
  const measured = runProfile(call, entry.batch, plan.durationMs, expectedPerCall);
  const receipt = {
    ...identity,
    status: 'complete' as const,
    activeAt,
    finishedAt: new Date().toISOString(),
    ...measured,
    limitations: [
      'profile duration is not uninstrumented benchmark time',
      'existing preflight all lanes runs before profile',
    ],
  };
  const json = JSON.stringify(receipt);
  if (Platform.OS === 'ios') {
    if (!RustraCalculator.writeBenchmarkReceipt) throw Error('profile writer unavailable');
    const filename = RustraCalculator.writeBenchmarkReceipt(json);
    if (filename !== IOS_RECEIPT) throw Error('stale native receipt writer');
  } else {
    await emitAndroidReceiptChunks(json, plan.runId, (line) => console.log(line), sleep);
  }
  console.log(`RUSTRA_PROFILE_DONE=${plan.runId}`);
  return receipt;
}

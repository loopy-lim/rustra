import { getRustraNative } from '@rustra/generated-react-native';
import { createFrameEngine, RustraCommandError } from '@rustra/types';
import { Platform } from 'react-native';
import RustraCalculator from '../modules/rustra-calculator/src';
import {
  add,
  addNumbers,
  greetPerson,
  readRemembered,
  remember,
  reset,
  safeDivide,
} from '../generated/react-native';
import { frameRegistry } from '../generated/frame-registry';
import { GENERATED_CONTRACT_HASH } from '../generated/contract';
import { RUSTRA_BUILD_FINGERPRINT } from './build-fingerprint';
import { summarize } from './benchmark-stats';

/** Real generated commands, with the installed native bridge and Rust state. */
export async function runFunctionDemo() {
  const checks: { name: string; actual: unknown; passed: true }[] = [];
  const check = (name: string, actual: unknown, expected: unknown) => {
    if (!Object.is(actual, expected)) {
      throw new Error(`${name}: expected ${String(expected)}, received ${String(actual)}`);
    }
    checks.push({ name, actual: actual === undefined ? 'undefined' : actual, passed: true });
  };
  check('add(42, 58)', await add(42, 58), 100);
  check('greetPerson("민지")', await greetPerson('민지'), 'Hello, 민지!');
  check('remember(100) returns void', await remember(100), undefined);
  check('readRemembered()', await readRemembered(), 100);
  check('reset() returns void', await reset(), undefined);
  check('reset clears Rust state', await readRemembered(), 0);
  check('safeDivide(84, 2)', await safeDivide(84, 2), 42);
  let errorCode: string | undefined;
  try {
    await safeDivide(1, 0);
  } catch (error) {
    if (!(error instanceof RustraCommandError)) throw error;
    errorCode = error.code;
  }
  check('zero divisor maps domain error', errorCode, 'math.zero_divisor');

  const native = getRustraNative();
  const codec = frameRegistry.get('add');
  if (!codec?.encodeInto) throw new Error('Generated add cursor codec is missing');
  check(
    'function uses supported JS frame route',
    native.getCodecCapabilities?.(codec.commandId),
    0,
  );
  const live = createFrameEngine(native, new Map());
  check('live schema add', await live.invoke('add', [42, 58]), 100);
  check('live schema reset returns void', await live.invoke('reset', null), undefined);
  const request = new Uint8Array(codec.encode([42, 58]));
  const reuse = new Uint8Array(64);
  check(
    'cursor matches generated wire',
    Array.from(codec.encodeInto([42, 58], reuse)).join(','),
    Array.from(request).join(','),
  );
  check('legacy addNumbers still works', (await addNumbers({ a: 42, b: 58 })).value, 100);

  const samples: Record<string, number[]> = {
    generatedFunction: [],
    legacyCommand: [],
    encode: [],
    encodeInto: [],
  };
  let checksum = 0;
  if (!__DEV__) {
    const args = [42, 58];
    const input = { a: 42, b: 58 };
    const operations = {
      generatedFunction: async () => {
        checksum += await add(args[0], args[1]);
      },
      legacyCommand: async () => {
        checksum += Number((await addNumbers(input)).value);
      },
    };
    for (let round = 0; round < 22; round++) {
      const order =
        round % 2
          ? (['legacyCommand', 'generatedFunction'] as const)
          : (['generatedFunction', 'legacyCommand'] as const);
      for (const name of order) {
        const start = performance.now();
        for (let i = 0; i < 1_000; i++) await operations[name]();
        if (round >= 2) samples[name].push(((performance.now() - start) * 1e6) / 1_000);
      }
      const encodeOrder =
        round % 2 ? (['encodeInto', 'encode'] as const) : (['encode', 'encodeInto'] as const);
      for (const name of encodeOrder) {
        const start = performance.now();
        for (let i = 0; i < 5_000; i++) {
          args[0] = i & 31;
          const bytes =
            name === 'encode' ? new Uint8Array(codec.encode(args)) : codec.encodeInto(args, reuse);
          checksum += bytes[2];
        }
        if (round >= 2) samples[name].push(((performance.now() - start) * 1e6) / 5_000);
      }
      args[0] = 42;
      // Keep the screen responsive; yields sit outside the timed batches.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  const receipt = {
    kind: 'rustra-ordinary-functions',
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: Platform.OS,
    buildMode: __DEV__ ? 'debug' : 'release',
    buildFingerprint: RUSTRA_BUILD_FINGERPRINT,
    contractHash: GENERATED_CONTRACT_HASH,
    checks,
    correctness: { passed: true, checkedBeforeTiming: true },
    benchmark: __DEV__
      ? null
      : {
          scope:
            'Hermes native app JS. Generated calls include await and native roundtrip; legacy input/output shape, i64 width and result normalization differ. Encoding excludes native and exact-buffer transport copies.',
          samples: 20,
          callIterationsPerSample: 1_000,
          encodingIterationsPerSample: 5_000,
          checksum,
          nanoseconds: Object.fromEntries(
            Object.entries(samples).map(([name, values]) => [name, summarize(name, values)]),
          ),
        },
  };
  if (Platform.OS === 'ios') {
    if (!RustraCalculator.writeFunctionReceipt)
      throw new Error('Rebuild iOS: function receipt writer is missing');
    RustraCalculator.writeFunctionReceipt(JSON.stringify(receipt));
  }
  console.warn(`__RUSTRA_FUNCTIONS_OK__ ${checks.length} checks ${RUSTRA_BUILD_FINGERPRINT}`);
  return receipt;
}

export type FunctionDemoReceipt = Awaited<ReturnType<typeof runFunctionDemo>>;

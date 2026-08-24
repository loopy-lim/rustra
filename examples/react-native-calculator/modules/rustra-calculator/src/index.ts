import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

const LINKING_ERROR =
  `The package 'rustra-calculator' is not linked. Expo Go cannot load it.\n\n` +
  Platform.select({
    ios:
      '- Run `bun run doctor` to check Expo autolinking, Podfile.lock, the Rust archive, and FFI symbols.\n' +
      '- Repair Pods with `bunx pod-install ios` when doctor reports a Pod failure.\n' +
      '- Rebuild with `bun run ios -- --configuration Release`; Metro reload cannot relink Rust.\n',
    default:
      '- Run `bun run doctor`, rebuild Rust with `bun run rust:android`, and rebuild the native app.\n',
  }) +
  '- If the archive is stale or symbols are missing, fix the Rust export/build error before changing TypeScript.\n';

const linkedModule = requireOptionalNativeModule<RustraCalculatorType>('RustraCalculator');

const RustraCalculator: RustraCalculatorType = linkedModule
  ? linkedModule
  : new Proxy({} as RustraCalculatorType, {
      get() {
        throw new Error(LINKING_ERROR);
      },
    });

type InvokeResult = {
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type RustraCalculatorType = {
  invokeRaw(payload: string): Promise<string>;
  invokeSync(command: string, argsJson?: string): string;
  addSync(a: number, b: number): number;
  writeBenchmarkReceipt?(receipt: string): string;
};

export default RustraCalculator as RustraCalculatorType;

export async function invokeCommand(command: string, args?: unknown): Promise<unknown> {
  const payload = JSON.stringify({ command, args });
  const raw = await RustraCalculator.invokeRaw(payload);
  const response: InvokeResult = JSON.parse(raw);
  if (!response.ok) {
    throw new Error(response.error ?? 'invoke failed');
  }
  return response.result;
}

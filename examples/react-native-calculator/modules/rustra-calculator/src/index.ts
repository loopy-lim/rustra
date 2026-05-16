import { NativeModules, Platform } from 'react-native';

const LINKING_ERROR =
  `The package 'rustra-calculator' doesn't seem to be linked. Make sure:\n\n` +
  Platform.select({ ios: "- You have run 'pod install'\n", default: '' }) +
  '- You rebuilt the app after installing the package\n' +
  '- You are not using Expo Go\n';

const RustraCalculator = NativeModules.RustraCalculator
  ? NativeModules.RustraCalculator
  : new Proxy(
      {},
      {
        get() {
          throw new Error(LINKING_ERROR);
        },
      },
    );

type InvokeResult = {
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type RustraCalculatorType = {
  invokeRaw(payload: string): Promise<string>;
  invokeSync(command: string, argsJson?: string): string;
  addSync(a: number, b: number): number;
};

export default RustraCalculator as RustraCalculatorType;

export async function invokeCommand(
  command: string,
  args?: unknown,
): Promise<unknown> {
  const payload = JSON.stringify({ command, args });
  const raw = await RustraCalculator.invokeRaw(payload);
  const response: InvokeResult = JSON.parse(raw);
  if (!response.ok) {
    throw new Error(response.error ?? 'invoke failed');
  }
  return response.result;
}

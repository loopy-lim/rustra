import { NativeModule, requireNativeModule } from 'expo';

declare class NativeRustraCalculatorModule extends NativeModule {
  invokeRaw(payload: string): Promise<string>;
}

type InvokeResponse = {
  ok: boolean;
  result?: unknown;
  error?: string;
};

const NativeRustraCalculator = requireNativeModule<NativeRustraCalculatorModule>('RustraCalculator');

export default {
  async invoke(command: string, args?: unknown): Promise<unknown> {
    const payload = JSON.stringify({ command, args });
    const rawResponse = await NativeRustraCalculator.invokeRaw(payload);
    const response = JSON.parse(rawResponse) as InvokeResponse;

    if (!response.ok) {
      throw new Error(response.error ?? 'Rustra native invoke failed');
    }

    return response.result;
  },
};

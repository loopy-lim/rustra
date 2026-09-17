import type { ExperimentManifest } from '../src/nitro-parity/receipt';
import { createCases } from '../src/nitro-parity/cases';
import { CONTRACT, LANES } from '../src/nitro-parity/contract';
import { GENERATED_CONTRACT_HASH } from '../generated/contract';

/** Host-only snapshot of the fixture plan. Never derive expectations from receipts. */
export function createExperimentManifest(fingerprint: string): ExperimentManifest {
  const unavailable = () => {
    throw new Error('manifest creation must never invoke native code');
  };
  // createCases builds closures and encodes input metadata without calling them.
  // Fail closed if a future constructor starts dispatching native operations.
  const plans = createCases(
    { invokeTypedById: unavailable, invokeTypedBuffer: unavailable } as never,
    {} as never,
  );
  return {
    contract: CONTRACT,
    fingerprint,
    generatedContract: GENERATED_CONTRACT_HASH,
    baseline: '8db7279cd30cf50ab1ba625f325a11a832697891',
    cases: LANES.flatMap((lane) =>
      plans.map(({ id, nodes, inputBytes, byteMeaning, batch }) => ({
        id,
        lane,
        nodes,
        inputBytes,
        byteMeaning,
        batch,
        rounds: 31,
      })),
    ),
  };
}

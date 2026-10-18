/** Portable collector. Host tests exercise this orchestration, never RN performance. */
export type GzipCommand = 'gzipCompress' | 'gzipDecompress';
export type BenchmarkRoute = 'json' | 'bytes';
export type BenchmarkOrder = 'json-bytes' | 'bytes-json';
export type BenchmarkMetadata = {
  platform: 'ios' | 'android';
  target: 'physical-device' | 'simulator';
  device: string;
  osVersion: string;
  runtime: 'hermes';
  runtimeVersion: string;
  reactNativeVersion: string;
  buildMode: 'release';
  sourceRevision: string;
  sourceSha256: string;
  bundleSha256: string;
  nativeSha256: string;
  contractHash: string;
};
export type BenchmarkLane = {
  route: BenchmarkRoute;
  command: GzipCommand;
  inputBytes: number;
  outputBytes: number;
  inputSha256: string;
  outputSha256: string;
  samplesUs: number[];
  p50Us: number;
  p95Us: number;
};
export type BenchmarkReceipt = {
  schemaVersion: 1;
  evidence: 'react-native-runtime';
  launchId: string;
  runtimeInstanceId: string;
  collectedAt: string;
  metadata: BenchmarkMetadata;
  order: BenchmarkOrder;
  warmup: number;
  iterations: number;
  timing: 'individual-call-including-js-adapter';
  correctness: 'all-outputs-byte-equal';
  memory: { allocationBytes: null; nativeCopiedBytes: null; status: 'not-instrumented' };
  lanes: BenchmarkLane[];
};
export type BenchmarkOptions = {
  launchId: string;
  runtimeInstanceId: string;
  metadata: BenchmarkMetadata;
  order: BenchmarkOrder;
  sha256(bytes: Uint8Array): string | Promise<string>;
  payloadSizes?: number[];
  warmup?: number;
  iterations?: number;
};
export type BenchmarkTransport = Record<
  BenchmarkRoute,
  (command: GzipCommand, bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>
>;

export function pseudoRandomPayload(length: number): Uint8Array {
  let state = 0x1234_5678;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) | 0;
    bytes[i] = state >>> 28;
  }
  return bytes;
}

export function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (
    Array.isArray(value) &&
    value.every(
      (byte: unknown) => Number.isInteger(byte) && Number(byte) >= 0 && Number(byte) <= 255,
    )
  )
    return Uint8Array.from(value);
  throw new TypeError('gzip result.data must contain bytes');
}

function requireEqual(actual: Uint8Array, expected: Uint8Array, context: string): void {
  if (actual.length !== expected.length || actual.some((byte, index) => byte !== expected[index])) {
    throw new Error(`${context}: gzip bytes mismatch`);
  }
}

export function percentile(samples: number[], fraction: number): number {
  if (samples.length === 0 || samples.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('timing samples must be nonempty, finite and nonnegative');
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

export function validateMetadata(metadata: BenchmarkMetadata): void {
  for (const key of ['sourceSha256', 'bundleSha256', 'nativeSha256', 'contractHash'] as const) {
    if (!/^[a-f0-9]{64}$/.test(metadata[key]))
      throw new Error(`${key} must be an observed SHA-256`);
  }
  if (!/^[a-f0-9]{40}$/.test(metadata.sourceRevision))
    throw new Error('sourceRevision must be a git revision');
  for (const key of ['device', 'osVersion', 'runtimeVersion', 'reactNativeVersion'] as const) {
    if (typeof metadata[key] !== 'string' || !metadata[key].trim())
      throw new Error(`missing ${key}`);
  }
  if (
    !['ios', 'android'].includes(metadata.platform) ||
    !['physical-device', 'simulator'].includes(metadata.target)
  ) {
    throw new Error('explicit native platform and target required');
  }
  if (metadata.runtime !== 'hermes' || metadata.buildMode !== 'release') {
    throw new Error('RN performance receipts require a release Hermes runtime');
  }
}

// A serial promise chain makes the benchmark's no-overlap contract explicit.
// Promise.all would measure contention instead of individual transport latency.
function sequential<T>(values: readonly T[], run: (value: T) => Promise<void>): Promise<void> {
  return values.reduce((previous, value) => previous.then(() => run(value)), Promise.resolve());
}

/** Sequential calls are intentional: parallel dispatch would measure queueing/concurrency. */
export async function collectBenchmark(
  transport: BenchmarkTransport,
  options: BenchmarkOptions,
  now: () => number = () => performance.now(),
): Promise<BenchmarkReceipt> {
  validateMetadata(options.metadata);
  if (!options.launchId || !options.runtimeInstanceId)
    throw new Error('distinct launch/runtime IDs required');
  if (!['json-bytes', 'bytes-json'].includes(options.order))
    throw new Error('invalid crossover order');
  const warmup = options.warmup ?? 5;
  const iterations = options.iterations ?? 100;
  const sizes = options.payloadSizes ?? [1024, 64 * 1024, 256 * 1024];
  if (!Number.isInteger(warmup) || warmup < 1 || warmup > 1000)
    throw new Error('warmup must be 1..1000');
  if (!Number.isInteger(iterations) || iterations < 20 || iterations > 10000)
    throw new Error('iterations must be 20..10000');
  if (
    sizes.length === 0 ||
    new Set(sizes).size !== sizes.length ||
    sizes.some((size) => !Number.isInteger(size) || size < 1 || size > 256 * 1024)
  ) {
    throw new Error(
      'unique payload sizes in 1..262144 required (JSON wire must fit the 1 MiB native limit)',
    );
  }
  const routes: BenchmarkRoute[] =
    options.order === 'json-bytes' ? ['json', 'bytes'] : ['bytes', 'json'];
  const digest = async (bytes: Uint8Array) => {
    const value = await options.sha256(bytes);
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('payload SHA-256 is missing');
    return value;
  };
  const lanes: BenchmarkLane[] = [];
  await sequential(sizes, async (size) => {
    const original = pseudoRandomPayload(size);
    // A fixture is prepared outside the timed region; both transports receive identical bytes.
    const compressed = await transport.json('gzipCompress', original);
    if (compressed[0] !== 0x1f || compressed[1] !== 0x8b || compressed[2] !== 8) {
      throw new Error('gzipCompress did not return a gzip member');
    }
    requireEqual(
      await transport.json('gzipDecompress', compressed),
      original,
      'fixture round trip',
    );
    await sequential(['gzipCompress', 'gzipDecompress'] as const, async (command) => {
      const input = command === 'gzipCompress' ? original : compressed;
      const expected = command === 'gzipCompress' ? compressed : original;
      const [inputSha256, outputSha256] = await Promise.all([digest(input), digest(expected)]);
      await sequential(routes, async (route) => {
        const samplesUs: number[] = [];
        await sequential(
          Array.from({ length: warmup + iterations }, (_, index) => index - warmup),
          async (sample) => {
            const start = now();
            const result = await transport[route](command, input);
            const durationUs = (now() - start) * 1000;
            requireEqual(result, expected, `${route} ${command} sample ${sample}`);
            if (sample >= 0) samplesUs.push(durationUs);
          },
        );
        // Detect input mutation rather than silently using a different payload on the next lane.
        if ((await digest(input)) !== inputSha256) throw new Error(`${route} mutated the input`);
        lanes.push({
          route,
          command,
          inputBytes: input.length,
          outputBytes: expected.length,
          inputSha256,
          outputSha256,
          samplesUs,
          p50Us: percentile(samplesUs, 0.5),
          p95Us: percentile(samplesUs, 0.95),
        });
      });
    });
  });
  return {
    schemaVersion: 1,
    evidence: 'react-native-runtime',
    launchId: options.launchId,
    runtimeInstanceId: options.runtimeInstanceId,
    collectedAt: new Date().toISOString(),
    metadata: options.metadata,
    order: options.order,
    warmup,
    iterations,
    timing: 'individual-call-including-js-adapter',
    correctness: 'all-outputs-byte-equal',
    memory: { allocationBytes: null, nativeCopiedBytes: null, status: 'not-instrumented' },
    lanes,
  };
}

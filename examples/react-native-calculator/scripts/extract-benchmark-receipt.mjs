import { stat } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_BUNDLE_ID = 'com.alt-shifted.react-native-calculator';
export const RECEIPT_FILENAME = 'rustra-benchmark-receipt.json';

function readFlag(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

export function parseArguments(argv) {
  const timeoutMs = Number(readFlag(argv, '--timeout-ms', '120000'));
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer');
  }
  return {
    bundleId: readFlag(argv, '--bundle-id', DEFAULT_BUNDLE_ID),
    device: readFlag(argv, '--device', 'booted'),
    output: readFlag(argv, '--output', undefined),
    timeoutMs,
    launch: !argv.includes('--no-launch'),
  };
}

function run(command, args) {
  const result = Bun.spawnSync({ cmd: [command, ...args], stdout: 'pipe', stderr: 'pipe' });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${stderr || stdout}`);
  }
  return stdout;
}

function validConfidence(value) {
  return (
    value &&
    value.confidenceLevel === 0.95 &&
    Number.isFinite(value.estimate) &&
    Number.isFinite(value.lower) &&
    Number.isFinite(value.upper) &&
    value.lower <= value.estimate &&
    value.estimate <= value.upper &&
    Number.isInteger(value.batchCount) &&
    value.batchCount > 0
  );
}

export function validateBenchmarkReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('benchmark receipt must be a JSON object');
  }
  if (!Number.isInteger(receipt.schemaVersion) || receipt.schemaVersion < 5) {
    throw new Error('benchmark receipt schemaVersion must be at least 5');
  }
  if (!/^[a-f0-9]{64}$/.test(receipt.buildFingerprint)) {
    throw new Error('benchmark receipt is missing a valid build fingerprint');
  }
  if (receipt.platform !== 'ios' || receipt.buildMode !== 'release') {
    throw new Error('benchmark receipt must come from an iOS Release build');
  }
  if (!Number.isFinite(Date.parse(receipt.generatedAt))) {
    throw new Error('benchmark receipt generatedAt must be an ISO timestamp');
  }
  if (
    receipt.correctness?.equivalentOutputs !== true ||
    receipt.correctness?.checkedBeforeTiming !== true
  ) {
    throw new Error('benchmark correctness gate did not pass');
  }
  if (receipt.ffi?.available !== true) {
    throw new Error('benchmark Swift FFI lane is unavailable');
  }

  for (const operation of ['add', 'string', 'bytes64', 'pair']) {
    if (!validConfidence(receipt.equivalent?.[operation]?.confidence95)) {
      throw new Error(`benchmark ${operation} is missing a valid paired confidence interval`);
    }
  }
  for (const operation of ['bytes64KiB', 'bytes1MiBWire']) {
    if (!validConfidence(receipt.byteSizes?.[operation]?.confidence95)) {
      throw new Error(`benchmark ${operation} is missing a valid paired confidence interval`);
    }
  }
  if (!receipt.rawLowerBound?.bottleneckAnalysis?.recommendation) {
    throw new Error('benchmark receipt is missing generated/native bottleneck analysis');
  }
  return receipt;
}

export function isFreshReceipt(receipt, startedAtMs, toleranceMs = 2_000) {
  return Date.parse(receipt.generatedAt) >= startedAtMs - toleranceMs;
}

export async function waitForFreshReceipt(receiptPath, startedAtMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const metadata = await stat(receiptPath);
      if (metadata.mtimeMs >= startedAtMs - 2_000) {
        const receipt = validateBenchmarkReceipt(await Bun.file(receiptPath).json());
        if (isFreshReceipt(receipt, startedAtMs)) return receipt;
      }
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(250);
  }
  throw new Error(
    `timed out waiting for a fresh benchmark receipt at ${receiptPath}${lastError instanceof Error ? `: ${lastError.message}` : ''}`,
  );
}

export async function main(argv = Bun.argv.slice(2)) {
  const options = parseArguments(argv);
  const container = run('xcrun', [
    'simctl',
    'get_app_container',
    options.device,
    options.bundleId,
    'data',
  ]);
  const receiptPath = join(container, 'Documents', RECEIPT_FILENAME);
  const startedAtMs = Date.now();

  if (options.launch) {
    run('xcrun', [
      'simctl',
      'launch',
      '--terminate-running-process',
      options.device,
      options.bundleId,
    ]);
  }

  const receipt = await waitForFreshReceipt(receiptPath, startedAtMs, options.timeoutMs);
  const rendered = `${JSON.stringify(receipt, null, 2)}\n`;
  if (options.output) await Bun.write(options.output, rendered);
  console.log(rendered.trimEnd());
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeInstalledBinary, fail, pass, warn } from './doctor-checks.mjs';

export async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

export async function fileStat(path) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

export async function newestInput(paths) {
  let newest = { mtimeMs: 0, path: undefined };
  async function visit(path) {
    const metadata = await fileStat(path);
    if (!metadata) return;
    if (metadata.isDirectory()) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (!['target', 'node_modules'].includes(entry.name)) await visit(join(path, entry.name));
      }
    } else if (metadata.mtimeMs > newest.mtimeMs) {
      newest = { mtimeMs: metadata.mtimeMs, path };
    }
  }
  for (const path of paths) await visit(path);
  return newest;
}

export function defaultRunner(command, args) {
  const result = Bun.spawnSync({ cmd: [command, ...args], stdout: 'pipe', stderr: 'pipe' });
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

export function commandError(result) {
  const message = result.stderr || result.stdout || 'command failed without output';
  const firstLine = message.split(/\r?\n/).find((line) => line.trim()) ?? message;
  return firstLine.length > 300 ? `${firstLine.slice(0, 297)}...` : firstLine;
}

function firstBootedDevice(raw) {
  try {
    return Object.values(JSON.parse(raw).devices ?? {})
      .flat()
      .find((device) => device?.state === 'Booted' && device?.isAvailable !== false);
  } catch {
    return undefined;
  }
}

export async function analyzeRuntime({
  runner,
  device,
  bundleId,
  newestAppInput,
  expectedBuildFingerprint,
}) {
  const devices = runner('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']);
  if (!devices.ok) {
    return [
      warn(
        'Runtime',
        'ios.simulator',
        'iOS Simulator inspection is unavailable',
        commandError(devices),
        'Install Xcode command-line tools and boot a simulator. Static DX checks above are still valid.',
      ),
    ];
  }
  const booted = device === 'booted' ? firstBootedDevice(devices.stdout) : { udid: device };
  if (!booted?.udid) {
    return [
      warn(
        'Runtime',
        'ios.simulator',
        'No booted iOS Simulator was found',
        undefined,
        'Boot a simulator, then run `bun run ios -- --configuration Release` and rerun `bun run doctor`.',
      ),
    ];
  }

  const appContainer = runner('xcrun', [
    'simctl',
    'get_app_container',
    booted.udid,
    bundleId,
    'app',
  ]);
  if (!appContainer.ok) {
    return [
      warn(
        'Runtime',
        'ios.app',
        'Rustra example is not installed on the booted simulator',
        commandError(appContainer),
        'Run `bun run ios -- --configuration Release`. This rebuilds Rust before Expo/Xcode.',
      ),
    ];
  }

  const executable = runner('plutil', [
    '-extract',
    'CFBundleExecutable',
    'raw',
    '-o',
    '-',
    join(appContainer.stdout, 'Info.plist'),
  ]);
  const executablePath = executable.ok ? join(appContainer.stdout, executable.stdout) : undefined;
  const executableStat = executablePath ? await fileStat(executablePath) : undefined;
  if (!executablePath || !executableStat) {
    return [
      pass('Runtime', 'ios.app', 'Rustra example is installed on the booted simulator', appContainer.stdout),
      fail(
        'Runtime',
        'ios.app.binary',
        'Installed app executable could not be inspected',
        commandError(executable),
        'Rebuild with `bun run ios -- --configuration Release`, then rerun doctor.',
      ),
    ];
  }

  const runtimeChecks = [
    pass('Runtime', 'ios.app', 'Rustra example is installed on the booted simulator', appContainer.stdout),
    ...analyzeInstalledBinary({
      binaryMtimeMs: executableStat.mtimeMs,
      newestInputMtimeMs: newestAppInput.mtimeMs,
      newestInputPath: newestAppInput.path,
      symbols: runner('nm', ['-gU', executablePath]).stdout,
    }),
  ];
  const dataContainer = runner('xcrun', [
    'simctl',
    'get_app_container',
    booted.udid,
    bundleId,
    'data',
  ]);
  const receiptPath = dataContainer.ok
    ? join(dataContainer.stdout, 'Documents', 'rustra-benchmark-receipt.json')
    : undefined;
  const receiptSource = receiptPath ? await readOptional(receiptPath) : undefined;
  if (!receiptSource) {
    return [
      ...runtimeChecks,
      warn(
        'Runtime',
        'ios.release.receipt',
        'No benchmark receipt proves the installed app is Release',
        undefined,
        'Launch the Release app and wait for the benchmark, then run `bun run bench:ios:receipt`.',
      ),
    ];
  }

  try {
    const receipt = JSON.parse(receiptSource);
    const isRelease = receipt.platform === 'ios' && receipt.buildMode === 'release';
    if (isRelease && receipt.buildFingerprint !== expectedBuildFingerprint) {
      return [
        ...runtimeChecks,
        fail(
          'Runtime',
          'ios.release.fingerprint',
          'Installed Release app was built from different source content',
          `installed=${String(receipt.buildFingerprint).slice(0, 16)}..., current=${expectedBuildFingerprint.slice(0, 16)}...`,
          'Run `bun run ios -- --configuration Release`, then extract a fresh receipt. The build command refreshes the content fingerprint first.',
        ),
      ];
    }
    const isCurrent =
      isRelease &&
      receipt.schemaVersion >= 5 &&
      receipt.buildFingerprint === expectedBuildFingerprint &&
      Date.parse(receipt.generatedAt) >= executableStat.mtimeMs - 2_000;
    if (isCurrent) {
      return [
        ...runtimeChecks,
        pass(
          'Runtime',
          'ios.release.receipt',
          'Installed app has an iOS Release benchmark receipt',
          receipt.generatedAt,
        ),
      ];
    }
  } catch {
    // Malformed and Debug receipts share the same remediation below.
  }
  return [
    ...runtimeChecks,
    warn(
      'Runtime',
      'ios.release.receipt',
      'Installed app receipt is not valid iOS Release evidence',
      receiptPath,
      'Run `bun run ios -- --configuration Release`, then `bun run bench:ios:receipt`.',
    ),
  ];
}

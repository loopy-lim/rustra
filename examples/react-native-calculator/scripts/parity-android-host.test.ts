import { expect, test } from 'bun:test';
import { collectAndroid, requireDedicatedApp, type AndroidHost } from './parity-android-host';
import type { ExperimentManifest } from '../src/nitro-parity/receipt';

const appId = 'com.rustra.nitroparity';
const options = {
  appId,
  component: `${appId}/.MainActivity`,
  installedPath: '/data/app/test/base.apk',
  apkSha256: 'a'.repeat(64),
  serial: 'test-device',
  manifest: {} as ExperimentManifest,
  manifestText: '{}',
  launches: 5,
  timeout: 2000,
};
function scenario(kind: string) {
  const files = new Map<string, string>(),
    commands: string[][] = [];
  let tick = 0,
    logReads = 0,
    pidReads = 0,
    stops = 0;
  const raw =
    kind === 'native'
      ? 'RUSTRA_PARITY_FAILED=wrong output'
      : kind === 'parser'
        ? 'RUSTRA_PARITY_CHUNK=invalid'
        : 'progress before failure';
  const host: AndroidHost = {
    now: () => tick,
    sleep: async (ms: number) => {
      tick += ms;
    },
    save: async (name: string, text: string) => {
      files.set(name, text);
    },
    adb: (args: string[]) => {
      commands.push(args);
      const command = args.join(' ');
      if (command.includes('force-stop')) {
        stops++;
        if (kind === 'native-cleanup' && stops === 2) throw new Error('cleanup transport failed');
        return '';
      }
      if (command === 'shell date +%s') {
        if (kind === 'date') throw new Error('clock adb failed');
        return '1700000000';
      }
      if (command.includes('am start')) return 'Launch complete';
      if (command.includes('pidof')) {
        pidReads++;
        if (kind === 'pidof' && pidReads === 2) throw new Error('pidof adb failed');
        return kind === 'exit' && pidReads === 2 ? '' : '4123';
      }
      if (args[0] === 'logcat') {
        logReads++;
        if (kind === 'adb' && logReads === 2)
          throw Object.assign(new Error('logcat adb failed'), {
            stdout: 'partial returned raw log',
          });
        return kind === 'native-cleanup' ? 'RUSTRA_PARITY_FAILED=original native failure' : raw;
      }
      if (command.includes('getprop')) {
        if (kind === 'environment') throw new Error('getprop adb failed');
        return 'fake';
      }
      if (command.includes('dumpsys battery')) return 'battery';
      throw new Error(`unexpected command: ${command}`);
    },
  };
  return { host, files, commands, raw };
}
test('dedicated app identity is exact, including direct host helper calls', async () => {
  requireDedicatedApp(appId);
  for (const id of [`${appId}.candidate`, `${appId}evil`, 'com.other.app', '']) {
    expect(() => requireDedicatedApp(id)).toThrow();
    const s = scenario('native');
    await expect(collectAndroid(s.host, { ...options, appId: id })).rejects.toThrow();
    expect(s.commands).toEqual([]);
  }
});
test.each(['native', 'parser', 'adb', 'pidof', 'exit', 'timeout', 'date', 'environment'])(
  'persists raw log and failed provenance for %s failure without success summary',
  async (kind) => {
    const s = scenario(kind);
    await expect(collectAndroid(s.host, options)).rejects.toThrow();
    expect(s.files.has('launch-1-provenance.json')).toBe(true);
    const record = JSON.parse(s.files.get('launch-1-provenance.json')!);
    expect(record.status).toBe('failed');
    expect(record.reason.length).toBeGreaterThan(0);
    expect(record.apkSha256).toBe(options.apkSha256);
    expect(s.files.has('launch-1.log')).toBe(true);
    if (!['date', 'environment'].includes(kind)) {
      expect(record.pid).toBe('4123');
      expect(record.after).toBe(1700000000000);
      expect(s.files.get('launch-1.log')).toContain(s.raw);
    }
    if (kind === 'adb') expect(s.files.get('launch-1.log')).toContain('partial returned raw log');
    expect(s.files.has('summary.json')).toBe(false);
    expect(JSON.parse(s.files.get('provenance.json')!)[0].status).toBe('failed');
    expect(s.commands.at(-1)).toEqual(['shell', 'am', 'force-stop', appId]);
  },
);
test('cleanup failure preserves the original launch error and records both reasons', async () => {
  const s = scenario('native-cleanup');
  await expect(collectAndroid(s.host, options)).rejects.toThrow('original native failure');
  const status = JSON.parse(s.files.get('collection-status.json')!);
  expect(status.reason).toContain('original native failure');
  expect(status.cleanupError).toContain('cleanup transport failed');
  expect(s.files.has('summary.json')).toBe(false);
});

import { createExperimentManifest } from './parity-manifest';
function completedScenario(fault?: 'apk' | 'summary' | 'cleanup') {
  const base = scenario('timeout');
  const manifest = createExperimentManifest('a'.repeat(64));
  let launch = 0,
    stops = 0;
  const originalAdb = base.host.adb,
    originalSave = base.host.save;
  base.host.adb = (args: string[]) => {
    const command = args.join(' ');
    if (command.includes('am start')) {
      launch++;
      return 'Launch complete';
    }
    if (command.includes('pidof')) return String(4100 + launch);
    if (command.includes('force-stop')) {
      stops++;
      if (fault === 'cleanup' && stops === 6)
        throw new Error('cleanup failed after complete samples');
      return originalAdb(args);
    }
    if (command.includes('sha256sum'))
      return `${fault === 'apk' ? 'b'.repeat(64) : options.apkSha256}  base.apk`;
    if (args[0] === 'logcat') {
      const receipt = {
        contract: manifest.contract,
        runId: `run-${launch}`,
        startedAt: '2026-09-16T00:00:00Z',
        finishedAt: '2026-09-16T00:01:00Z',
        status: 'complete',
        runtime: 'Hermes',
        release: true,
        platform: 'android',
        environment: 'physical',
        fingerprint: manifest.fingerprint,
        generatedContract: manifest.generatedContract,
        nitroVersion: '0.37.1',
        nitrogenVersion: '0.37.1',
        rustraVersion: '0.10.2',
        representation: 'flat-arena',
        setupLifecycle: 'warm-full-build-and-replacement',
        baseline: manifest.baseline,
        cases: manifest.cases.map(({ rounds, ...c }) => ({
          ...c,
          verified: true,
          rustra: Array(rounds).fill(100),
          nitro: Array(rounds).fill(100),
          checksum: 2,
        })),
      };
      return (
        'RUSTRA_PARITY_CHUNK=' +
        JSON.stringify({ runId: receipt.runId, index: 0, total: 1, text: JSON.stringify(receipt) })
      );
    }
    return originalAdb(args);
  };
  base.host.save = async (name, text) => {
    if (name === 'summary.json' && fault === 'summary') throw new Error('summary write failed');
    await originalSave(name, text);
  };
  return { ...base, options: { ...options, manifest, manifestText: JSON.stringify(manifest) } };
}
test('successful five-launch host collection validates actual manifest and preserves all raw logs', async () => {
  const s = completedScenario();
  await collectAndroid(s.host, s.options);
  expect(
    JSON.parse(s.files.get('provenance.json')!).map((v: { status: string }) => v.status),
  ).toEqual(Array(5).fill('complete'));
  expect(JSON.parse(s.files.get('summary.json')!).results).toHaveLength(
    s.options.manifest.cases.length,
  );
  for (let i = 1; i <= 5; i++) {
    expect(s.files.has(`launch-${i}.log`)).toBe(true);
    expect(s.files.has(`launch-${i}.json`)).toBe(true);
  }
});
test.each(['apk', 'cleanup', 'summary'] as const)(
  'post-receipt %s failure cannot publish a successful collection',
  async (fault) => {
    const s = completedScenario(fault);
    await expect(collectAndroid(s.host, s.options)).rejects.toThrow();
    expect(s.files.has('summary.json')).toBe(false);
    expect(JSON.parse(s.files.get('collection-status.json')!).status).toBe('failed');
    expect(s.files.has('launch-1.log')).toBe(true);
    if (fault === 'apk') {
      const record = JSON.parse(s.files.get('launch-1-provenance.json')!);
      expect(record.status).toBe('failed');
      expect(record.installedHashAfter).toBe('b'.repeat(64));
    }
  },
);

test('collection stays pending while summary publication is interrupted, then completes after publication', async () => {
  const s = completedScenario(),
    save = s.host.save;
  let entered!: () => void, release!: () => void;
  const publishing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const completePublications: boolean[] = [];
  s.host.save = async (name, text) => {
    if (name === 'summary.json') {
      entered();
      await resume;
    }
    if (name === 'collection-status.json' && JSON.parse(text).status === 'complete')
      completePublications.push(s.files.has('summary.json'));
    await save(name, text);
  };
  const collection = collectAndroid(s.host, s.options);
  await publishing;
  try {
    expect(s.files.has('summary.json')).toBe(false);
    expect(JSON.parse(s.files.get('collection-status.json')!).status).toBe('pending');
    expect(completePublications).toEqual([]);
  } finally {
    release();
    await collection;
  }
  expect(JSON.parse(s.files.get('collection-status.json')!).status).toBe('complete');
  expect(completePublications).toEqual([true]);
});
test('summary failure plus failed status correction leaves pending, never a false complete marker', async () => {
  const s = completedScenario(),
    save = s.host.save;
  s.host.save = async (name, text) => {
    if (name === 'summary.json') throw new Error('summary publication failed');
    if (name === 'collection-status.json' && JSON.parse(text).status === 'failed')
      throw new Error('status correction also failed');
    await save(name, text);
  };
  await expect(collectAndroid(s.host, s.options)).rejects.toThrow('summary publication failed');
  expect(s.files.has('summary.json')).toBe(false);
  expect(JSON.parse(s.files.get('collection-status.json')!).status).toBe('pending');
  expect(s.files.has('launch-5.log')).toBe(true);
  expect(JSON.parse(s.files.get('provenance.json')!)).toHaveLength(5);
});

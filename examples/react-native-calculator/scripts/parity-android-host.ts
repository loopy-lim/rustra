import {
  aggregate,
  validateReceipt,
  type ExperimentManifest,
  type Receipt,
} from '../src/nitro-parity/receipt';
import { extractAndroidReceipt } from './parity-android-chunks';
import { requireDedicatedApp } from './parity-app-policy';
export { requireDedicatedApp } from './parity-app-policy';

export type AndroidHost = {
  adb: (args: string[]) => string;
  save: (name: string, text: string) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};
export type AndroidOptions = {
  appId: string;
  component: string;
  installedPath: string;
  apkSha256: string;
  serial: string;
  manifest: ExperimentManifest;
  manifestText: string;
  manifestSha256?: string;
  installedHashBefore?: string;
  launches: number;
  timeout: number;
};
type LaunchEvidence = {
  index: number;
  appId: string;
  serial: string;
  component: string;
  apkSha256: string;
  installedHashBefore?: string;
  installedHashAfter?: string;
  after?: number;
  pid?: string;
  launch?: string;
  runId?: string;
  lastCommand?: string[];
  failedCommandOutput?: string;
  stage: string;
  status: 'running' | 'complete' | 'failed';
  reason?: string;
  evidenceErrors?: string[];
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const json = (value: unknown) => JSON.stringify(value, null, 2);

/** Host-only orchestration. All device and filesystem effects are injected for failure tests. */
export async function collectAndroid(host: AndroidHost, options: AndroidOptions): Promise<void> {
  requireDedicatedApp(options.appId);
  const { appId, component, apkSha256, manifest } = options;
  const environment: Record<string, unknown> = {
    serial: options.serial,
    appId,
    component,
    installedPath: options.installedPath,
    apkSha256,
    manifestSha256: options.manifestSha256,
  };
  const receipts: Receipt[] = [],
    provenance: LaunchEvidence[] = [],
    pids = new Set<string>();
  let failed = false,
    failure: unknown,
    cleanupError: string | undefined;
  let summary: unknown;
  try {
    for (let index = 0; index < options.launches; index++) {
      const evidence: LaunchEvidence = {
        index: index + 1,
        appId,
        serial: options.serial,
        component,
        apkSha256,
        installedHashBefore: options.installedHashBefore,
        stage: 'initialize',
        status: 'running',
      };
      let log = '',
        launchFailed = false,
        launchFailure: unknown;
      const adb = (args: string[]): string => {
        evidence.lastCommand = args;
        try {
          return host.adb(args);
        } catch (error) {
          const stdout = (error as { stdout?: unknown } | null)?.stdout;
          if (typeof stdout === 'string' && stdout) {
            evidence.failedCommandOutput = stdout;
            if (args[0] === 'logcat') log += `\n${stdout}`;
          }
          throw error;
        }
      };
      try {
        if (index === 0) {
          await host.save('expected-experiment.json', options.manifestText);
          for (const [field, property] of [
            ['model', 'ro.product.model'],
            ['android', 'ro.build.version.release'],
            ['build', 'ro.build.fingerprint'],
            ['abi', 'ro.product.cpu.abi'],
          ]) {
            environment[field] = adb(['shell', 'getprop', property]);
          }
          environment.batteryBefore = adb(['shell', 'dumpsys', 'battery']);
          await host.save('environment.json', json(environment));
        }
        evidence.stage = 'force-stop';
        adb(['shell', 'am', 'force-stop', appId]);
        evidence.stage = 'device-clock';
        evidence.after = Number(adb(['shell', 'date', '+%s'])) * 1000;
        if (!Number.isFinite(evidence.after) || evidence.after <= 0)
          throw new Error('cannot read device time');
        const started = host.now();
        evidence.stage = 'launch';
        evidence.launch = adb(['shell', 'am', 'start', '-W', '-n', component]);
        evidence.stage = 'pid';
        evidence.pid = adb(['shell', 'pidof', appId]);
        if (!/^\d+$/.test(evidence.pid) || pids.has(evidence.pid))
          throw new Error('independent process not established');
        pids.add(evidence.pid);
        let result: unknown;
        while (host.now() - started < options.timeout) {
          evidence.stage = 'logcat';
          // Assign before parsing: FAILED markers and malformed chunks still retain raw evidence.
          log = adb(['logcat', '--pid', evidence.pid, '-d', '-v', 'raw', '-s', 'ReactNativeJS:I']);
          evidence.stage = 'parse';
          result = extractAndroidReceipt(log);
          if (result !== undefined) break;
          evidence.stage = 'process-check';
          if (adb(['shell', 'pidof', appId]) !== evidence.pid)
            throw new Error('benchmark process exited');
          await host.sleep(1000);
        }
        if (result === undefined) throw new Error('Android parity receipt timed out');
        evidence.stage = 'validate';
        validateReceipt(result, { ...manifest, after: evidence.after });
        if (result.platform !== 'android' || result.environment !== 'physical')
          throw new Error('expected physical Android');
        evidence.runId = result.runId;
        evidence.stage = 'installed-apk';
        evidence.installedHashAfter = adb(['shell', 'sha256sum', options.installedPath]).split(
          /\s+/,
        )[0];
        if (evidence.installedHashAfter !== apkSha256)
          throw new Error('installed APK differs from frozen benchmark APK');
        evidence.stage = 'receipt-write';
        await host.save(`launch-${index + 1}.json`, json(result));
        receipts.push(result);
        evidence.status = 'complete';
      } catch (error) {
        launchFailed = true;
        launchFailure = error;
        evidence.status = 'failed';
        evidence.reason = message(error);
      } finally {
        provenance.push(evidence);
        const persist = () =>
          Promise.allSettled([
            host.save(`launch-${index + 1}.log`, log),
            host.save(`launch-${index + 1}-provenance.json`, json(evidence)),
            host.save('provenance.json', json(provenance)),
          ]);
        const errors = (await persist()).filter(
          (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
        );
        if (errors.length) {
          evidence.evidenceErrors = errors.map((entry) => message(entry.reason));
          evidence.status = 'failed';
          if (!launchFailed) {
            launchFailed = true;
            launchFailure = errors[0].reason;
            evidence.reason = message(launchFailure);
          }
          // Attempt remaining evidence independently; a disk error must not mask the primary error.
          await persist();
        }
      }
      if (launchFailed) throw launchFailure;
    }
    summary = {
      ...environment,
      batteryAfter: host.adb(['shell', 'dumpsys', 'battery']),
      results: aggregate(receipts, manifest),
    };
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      host.adb(['shell', 'am', 'force-stop', appId]);
    } catch (error) {
      cleanupError = message(error);
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
    const saved = await Promise.allSettled([
      host.save('environment.json', json(environment)),
      host.save(
        'collection-status.json',
        json({
          status: failed ? 'failed' : 'pending',
          reason: failed ? message(failure) : undefined,
          cleanupError,
          completedLaunches: receipts.length,
        }),
      ),
    ]);
    const writeError = saved.find(
      (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
    );
    if (writeError && !failed) {
      failed = true;
      failure = writeError.reason;
    }
  }
  if (failed) throw failure;
  // Keep pending until the summary is saved; interruption must not leave false success.
  try {
    await host.save('summary.json', json(summary));
  } catch (error) {
    await Promise.allSettled([
      host.save(
        'collection-status.json',
        json({
          status: 'failed',
          stage: 'summary-write',
          reason: message(error),
          completedLaunches: receipts.length,
        }),
      ),
    ]);
    throw error;
  }
  await host.save(
    'collection-status.json',
    json({ status: 'complete', completedLaunches: receipts.length }),
  );
}

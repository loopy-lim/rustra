import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectBenchmarkSource } from './host-benchmark-provenance.mjs';
import {
  captureProducerArtifact,
  openReceiptTarget,
  scaffoldNativeArtifactPath,
  stampProducerStability,
  writeOnboardingReceipt,
} from './onboarding-receipt.mjs';
import { runQuickStart } from './quick-start.mjs';
import { mutateScaffoldProject } from './onboarding-gate.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
async function until(predicate, description) {
  const deadline = performance.now() + 60_000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${description}`);
    await pause(25);
  }
}

/** A real watcher, compiler failure and fresh Rust invocations; no injected watcher or compiler. */
export async function runWatchJourney(
  { host = 'node', output },
  repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
) {
  assert.ok(['node', 'bun'].includes(host), 'host must be node or bun');
  output = openReceiptTarget({
    requested: output,
    defaultName: `watch-${host}-${Date.now()}-${process.pid}.json`,
    repo,
  });
  mkdirSync(dirname(output), { recursive: true });
  const sourceBefore = collectBenchmarkSource(repo);
  const producerBefore = captureProducerArtifact(repo);
  const started = performance.now();
  const events = [];
  const stamp = (type, details = {}) => {
    const event = { type, afterMs: performance.now() - started, ...details };
    events.push(event);
    return event;
  };
  const receipt = {
    schemaVersion: 1,
    evidence: 'local-watch-rust-runtime',
    consumption: 'source-injected',
    host,
    ok: false,
    events,
    measurements: {},
    artifacts: [],
    sourceBefore,
    producerBefore,
  };
  let handle;
  const originalLog = console.log;
  const originalError = console.error;
  const consoleOutput = (stream, values) => {
    const text = values.map(String).join(' ');
    stamp('dev-log', { stream, text });
    (stream === 'stdout' ? originalLog : originalError)(...values);
  };
  let scenario = null;
  let calls = 0;
  const failures = () =>
    events.filter(
      (event) => event.type === 'dev-log' && event.text.includes('[dev] regeneration failed:'),
    );
  try {
    const setupPath = runQuickStart(
      {
        host,
        manager: 'bun',
        cold: true,
        clean: false,
        measure: false,
        output: `${output}.setup.json`,
      },
      repo,
    );
    const setup = JSON.parse(readFileSync(setupPath, 'utf8'));
    assert.equal(setup.ok, true);
    receipt.setupReceipt = setupPath;
    receipt.projectDir = setup.projectDir;
    receipt.environment = setup.environment;
    receipt.cache = setup.cache;
    const app = setup.projectDir;
    const configPath = join(app, 'rustra.json');
    const manifestPath = join(app, 'package.json');
    const sourcePath = join(app, 'src/lib.rs');
    const failurePath = host === 'node' ? join(app, 'src/main.rs') : sourcePath;
    const applicationPath = join(app, 'src/index.ts');
    const originalSource = readFileSync(sourcePath, 'utf8');
    const originalApplication = readFileSync(applicationPath, 'utf8');
    const originalFailureSource = readFileSync(failurePath, 'utf8');
    const configHash = digest(configPath);
    const manifestHash = digest(manifestPath);
    const contractPath = join(app, 'src/generated/contract.ts');
    const nativePath = join(setup.cache.cargoTargetDir, scaffoldNativeArtifactPath(host));
    const snapshot = (phase) => {
      const value = {
        phase,
        nativeSha256: digest(nativePath),
        contractSha256: digest(contractPath),
        rustSourceSha256: digest(sourcePath),
        configSha256: digest(configPath),
        manifestSha256: digest(manifestPath),
      };
      receipt.artifacts.push(value);
      return value;
    };
    const invoke = () => {
      const result = spawnSync('bun', ['run', 'demo'], { cwd: app, encoding: 'utf8' });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      return result.stdout.trim();
    };
    console.log = (...values) => consoleOutput('stdout', values);
    console.error = (...values) => consoleOutput('stderr', values);
    const { runDev } = await import(pathToFileURL(join(repo, 'packages/cli/dist/dev.js')).href);
    handle = await runDev(['--config', configPath]);
    // Drain any first-build dep-info discovery before measuring a user edit.
    await pause(900);
    assert.equal(failures().length, 0, 'initial dev build must succeed');
    const initial = snapshot('initial');
    assert.equal(invoke(), 'hello from TypeScript');
    handle.onReload((reason) => {
      if (!scenario) return;
      calls++;
      try {
        const value = invoke();
        const event = stamp('rust-call', { scenario: scenario.name, reason, value });
        assert.equal(value, scenario.expected, 'reload must use the changed Rust implementation');
        scenario.result = event;
      } catch (error) {
        scenario.error = error;
      }
    });
    const complete = async () => {
      await until(() => scenario.result || scenario.error, scenario.name);
      if (scenario.error) throw scenario.error;
      return scenario.result;
    };
    const changed = originalSource.replace(
      'message: input.message',
      'message: input.message.to_uppercase()',
    );
    assert.notEqual(changed, originalSource, 'scaffold implementation anchor');
    scenario = { name: 'implementation-change', expected: 'HELLO FROM TYPESCRIPT' };
    const edit = stamp('source-edit', { scenario: scenario.name });
    writeFileSync(sourcePath, changed);
    const updatedCall = await complete();
    const firstWatchRun = events.find(
      (event) =>
        event.afterMs >= edit.afterMs &&
        event.type === 'dev-log' &&
        event.text.startsWith('[dev] ') &&
        event.text.includes(' → codegen'),
    );
    assert.ok(firstWatchRun, 'watch detection must start the build');
    receipt.measurements.watchMutationToCallMs = updatedCall.afterMs - edit.afterMs;
    receipt.measurements.watchRunStartToCallMs = updatedCall.afterMs - firstWatchRun.afterMs;
    receipt.measurements.editToWatchRunStartMs = firstWatchRun.afterMs - edit.afterMs;
    const updated = snapshot('implementation-change');
    assert.equal(
      updated.contractSha256,
      initial.contractSha256,
      'implementation-only changes preserve the contract',
    );
    assert.notEqual(
      updated.nativeSha256,
      initial.nativeSha256,
      'implementation changes must relink the runtime',
    );

    scenario = {
      name: 'compile-failure',
      expected: 'reload must not run during a compile failure',
    };
    const callsBeforeFailure = calls;
    const failuresBefore = failures().length;
    const broken = stamp('compile-error-written');
    if (host === 'node') {
      // The generator can succeed while only the invoke binary fails. Exercise
      // this partial-publication boundary with an actual contract change too.
      writeFileSync(sourcePath, originalSource);
      mutateScaffoldProject(app);
    }
    writeFileSync(
      failurePath,
      `${readFileSync(failurePath, 'utf8')}\ncompile_error!("onboarding watch recovery probe");\n`,
    );
    await until(() => failures().length > failuresBefore, 'compile failure diagnostic');
    const failure = failures().at(-1);
    await pause(700);
    assert.equal(
      calls,
      callsBeforeFailure,
      'a failed build must not notify the host to reuse stale artifacts',
    );
    const rejected = snapshot('compile-failure');
    assert.equal(
      rejected.nativeSha256,
      updated.nativeSha256,
      'failed compilation preserves the last good binary',
    );
    if (host === 'node')
      assert.notEqual(
        rejected.contractSha256,
        updated.contractSha256,
        'schema can advance before the runtime build fails',
      );
    receipt.measurements.failureDetectionMs = failure.afterMs - broken.afterMs;
    receipt.reloadsDuringFailure = calls - callsBeforeFailure;
    scenario = { name: 'compile-recovery', expected: 'HELLO FROM TYPESCRIPT' };
    const repair = stamp('source-repaired');
    writeFileSync(applicationPath, originalApplication);
    // Restore the exact last successful source, not a third distinct version.
    // A failed build must not let that old fingerprint bless newly generated,
    // incompatible schema files and skip the required recovery generation.
    writeFileSync(sourcePath, changed);
    if (failurePath !== sourcePath) writeFileSync(failurePath, originalFailureSource);
    const recoveredCall = await complete();
    const recovered = snapshot('compile-recovery');
    assert.equal(recovered.contractSha256, updated.contractSha256);
    receipt.measurements.repairToCallMs = recoveredCall.afterMs - repair.afterMs;
    receipt.measurements.failureToRecoveredCallMs = recoveredCall.afterMs - failure.afterMs;

    scenario = {
      name: 'contract-change',
      expected: '{"message":"hello from TypeScript","repeat":3}',
    };
    const contractEdit = stamp('contract-edited');
    writeFileSync(sourcePath, originalSource);
    mutateScaffoldProject(app);
    writeFileSync(
      applicationPath,
      readFileSync(applicationPath, 'utf8').replace(
        'console.log(result.message)',
        'console.log(JSON.stringify(result))',
      ),
    );
    const contractCall = await complete();
    const contract = snapshot('contract-change');
    assert.notEqual(contract.contractSha256, recovered.contractSha256);
    assert.notEqual(contract.nativeSha256, recovered.nativeSha256);
    receipt.measurements.contractMutationToCallMs = contractCall.afterMs - contractEdit.afterMs;
    assert.equal(digest(configPath), configHash, 'watch preserves rustra.json');
    assert.equal(
      digest(manifestPath),
      manifestHash,
      'watch preserves package scripts and settings',
    );
    receipt.ok = true;
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await handle?.dispose();
    console.log = originalLog;
    console.error = originalError;
    receipt.sourceAfter = collectBenchmarkSource(repo);
    receipt.sourceStable =
      receipt.sourceBefore.sourceTreeHash === receipt.sourceAfter.sourceTreeHash;
    stampProducerStability(repo, receipt);
    receipt.timing =
      'monotonic; edit-to-run includes polling and debounce; calls launch a fresh Bun process; failure-to-recovery includes a 700ms no-reload observation';
    writeOnboardingReceipt(output, receipt);
    console.log(`[onboarding:watch] receipt: ${output}`);
  }
  return output;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!['--host', '--output'].includes(key) || !value || value.startsWith('--'))
      throw new Error(
        'Usage: node scripts/onboarding-watch.mjs [--host node|bun] [--output receipt.json]',
      );
    options[key.slice(2)] = value;
  }
  await runWatchJourney(options);
}

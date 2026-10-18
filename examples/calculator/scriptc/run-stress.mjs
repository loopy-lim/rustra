import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sanitize = process.argv.includes('--sanitize');
const countFlag = process.argv.slice(2).find((value) => value.startsWith('--runs='));
const runs = countFlag ? Number(countFlag.slice(7)) : 5;
const unknown = process.argv
  .slice(2)
  .filter((value) => value !== '--sanitize' && value !== countFlag);
if (unknown.length || !Number.isInteger(runs) || runs < 1 || runs > 100) {
  throw new Error('usage: node run-stress.mjs [--sanitize] [--runs=1..100]');
}
const mode = sanitize ? 'sanitize' : 'release';
const buildRoot = resolve(root, 'target/scriptc-stress', `${process.platform}-${process.arch}`);
const output = resolve(buildRoot, mode);
mkdirSync(output, { recursive: true });
const receipt = {
  recordedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  mode,
  runs,
  status: 'running',
  sanitizerScope: sanitize
    ? 'scriptc generated code/runtime ASan + RC audit; Rust staticlib release'
    : 'none',
  commands: [],
  sourceHashes: {},
};
function hash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function run(command, args, label, timeout = 120_000, expectAsan = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    detached: process.platform !== 'win32',
    killSignal: 'SIGKILL',
  });
  if (result.error && result.pid && process.platform !== 'win32') {
    try {
      process.kill(-result.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  writeFileSync(resolve(output, `${label}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  receipt.commands.push({
    command,
    args,
    label,
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message,
    expectAsan,
  });
  const accepted = expectAsan
    ? result.status !== 0 &&
      /ERROR: AddressSanitizer: heap-use-after-free/.test(result.stderr ?? '')
    : result.status === 0;
  if (result.error || !accepted) {
    process.stderr.write(result.stderr ?? '');
    throw new Error(
      `${label} failed (${result.error?.message ?? result.signal ?? result.status}); see ${output}/${label}.log`,
    );
  }
  return result.stdout.trim();
}
try {
  const pin = /SCRIPTC_VERSION=([0-9.]+)/.exec(
    readFileSync(resolve(root, 'examples/calculator/scriptc/run.sh'), 'utf8'),
  )?.[1];
  const direct = spawnSync('scriptc', ['--version'], { encoding: 'utf8', timeout: 10_000 });
  // scriptc 는 engines: node >=24 라 로컬 PATH 에 없으면 fnm 26 으로 폴백한다
  // (run.sh 와 같은 규약 — CI ts-runtime 은 setup-node 26 으로 이미 PATH 를 갖춘다).
  const compiler = direct.error?.code === 'ENOENT' ? 'fnm' : 'scriptc';
  const prefix = compiler === 'fnm' ? ['exec', '--using', '26', '--', 'scriptc'] : [];
  const version = run(compiler, [...prefix, '--version'], 'compiler-version', 10_000);
  if (!pin || version !== pin) throw new Error(`scriptc ${pin} required, received ${version}`);
  receipt.scriptc = version;
  receipt.head = run('git', ['rev-parse', 'HEAD'], 'head', 10_000);
  receipt.rustc = run('rustc', ['-Vv'], 'rustc', 10_000);
  const inputs = [
    'examples/calculator/apps/scriptc-stress.ts',
    'examples/calculator/scriptc/stress-controls.ts',
    'examples/calculator/scriptc/run-stress.mjs',
    'examples/calculator/scriptc/ffi.json',
    'examples/calculator/scriptc/scriptc-ffi.ts',
    'examples/calculator/scriptc/stress-fixture/Cargo.toml',
    'examples/calculator/scriptc/stress-fixture/Cargo.lock',
    'examples/calculator/scriptc/stress-fixture/src/lib.rs',
    'examples/calculator/scriptc/stress-fixture/asan-canary.c',
    'crates/rustra/src/ffi_scriptc.rs',
    'crates/rustra/src/ffi_event_core.rs',
    'crates/rustra/src/ffi_channel.rs',
    'crates/rustra/src/ffi_async_entries.rs',
    'crates/rustra/src/ffi_workers.rs',
    'crates/rustra/src/ffi_pool.rs',
  ];
  for (const input of inputs) receipt.sourceHashes[input] = hash(resolve(root, input));
  if (sanitize) {
    // Fail at the smallest reproducible boundary when ASan cannot initialize.
    // A real invalid C allocation then proves this runtime detects a defect.
    const helloSource = resolve(output, 'sanitizer-hello.ts');
    const helloBinary = resolve(output, 'sanitizer-hello');
    writeFileSync(helloSource, "console.log('scriptc sanitizer startup PASS');\n");
    run(
      compiler,
      [...prefix, 'build', helloSource, '--sanitize', '-o', helloBinary],
      'hello-build',
    );
    const hello = run(helloBinary, [], 'hello-run', 5_000);
    if (hello !== 'scriptc sanitizer startup PASS')
      throw new Error('ASan hello did not reach script main');
    const canaryObject = resolve(output, 'asan-canary.o');
    const canaryArchive = resolve(output, 'libasan-canary.a');
    run(
      'clang',
      [
        '-O0',
        '-g',
        '-fsanitize=address',
        '-fno-omit-frame-pointer',
        '-c',
        'examples/calculator/scriptc/stress-fixture/asan-canary.c',
        '-o',
        canaryObject,
      ],
      'canary-c-build',
    );
    run('ar', ['rcs', canaryArchive, canaryObject], 'canary-archive');
    const canaryManifest = resolve(output, 'canary-ffi.json');
    writeFileSync(
      canaryManifest,
      JSON.stringify({
        ffi_format: 7,
        functions: [
          {
            name: 'rustra_stress_asan_canary',
            symbol: 'rustra_stress_asan_canary',
            params: [],
            returns: 'u32',
          },
        ],
        libraries: [canaryArchive],
        system_libraries: [],
      }),
    );
    const canarySource = resolve(output, 'sanitizer-canary.ts');
    const canaryBinary = resolve(output, 'sanitizer-canary');
    writeFileSync(
      canarySource,
      'export declare function rustra_stress_asan_canary(): number;\nconsole.log(rustra_stress_asan_canary());\n',
    );
    run(
      compiler,
      [...prefix, 'build', canarySource, '--ffi', canaryManifest, '--sanitize', '-o', canaryBinary],
      'canary-native-build',
    );
    run(canaryBinary, [], 'canary-run', 5_000, true);
    receipt.canary = 'heap-use-after-free detected';
  }
  run(
    'cargo',
    [
      'build',
      '--locked',
      '--release',
      '--manifest-path',
      'examples/calculator/scriptc/stress-fixture/Cargo.toml',
      '--target-dir',
      buildRoot,
    ],
    'fixture-build',
  );
  const archive = resolve(buildRoot, 'release/librustra_scriptc_stress_fixture.a');
  receipt.archiveSha256 = hash(archive);
  // Reuse every production callback descriptor. Only the linked fixture and its
  // private scheduling controls differ; generated/public declarations stay intact.
  const manifest = JSON.parse(
    readFileSync(resolve(root, 'examples/calculator/scriptc/ffi.json'), 'utf8'),
  );
  manifest.libraries = [archive];
  for (const [name, returns] of [
    ['rustra_stress_wait_workers', 'bool'],
    ['rustra_stress_release_workers', 'void'],
    ['rustra_stress_handler_calls', 'u32'],
  ])
    manifest.functions.push({ name, symbol: name, params: [], returns });
  const manifestPath = resolve(output, 'stress-ffi.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const binary = resolve(output, 'scriptc-stress');
  run(
    compiler,
    [
      ...prefix,
      'build',
      'examples/calculator/apps/scriptc-stress.ts',
      '--ffi',
      manifestPath,
      ...(sanitize ? ['--sanitize'] : []),
      '-o',
      binary,
    ],
    'native-build',
  );
  receipt.binarySha256 = hash(binary);
  const expected = 'scriptc stress PASS cycles=64 copied=192 events=128 cancelled=64 late=0';
  for (let index = 1; index <= runs; index += 1) {
    const stdout = run(binary, [], `run-${index}`, 15_000);
    if (stdout.split('\n').filter((line) => line === expected).length !== 1) {
      throw new Error(`run-${index} did not produce exactly one complete stress result`);
    }
    console.log(`scriptc stress ${mode} ${index}/${runs}: PASS`);
  }
  const changed = inputs.filter(
    (input) => receipt.sourceHashes[input] !== hash(resolve(root, input)),
  );
  receipt.changedInputs = changed;
  if (changed.length) throw new Error(`source changed during validation: ${changed.join(', ')}`);
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed';
  receipt.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  writeFileSync(resolve(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`scriptc stress receipt: ${output}/receipt.json`);
}

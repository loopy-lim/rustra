import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { renderReactNativeModule } from './react-native.js';

function fixture(manifest: Record<string, unknown> = {}) {
  const appRoot = realpathSync(mkdtempSync(join(tmpdir(), 'rustra-rn-host with spaces-')));
  const moduleDir = join(appRoot, 'native modules/bridge');
  const options = { appRoot, moduleDir, adapterRange: '^0.9.0' };
  const write = (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  write(join(appRoot, 'package.json'), JSON.stringify({ private: true, ...manifest }));
  const adapter = join(appRoot, 'node_modules/@rustra/react-native');
  write(
    join(adapter, 'package.json'),
    JSON.stringify({ name: '@rustra/react-native', version: '0.9.0' }),
  );
  for (const path of [
    'android/rustra-jsi-jni.cpp',
    'cpp/RustraJSIBridge.cpp',
    'cpp/RustraJSIBridge.hpp',
    'cpp/rustra-codec.hpp',
    'ios/RustraJSIModule.mm',
  ]) {
    write(join(adapter, 'native', path), 'fixture');
  }
  function generate() {
    const files = renderReactNativeModule({
      ...options,
      cppOutputPath: join(moduleDir, 'generated'),
      rustManifestPath: join(appRoot, 'Cargo.toml'),
      rustPackage: 'app',
      rustLibrary: 'app',
    });
    const script = files['scripts/prepare-native.cjs'];
    assert.ok(script, 'codegen must supply an executable native preparation entry');
    for (const [path, content] of Object.entries(files)) write(join(moduleDir, path), content);
    return join(moduleDir, 'scripts/prepare-native.cjs');
  }
  const log = join(appRoot, 'steps.jsonl');
  const record = String.raw`require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)})+'\n');`;
  function executable(path: string, body = record) {
    write(path, `#!${process.execPath}\n${body}\n`);
    chmodSync(path, 0o755);
  }
  function run(script: string, platform: string) {
    return spawnSync(process.execPath, [script, platform], {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(appRoot, 'bin')}:${process.env.PATH}` },
    });
  }
  const steps = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  return {
    ...options,
    write,
    generate,
    log,
    record,
    executable,
    run,
    steps,
    cleanup: () => rmSync(appRoot, { recursive: true, force: true }),
  };
}

test('generated native preparation runs Pods from the existing app iOS directory', () => {
  const f = fixture();
  try {
    f.write(join(f.appRoot, 'ios/Podfile'), '# existing user Podfile');
    f.executable(join(f.appRoot, 'bin/pod'));
    const result = f.run(f.generate(), 'ios');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.steps(), [{ cwd: join(f.appRoot, 'ios'), args: ['install'] }]);
    assert.equal(readFileSync(join(f.appRoot, 'ios/Podfile'), 'utf8'), '# existing user Podfile');
    assert.match(result.stdout, /rebuild|run-ios/);
  } finally {
    f.cleanup();
  }
});

test('generated native preparation honors the app Gemfile without installing gems', () => {
  const f = fixture();
  try {
    f.write(join(f.appRoot, 'Gemfile'), "gem 'cocoapods'");
    f.write(join(f.appRoot, 'ios/Podfile'), '# user Podfile');
    f.executable(join(f.appRoot, 'bin/bundle'));
    const result = f.run(f.generate(), 'ios');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.steps(), [
      { cwd: join(f.appRoot, 'ios'), args: ['exec', 'pod', 'install'] },
    ]);
  } finally {
    f.cleanup();
  }
});

test('generated Expo preparation creates only the absent requested native project before Pods', () => {
  const f = fixture({ dependencies: { expo: '~54.0.0' } });
  try {
    f.write(join(f.appRoot, 'node_modules/expo/package.json'), JSON.stringify({ name: 'expo' }));
    f.executable(
      join(f.appRoot, 'node_modules/expo/bin/cli'),
      `${f.record}require('node:fs').mkdirSync('ios');require('node:fs').writeFileSync('ios/Podfile','# generated');`,
    );
    f.executable(join(f.appRoot, 'bin/pod'));
    const script = f.generate();
    assert.equal(f.run(script, 'ios').status, 0);
    assert.equal(f.run(script, 'ios').status, 0);
    assert.deepEqual(f.steps(), [
      { cwd: f.appRoot, args: ['prebuild', '--platform', 'ios', '--no-install'] },
      { cwd: join(f.appRoot, 'ios'), args: ['install'] },
      { cwd: join(f.appRoot, 'ios'), args: ['install'] },
    ]);
    assert.equal(existsSync(join(f.appRoot, 'android')), false);
  } finally {
    f.cleanup();
  }
});

test('generated Android preparation builds without device installation or SDK downloads', () => {
  const f = fixture();
  try {
    f.executable(join(f.appRoot, 'android/gradlew'));
    const result = f.run(f.generate(), 'android');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.steps(), [
      {
        cwd: join(f.appRoot, 'android'),
        args: [':app:assembleDebug', '--no-daemon', '-Pandroid.builder.sdkDownload=false'],
      },
    ]);
  } finally {
    f.cleanup();
  }
});

test('generated preparation does not replace an existing partial native project', () => {
  const f = fixture({ dependencies: { expo: '~54.0.0' } });
  try {
    f.write(join(f.appRoot, 'ios/user-file'), 'preserve');
    const result = f.run(f.generate(), 'ios');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Podfile|existing.*ios/);
    assert.equal(readFileSync(join(f.appRoot, 'ios/user-file'), 'utf8'), 'preserve');
    assert.deepEqual(f.steps(), []);
  } finally {
    f.cleanup();
  }
});

test('generated preparation stops on tool failure and gives the failing native step', () => {
  const f = fixture();
  try {
    f.write(join(f.appRoot, 'ios/Podfile'), '# user Podfile');
    f.executable(join(f.appRoot, 'bin/pod'), 'process.exit(7);');
    const result = f.run(f.generate(), 'ios');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /pod.*install.*7/);
    assert.doesNotMatch(result.stdout, /Next:/);
  } finally {
    f.cleanup();
  }
});

test('RN host scripts preserve existing commands and remain byte-identical on repeat', async () => {
  const { prepareReactNativeHost } = await import('./react-native-host.js');
  const f = fixture({
    scripts: { ios: 'user ios', 'rustra:ios': 'custom setup', test: 'user test' },
  });
  try {
    f.generate();
    const result = await prepareReactNativeHost(f);
    const path = join(f.appRoot, 'package.json');
    const first = readFileSync(path, 'utf8');
    const scripts = JSON.parse(first).scripts;
    assert.equal(scripts.ios, 'user ios');
    assert.equal(scripts['rustra:ios'], 'custom setup');
    assert.equal(scripts.test, 'user test');
    assert.match(scripts['rustra:android'], /prepare-native\.cjs/);
    assert.equal(result.conflicts[0]?.name, 'rustra:ios');
    assert.equal(result.changedFiles.length, 1);
    assert.deepEqual((await prepareReactNativeHost(f)).changedFiles, []);
    assert.equal(readFileSync(path, 'utf8'), first);
  } finally {
    f.cleanup();
  }
});

test('RN bootstrap declares only the missing adapter before initial installation', async () => {
  const { ensureReactNativeAdapter } = await import('./react-native-host.js');
  const f = fixture({
    scripts: { postinstall: 'user install' },
    dependencies: { react: '19.1.0' },
  });
  try {
    rmSync(join(f.appRoot, 'node_modules'), { recursive: true });
    const result = await ensureReactNativeAdapter(f);
    const manifest = JSON.parse(readFileSync(join(f.appRoot, 'package.json'), 'utf8'));
    assert.equal(result.needsInstall, true);
    assert.deepEqual(manifest.dependencies, { react: '19.1.0', '@rustra/react-native': '^0.9.0' });
    assert.equal(manifest.scripts.postinstall, 'user install');
    assert.equal(manifest.workspaces, undefined);
  } finally {
    f.cleanup();
  }
});

test('RN bootstrap preserves local adapter dependency and skips already complete installation', async () => {
  const { ensureReactNativeAdapter } = await import('./react-native-host.js');
  const f = fixture({ dependencies: { '@rustra/react-native': 'file:../custom-adapter' } });
  try {
    const raw = readFileSync(join(f.appRoot, 'package.json'), 'utf8');
    assert.equal((await ensureReactNativeAdapter(f)).needsInstall, false);
    assert.equal(readFileSync(join(f.appRoot, 'package.json'), 'utf8'), raw);
  } finally {
    f.cleanup();
  }
});

test('RN bootstrap refuses stale missing generated workspace before any manifest rewrite', async () => {
  const { ensureReactNativeAdapter } = await import('./react-native-host.js');
  const f = fixture({ dependencies: { '@rustra/generated-react-native': 'workspace:*' } });
  try {
    rmSync(join(f.appRoot, 'node_modules'), { recursive: true });
    const raw = readFileSync(join(f.appRoot, 'package.json'), 'utf8');
    await assert.rejects(ensureReactNativeAdapter(f), /generated.*missing|missing.*generated/i);
    assert.equal(readFileSync(join(f.appRoot, 'package.json'), 'utf8'), raw);
    assert.equal(existsSync(join(f.moduleDir, 'package.json')), false);
  } finally {
    f.cleanup();
  }
});

test('RN preparation runs through its installed generated package script', async () => {
  const { prepareReactNativeHost } = await import('./react-native-host.js');
  const f = fixture();
  try {
    f.generate();
    symlinkSync(f.moduleDir, join(f.appRoot, 'node_modules/@rustra/generated-react-native'));
    f.write(join(f.appRoot, 'ios/Podfile'), '# user Podfile');
    f.executable(join(f.appRoot, 'bin/pod'));
    await prepareReactNativeHost(f);
    const command = JSON.parse(readFileSync(join(f.appRoot, 'package.json'), 'utf8')).scripts[
      'rustra:ios'
    ];
    const result = spawnSync('sh', ['-c', command], {
      cwd: f.appRoot,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(f.appRoot, 'bin')}:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.steps(), [{ cwd: join(f.appRoot, 'ios'), args: ['install'] }]);
  } finally {
    f.cleanup();
  }
});

test('RN host script conflicts leave the original manifest bytes untouched', async () => {
  const { prepareReactNativeHost } = await import('./react-native-host.js');
  const f = fixture({
    scripts: { 'rustra:ios': 'custom ios', 'rustra:android': 'custom android' },
  });
  try {
    f.generate();
    const raw = readFileSync(join(f.appRoot, 'package.json'), 'utf8');
    const result = await prepareReactNativeHost(f);
    assert.equal(result.conflicts.length, 2);
    assert.deepEqual(result.changedFiles, []);
    assert.equal(readFileSync(join(f.appRoot, 'package.json'), 'utf8'), raw);
  } finally {
    f.cleanup();
  }
});

test('RN bootstrap rejects malformed dependency objects before rewriting package.json', async () => {
  const { ensureReactNativeAdapter } = await import('./react-native-host.js');
  const f = fixture({ dependencies: 'preserve malformed user data' });
  try {
    rmSync(join(f.appRoot, 'node_modules'), { recursive: true });
    const raw = readFileSync(join(f.appRoot, 'package.json'), 'utf8');
    await assert.rejects(ensureReactNativeAdapter(f), /dependencies.*object/);
    assert.equal(readFileSync(join(f.appRoot, 'package.json'), 'utf8'), raw);
  } finally {
    f.cleanup();
  }
});

test('RN bootstrap rejects an installed incompatible adapter without altering declared dependencies', async () => {
  const { ensureReactNativeAdapter } = await import('./react-native-host.js');
  const f = fixture({ dependencies: { '@rustra/react-native': '^0.8.0' } });
  try {
    f.write(
      join(f.appRoot, 'node_modules/@rustra/react-native/package.json'),
      JSON.stringify({ name: '@rustra/react-native', version: '0.8.0' }),
    );
    const raw = readFileSync(join(f.appRoot, 'package.json'), 'utf8');
    await assert.rejects(ensureReactNativeAdapter(f), /incompatible.*expected \^0\.9\.0/);
    assert.equal(readFileSync(join(f.appRoot, 'package.json'), 'utf8'), raw);
  } finally {
    f.cleanup();
  }
});

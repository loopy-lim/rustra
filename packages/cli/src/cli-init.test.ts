import assert from 'node:assert/strict';
import test from 'node:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInit } from './cli-init.js';
import { UsageError } from './cli-usage-error.js';
import { readConfigSync } from './config.js';
import {
  INIT_CONFIG_SCHEMA_PATH,
  renderInitProjectFiles,
  templateVersions,
} from './init-template.js';
import { runGenerate } from './cli-generate.js';
import { cliManifest } from './cli-runtime.js';

function withTempDir(fn: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'rustra-init-'));
  return Promise.resolve(fn(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

/** RN 어댑터 설치 픽스처 — 감사 A11 이후 RN 코드젠은 어댑터 설치(bun install)가
 * 선행해야 loud-fail 하지 않는다. cliManifest 의 range 를 만족하는 버전으로 심는다. */
function seedReactNativeAdapter(project: string): void {
  const version = cliManifest.rustraTemplate.reactNativeRange.replace(/^[~^=]/, '');
  const nativeRoot = join(project, 'node_modules', '@rustra', 'react-native', 'native');
  for (const file of [
    'android/rustra-jsi-jni.cpp',
    'cpp/RustraJSIBridge.cpp',
    'cpp/RustraJSIBridge.hpp',
    'cpp/rustra-codec.hpp',
    'ios/RustraJSIModule.mm',
  ]) {
    mkdirSync(join(nativeRoot, ...file.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(nativeRoot, ...file.split('/')), 'adapter fixture');
  }
  writeFileSync(
    join(project, 'node_modules', '@rustra', 'react-native', 'package.json'),
    JSON.stringify({ name: '@rustra/react-native', version }),
  );
}

test('runInit refuses to overwrite an existing scaffold and --force replaces it', async () => {
  await withTempDir(async (root) => {
    const project = join(root, 'app');
    await runInit([project]);
    // 2회째 — 존재하는 파일 차단
    await assert.rejects(() => runInit([project]), /Refusing to overwrite.*Cargo\.toml/);
    await assert.rejects(() => runInit([project]), /--force/);
    // --force로 재생성 통과 + 파일이 여전히 유효한 스캐폴드인지
    await runInit([project, '--force']);
    const packageJson = JSON.parse(readFileSync(join(project, 'package.json'), 'utf-8'));
    assert.equal(packageJson.name, 'rustra-app');
    assert.equal(packageJson.scripts.dev, 'rustra dev --config rustra.json');
  });
});

test('runInit does not treat --force-style unknown flags as positionals', async () => {
  await withTempDir(async (root) => {
    // 오타 플래그는 positional로 흡수되지 않고 명확히 에러난다 (arg-parser 통일 계약)
    await assert.rejects(
      () => runInit([join(root, 'x'), '--forcee']),
      /Unknown init option: --forcee[\s\S]*--force/,
    );
  });
});

test('runInit rejects zero or multiple project directories', async () => {
  await withTempDir(async (root) => {
    await assert.rejects(() => runInit([]), /Provide one project directory/);
    await assert.rejects(
      () => runInit([join(root, 'a'), join(root, 'b')]),
      /Provide one project directory/,
    );
  });
});

test('runInit --help exits without creating anything', async () => {
  await withTempDir(async (root) => {
    // help 관례 통일 — 출력은 cli-main, runInit 은 도메인 검증 전에 조용히 돌아온다.
    // positional 이 없어도(또는 여러 개여도) help 가 우선한다.
    await runInit(['--help']);
    await runInit(['-h']);
    await runInit(['--help', join(root, 'a'), join(root, 'b')]);
    assert.equal(readdirSync(root).length, 0);
  });
});

test('existing foreign files unrelated to the scaffold do not block init', async () => {
  await withTempDir(async (root) => {
    const project = join(root, 'app');
    writeFileSync(join(root, 'unrelated.txt'), 'keep me');
    await runInit([project]);
    const fs = await import('node:fs');
    assert.equal(fs.readFileSync(join(root, 'unrelated.txt'), 'utf-8'), 'keep me');
    assert.ok(fs.existsSync(join(project, 'Cargo.toml')));
  });
});

/** 생성된 rustra.json 을 읽어 파싱 — 통합 게이트에서 readConfigSync 검증에 재사용한다. */
function readGeneratedConfig(project: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(project, 'rustra.json'), 'utf-8')) as Record<string, unknown>;
}

test('generated config carries a $schema reference to the shipped schema file', async () => {
  await withTempDir(async (root) => {
    const project = join(root, 'app');
    await runInit([project]);
    const config = readGeneratedConfig(project);
    assert.equal(config.$schema, INIT_CONFIG_SCHEMA_PATH);
    // 참조가 실제로 에디터에서 풀리는지 — 배포 패키지 루트의 스키마 파일과 이름이 일치해야 한다.
    assert.match(INIT_CONFIG_SCHEMA_PATH, /@rustra\/cli\/rustra\.schema\.json$/);
    const shippedSchema = fileURLToPath(new URL('../rustra.schema.json', import.meta.url));
    assert.ok(existsSync(shippedSchema), 'shipped rustra.schema.json must exist');
  });
});

test('node-only detection emits only the node host section and passes full config validation', async () => {
  await withTempDir(async (root) => {
    const project = join(root, 'app');
    await runInit([project]);
    const config = readGeneratedConfig(project);
    assert.deepEqual(config, {
      $schema: INIT_CONFIG_SCHEMA_PATH,
      schema: './generated/schema.json',
      output: './src/generated',
      node: {},
    });
    // 통합 게이트 — 생성물이 Task 6의 L1+L2 검증을 통과해야 한다.
    const loaded = readConfigSync(join(project, 'rustra.json'));
    assert.equal(loaded.schema, './generated/schema.json');
  });
});

test('Bun scaffold template selects the FFI host, dependency and native crate entry', () => {
  const hosts = { bun: true, bunRange: cliManifest.rustraTemplate.bunRange, reactNative: false };
  const files = renderInitProjectFiles(templateVersions('0.11.3', '^0.12.0', '^0.11.0'), hosts);
  const config = JSON.parse(files.rustraJson);
  const manifest = JSON.parse(files.packageJson);
  assert.deepEqual(config.bun, {});
  assert.equal(config.node, undefined);
  assert.equal(manifest.dependencies['@rustra/bun'], cliManifest.rustraTemplate.bunRange);
  assert.equal(manifest.dependencies['@rustra/node'], undefined);
  assert.match(files.cargoToml, /crate-type\s*=\s*\["rlib", "cdylib"\]/);
  assert.match(files.libRs, /rustra::native_entry!\(package\)/);
  assert.match(files.libRs, /OnceLock/);
  assert.match(files.appTs, /import \{ echo, rustra \} from '\.\/generated\/bun\.js'/);
  assert.match(files.appTs, /finally\s*\{\s*rustra\.dispose\(\)/);
});

test('Node and Bun scaffold templates offer setup/start and clean up the selected runtime', () => {
  for (const hosts of [{ reactNative: false }, { bun: true, reactNative: false }]) {
    const files = renderInitProjectFiles(templateVersions('0.11.3', '^0.12.0', '^0.11.0'), hosts);
    const manifest = JSON.parse(files.packageJson);
    assert.equal(manifest.scripts.setup, 'rustra setup --config rustra.json');
    assert.equal(manifest.scripts.start, 'rustra setup --config rustra.json --run');
    assert.match(files.appTs, /finally\s*\{\s*rustra\.dispose\(\)/);
  }
});

test('--host bun creates a validated Bun-only config and matching app entry', async () => {
  await withTempDir(async (root) => {
    const project = join(root, 'app');
    await runInit([project, '--host', 'bun']);
    const config = readConfigSync(join(project, 'rustra.json'));
    assert.deepEqual(config.bun, {});
    assert.equal(config.node, undefined);
    assert.equal(config.reactNative, undefined);
    assert.match(readFileSync(join(project, 'src/index.ts'), 'utf8'), /generated\/bun\.js/);
  });
});

test('init scaffolds remain standalone when nested inside another Cargo workspace', async () => {
  const { spawnSync } = await import('node:child_process');
  await withTempDir(async (root) => {
    writeFileSync(join(root, 'Cargo.toml'), '[workspace]\nmembers = []\nresolver = "2"\n');
    for (const host of ['node', 'bun', 'react-native']) {
      const project = join(root, 'apps', host);
      await runInit([project, '--host', host]);
      const result = spawnSync(
        'cargo',
        ['metadata', '--no-deps', '--offline', '--format-version', '1'],
        { cwd: project, encoding: 'utf8', timeout: 10_000 },
      );
      assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}`);
      const metadata = JSON.parse(result.stdout);
      assert.equal(realpathSync(metadata.workspace_root), realpathSync(project));
    }
  });
});

test('--host react-native includes the reactNative section and passes full config validation', async () => {
  await withTempDir(async (root) => {
    const project = join(root, 'app');
    await runInit([project, '--host', 'react-native']);
    const config = readGeneratedConfig(project);
    assert.equal(config.$schema, INIT_CONFIG_SCHEMA_PATH);
    assert.deepEqual(config.reactNative, { rustManifest: './Cargo.toml' });
    assert.ok('node' in config, 'node section must stay for the shared scaffold entrypoint');
    const loaded = readConfigSync(join(project, 'rustra.json'));
    assert.deepEqual(loaded.reactNative, { rustManifest: './Cargo.toml' });
  });
});

test('init rejects unknown --host values with the supported list', async () => {
  await withTempDir(async (root) => {
    await assert.rejects(
      () => runInit([join(root, 'x'), '--host', 'unsupported']),
      /Unknown init --host value "unsupported"[\s\S]*node, bun, react-native/,
    );
    // 오타는 closestMatch 관례대로 did-you-mean 을 고린다.
    await assert.rejects(
      () => runInit([join(root, 'x'), '--host', 'reactnative']),
      /Did you mean "react-native"\?/,
    );
  });
});

test('unknown --host is a UsageError (exit-2 contract, closed-enum violation)', async () => {
  // 닫힌 열거 외 값은 arg-parser 의 unknownValueError 와 동일한 exit-2 클래스다
  // (cli-usage-error.ts 헤더 경계 계약). exit 1 로의 되돌림을 잡는 핀.
  await withTempDir(async (root) => {
    await assert.rejects(() => runInit([join(root, 'x'), '--host', 'unsupported']), UsageError);
  });
});

test('--host node suppresses a detected react-native host and says so', async () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    await withTempDir(async (root) => {
      const project = join(root, 'app');
      mkdirSync(project, { recursive: true });
      writeFileSync(
        join(project, 'package.json'),
        JSON.stringify({ dependencies: { 'react-native-fs': '^2.0.0' } }),
      );
      await runInit([project, '--force', '--host', 'node']);
      // 감지를 억제한 오버라이드 분기 고정 — config 는 node-only.
      const config = readGeneratedConfig(project);
      assert.equal(config.reactNative, undefined);
      assert.deepEqual(config.node, {});
      // 안내 라인에 오버라이드 표시 — "왜 RN이 빠졌는지"가 한 눈에 보여야 한다.
      const hostLine = lines.find((line) => line.includes('Config host sections'));
      assert.match(hostLine ?? '', /node \(--host\)/);
      assert.doesNotMatch(hostLine ?? '', /react-native/);
    });
  } finally {
    console.log = originalLog;
  }
});

test('Next steps reduce the first call to entering the project, installing and starting', async () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    await withTempDir(async (root) => {
      await runInit([join(root, 'app')]);
    });
  } finally {
    console.log = originalLog;
  }
  const start = lines.findIndex((line) => line.includes('Next steps:'));
  assert.ok(start >= 0, 'Next steps block must be printed');
  const steps = lines
    .slice(start + 1)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.equal(steps.length, 3, 'setup owns the build/codegen sequence');
  assert.match(steps[0]!, /^cd /);
  assert.equal(steps[1], 'bun install');
  assert.equal(steps[2], 'bun run start');
});

test('react-native in the pre-existing package.json dependencies switches detection to RN', async () => {
  await withTempDir(async (root) => {
    const project = join(root, 'app');
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({ dependencies: { 'react-native-fs': '^2.0.0' } }),
    );
    // package.json 은 스캐폴드 파일이라 --force 가 필요 — 감지는 덮어쓰기 전 기존 매니페스트를 본다.
    await runInit([project, '--force']);
    const config = readGeneratedConfig(project);
    assert.deepEqual(config.reactNative, { rustManifest: './Cargo.toml' });
    const loaded = readConfigSync(join(project, 'rustra.json'));
    assert.ok(loaded.reactNative, 'detected RN config must pass full config validation');
  });
});

test('unscoped react-native dependency is detected and node-only deps are not', async () => {
  await withTempDir(async (root) => {
    const project = join(root, 'app');
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({ devDependencies: { 'react-native': '0.81.0', '@rustra/cli': '^0.6.0' } }),
    );
    await runInit([project, '--force']);
    assert.ok(readGeneratedConfig(project).reactNative);

    const plain = join(root, 'plain');
    mkdirSync(plain, { recursive: true });
    writeFileSync(
      join(plain, 'package.json'),
      JSON.stringify({ dependencies: { '@react-native/babel-preset': '^1.0.0' } }),
    );
    await runInit([plain, '--force']);
    assert.equal(readGeneratedConfig(plain).reactNative, undefined);
  });
});

test('pre-existing rustra.json still blocks init with the overwrite guidance', async () => {
  await withTempDir(async (root) => {
    const project = join(root, 'app');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'rustra.json'), '{"schema":"./s.json","output":"./out"}');
    await assert.rejects(() => runInit([project]), /Refusing to overwrite.*rustra\.json/);
    await assert.rejects(() => runInit([project]), /--force/);
    // 기존 config 파일은 init이 절대 손대지 않는다.
    assert.equal(
      readFileSync(join(project, 'rustra.json'), 'utf-8'),
      '{"schema":"./s.json","output":"./out"}',
    );
  });
});

test('a missing schema file gets an actionable hint instead of a raw ENOENT', async () => {
  await withTempDir(async (root) => {
    // ENOENT 랩 계약 — 스키마 부재는 프로젝트 상태 오류라 힌트를 붙이고 exit 1 이다
    // (UsageError 아님 — cli-usage-error.ts 의 exit-2 경계 밖).
    const missing = join(root, 'generated', 'schema.json');
    await assert.rejects(
      () =>
        runGenerate(['--schema', missing, '--output', join(root, 'out')], undefined, {
          quiet: true,
        }),
      (error: unknown) => {
        assert.ok(!(error instanceof UsageError));
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /Schema file not found/);
        assert.match(message, /Rust contract probe/);
        assert.match(message, /rustra generate/);
        assert.ok(!/ENOENT/.test(message), 'raw ENOENT must not leak to users');
        return true;
      },
    );
  });
});

/** codegen 게이트용 최소 스키마 — 실제 Rust generate 출력의 필수 형태만 갖춘다. */
function writeMinimalSchema(project: string): void {
  mkdirSync(join(project, 'generated'), { recursive: true });
  writeFileSync(
    join(project, 'generated', 'schema.json'),
    JSON.stringify({
      packageId: 'app.demo',
      commands: [
        {
          name: 'echo',
          inputType: 'EchoInput',
          outputType: 'EchoOutput',
          inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
          outputSchema: { type: 'object', properties: { message: { type: 'string' } } },
        },
      ],
    }),
  );
}

test(
  'RN scaffold passes the real codegen path — staticlib target exists and runGenerate succeeds',
  { timeout: 120_000 },
  async () => {
    await withTempDir(async (root) => {
      const project = join(root, 'app');
      // reactNative 섹션이 있으면 selectReactNativeCargoTarget 이 staticlib 크레이트를 요구한다.
      // 스캐폴드 Cargo.toml 에 [lib] staticlib 이 없던 결함을 잡는 게이트.
      await runInit([project, '--host', 'react-native']);
      const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf-8'));
      assert.equal(
        manifest.dependencies['@rustra/react-native'],
        cliManifest.rustraTemplate.reactNativeRange,
      );
      assert.match(
        readFileSync(join(project, 'Cargo.toml'), 'utf-8'),
        /crate-type\s*=\s*\["rlib", "staticlib"\]/,
      );
      writeMinimalSchema(project);
      // RN 코드젠 계약 — 어댑터는 bun install 로 먼저 설치돼 있다(감사 A11).
      seedReactNativeAdapter(project);
      // cargo metadata --no-deps (오프라인 OK) → resolveReactNativeScaffold → RN 모듈 렌더까지 전 경로.
      const written = await runGenerate(['--config', join(project, 'rustra.json')], undefined, {
        quiet: true,
      });
      assert.ok(
        written.some((file) => file.endsWith('react-native.ts')),
        `RN scaffold must emit the react-native entry, got: ${written.join(', ')}`,
      );
    });
  },
);

test(
  'node-only scaffold passes the real codegen path — lib target does not break node entries',
  { timeout: 120_000 },
  async () => {
    await withTempDir(async (root) => {
      const project = join(root, 'app');
      await runInit([project]);
      writeMinimalSchema(project);
      const written = await runGenerate(['--config', join(project, 'rustra.json')], undefined, {
        quiet: true,
      });
      assert.ok(written.some((file) => file.endsWith('node.ts')));
      assert.ok(
        !written.some((file) => file.endsWith('react-native.ts')),
        'node-only scaffold must not emit the react-native entry',
      );
    });
  },
);

test(
  'every generated file carries the self-describing header exactly once',
  { timeout: 120_000 },
  async () => {
    await withTempDir(async (root) => {
      const project = join(root, 'app');
      await runInit([project]);
      writeMinimalSchema(project);
      const written = await runGenerate(['--config', join(project, 'rustra.json')], undefined, {
        quiet: true,
      });
      const generatedDir = join(project, 'src', 'generated');
      const files = written.filter((file) => file.endsWith('.ts'));
      assert.ok(files.length >= 5, `expected the full TS surface, got: ${files.join(', ')}`);
      for (const name of files) {
        const content = readFileSync(join(generatedDir, name), 'utf-8');
        const markers = content.split('// ── rustra generated').length - 1;
        assert.equal(markers, 1, `${name} must carry the self-describing header exactly once`);
        assert.match(content, /^\/\/ ── rustra generated/);
        assert.match(content, /Source: schema\.json/);
        assert.match(content, /Regen: {2}rustra codegen --config rustra\.json/);
        assert.match(content, /Stage: {2}/);
        assert.match(content, /DO NOT EDIT/);
      }
    });
  },
);

test(
  'RN scaffold native entry registers its actual FFI package',
  { timeout: 180_000 },
  async () => {
    const { spawnSync } = await import('node:child_process');
    await withTempDir(async (root) => {
      const project = join(root, 'app');
      await runInit([project, '--host', 'react-native']);
      const repo = fileURLToPath(new URL('../../../', import.meta.url));
      const manifest = join(project, 'Cargo.toml');
      writeFileSync(
        manifest,
        readFileSync(manifest, 'utf8') +
          '\n[patch.crates-io]\n' +
          ['rustra', 'rustra-macros', 'rustra-naming']
            .map(
              (name) =>
                `${name} = { path = ${JSON.stringify(join(repo, 'crates', name).replaceAll('\\', '/'))} }`,
            )
            .join('\n') +
          '\n',
      );
      const lib = join(project, 'src/lib.rs');
      writeFileSync(
        lib,
        readFileSync(lib, 'utf8') +
          `
#[test]
fn native_entry_registers_echo() {
    rustra_mobile_init();
    rustra_mobile_init();
    let package = rustra::ffi::get_package().expect("native entry must register FFI");
    let value = package.invoke_json("echo", serde_json::json!({ "message": "native init" })).unwrap();
    assert_eq!(value["message"], "native init");
}
`,
      );
      const result = spawnSync('cargo', ['test', '--manifest-path', manifest, '--lib', '--quiet'], {
        cwd: project,
        encoding: 'utf8',
        timeout: 150_000,
        env: { ...process.env, CARGO_TARGET_DIR: join(repo, 'target/init-smoke') },
      });
      assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /1 passed/);
    });
  },
);

test(
  'Bun scaffold builds its native entry and executes the generated first echo',
  { timeout: 180_000 },
  async () => {
    const { spawnSync } = await import('node:child_process');
    await withTempDir(async (root) => {
      const project = join(root, 'app');
      const repo = fileURLToPath(new URL('../../../', import.meta.url));
      const versions = templateVersions(
        cliManifest.version,
        cliManifest.dependencies['@rustra/types'],
        cliManifest.rustraTemplate.cargoRange,
      );
      const files = renderInitProjectFiles(versions, {
        bun: true,
        bunRange: cliManifest.rustraTemplate.bunRange,
        reactNative: false,
      });
      const contents = {
        'Cargo.toml': files.cargoToml,
        'src/lib.rs': files.libRs,
        'src/main.rs': files.mainRs,
        'src/bin/generate.rs': files.generateRs,
        'src/index.ts': files.appTs,
        'package.json': files.packageJson,
        'rustra.json': files.rustraJson,
      };
      for (const [name, content] of Object.entries(contents)) {
        const path = join(project, name);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, content);
      }
      // Validate the current source adapters/Rust ABI, independently of registry
      // publication. The generated package still declares its release ranges.
      const manifest = join(project, 'Cargo.toml');
      writeFileSync(
        manifest,
        readFileSync(manifest, 'utf8') +
          '\n[patch.crates-io]\n' +
          ['rustra', 'rustra-macros', 'rustra-naming']
            .map(
              (name) =>
                `${name} = { path = ${JSON.stringify(join(repo, 'crates', name).replaceAll('\\', '/'))} }`,
            )
            .join('\n') +
          '\n',
      );
      const adapters = join(project, 'node_modules/@rustra');
      mkdirSync(adapters, { recursive: true });
      for (const name of ['types', 'bun'])
        symlinkSync(join(repo, 'packages', name), join(adapters, name), 'dir');
      const previousTarget = process.env.CARGO_TARGET_DIR;
      process.env.CARGO_TARGET_DIR = join(repo, 'target/init-smoke');
      try {
        for (const args of [
          ['build', '--quiet'],
          ['run', '--quiet', '--bin', 'generate'],
        ]) {
          const result = spawnSync('cargo', [...args, '--manifest-path', manifest], {
            cwd: project,
            encoding: 'utf8',
            timeout: 150_000,
            env: process.env,
          });
          assert.equal(
            result.status,
            0,
            `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`,
          );
        }
        const written = await runGenerate(['--config', join(project, 'rustra.json')], undefined, {
          quiet: true,
        });
        assert.ok(written.some((file) => file.endsWith('bun.ts')));
        assert.ok(!written.some((file) => file.endsWith('node.ts')));
        const firstCall = spawnSync('bun', ['src/index.ts'], {
          cwd: project,
          encoding: 'utf8',
          timeout: 5_000,
          env: process.env,
        });
        assert.equal(firstCall.status, 0, `${firstCall.error ?? ''}\n${firstCall.stderr}`);
        assert.equal(firstCall.stdout.trim(), 'hello from TypeScript');
      } finally {
        if (previousTarget === undefined) delete process.env.CARGO_TARGET_DIR;
        else process.env.CARGO_TARGET_DIR = previousTarget;
      }
    });
  },
);

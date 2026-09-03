import assert from 'node:assert/strict';
import test from 'node:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInit } from './cli-init.js';
import { UsageError } from './cli-usage-error.js';
import { readConfigSync } from './config.js';
import { INIT_CONFIG_SCHEMA_PATH } from './init-template.js';
import { runGenerate } from './cli-generate.js';

function withTempDir(fn: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'rustra-init-'));
  return Promise.resolve(fn(root)).finally(() => rmSync(root, { recursive: true, force: true }));
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
      () => runInit([join(root, 'x'), '--host', 'bun']),
      /Unknown init --host value "bun"[\s\S]*node, react-native/,
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
    await assert.rejects(() => runInit([join(root, 'x'), '--host', 'bun']), UsageError);
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
      assert.match(
        readFileSync(join(project, 'Cargo.toml'), 'utf-8'),
        /crate-type\s*=\s*\["rlib", "staticlib"\]/,
      );
      writeMinimalSchema(project);
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

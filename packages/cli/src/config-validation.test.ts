import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUN_CONFIG_KEYS,
  CODEGEN_CONFIG_KEYS,
  CONFIG_ROOT_KEYS,
  DEV_CONFIG_KEYS,
  DEV_TARGETS,
  DEV_WASM_CONFIG_KEYS,
  INSPECTOR_CONFIG_KEYS,
  NODE_CONFIG_KEYS,
  ON_MISMATCH_VALUES,
  REACT_NATIVE_CONFIG_KEYS,
  WASM_ENGINES,
  collectSemanticErrors,
  readConfigSync,
  type RustraConfig,
  type WasmEngine,
} from './config.js';

const baseConfig = { schema: './generated/schema.json', output: './src/generated' };

type LoadResult = { config?: RustraConfig; error?: string };

function loadConfig(body: unknown): LoadResult {
  const root = mkdtempSync(join(tmpdir(), 'rustra-config-matrix-'));
  const path = join(root, 'rustra.json');
  writeFileSync(path, JSON.stringify(body));
  try {
    return { config: readConfigSync(path) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function loadConfigError(body: unknown): string {
  const result = loadConfig(body);
  assert.ok(result.error, `expected config to be rejected: ${JSON.stringify(body)}`);
  return result.error;
}

test('wasm dev target without a reactNative section is an L2 error', () => {
  const error = loadConfigError({ ...baseConfig, dev: { target: 'wasm' } });
  assert.match(error, /semantic error/i);
  assert.match(error, /dev\.target "wasm" requires a reactNative section/i);
  assert.deepEqual(collectSemanticErrors({ ...baseConfig, dev: { target: 'wasm' } }), [
    'dev.target "wasm" requires a reactNative section',
  ]);
});

test('wasmer engine is rejected at L2 with wasm3 as the only allowed engine', () => {
  const error = loadConfigError({
    ...baseConfig,
    reactNative: {},
    dev: { target: 'wasm', wasm: { engine: 'wasmer' } },
  });
  assert.match(error, /unknown config dev\.wasm\.engine value "wasmer"/i);
  assert.match(error, /allowed values: wasm3/i);
  // L1 문구와 통일 — "wasmer"는 거리 1이라 did-you-mean 이 붙는다
  assert.match(error, /did you mean "wasm3"\?/i);
});

test('parityGate under a native target is an L2 error', () => {
  const error = loadConfigError({
    ...baseConfig,
    dev: { target: 'native', wasm: { parityGate: true } },
  });
  assert.match(error, /dev\.wasm\.parityGate/i);
  assert.match(error, /only valid when dev\.target is "wasm"/i);
});

test('dev.wasm section under a native target is an L2 error', () => {
  const error = loadConfigError({
    ...baseConfig,
    dev: { target: 'native', wasm: { engine: 'wasm3' } },
  });
  assert.match(error, /dev\.wasm is only valid when dev\.target is "wasm"/i);
  // engine 값 자체는 정상 — 배치 위반 1건만 수집된다
  assert.match(error, /1 semantic error/i);
});

test('inspector.onMismatch diagnose is accepted without devtools installed', () => {
  const result = loadConfig({ ...baseConfig, inspector: { onMismatch: 'diagnose' } });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.config?.inspector, { onMismatch: 'diagnose' });
  assert.deepEqual(
    collectSemanticErrors({ ...baseConfig, inspector: { onMismatch: 'diagnose' } }),
    [],
  );
});

test('inspector.onMismatch hoge fails L1 listing the allowed values', () => {
  const error = loadConfigError({ ...baseConfig, inspector: { onMismatch: 'hoge' } });
  assert.match(error, /unknown config inspector\.onMismatch value "hoge"/i);
  assert.match(error, /diagnose/i);
  assert.match(error, /ignore/i);
});

test('a near-typo inspector.onMismatch value gets a did-you-mean suggestion', () => {
  const error = loadConfigError({ ...baseConfig, inspector: { onMismatch: 'daignose' } });
  assert.match(error, /did you mean "diagnose"\?/i);
});

test('a non-string $schema value fails L1 like every other root key', () => {
  const error = loadConfigError({ ...baseConfig, $schema: 123 });
  assert.match(error, /\$schema/);
});

test('an invalid dev.target value fails L1 with a did-you-mean suggestion', () => {
  const error = loadConfigError({ ...baseConfig, dev: { target: 'wsm' } });
  assert.match(error, /unknown config dev\.target value "wsm"/i);
  assert.match(error, /did you mean "wasm"\?/i);
});

test('non-object new sections fail L1 at the object guard', () => {
  // dev/inspector 는 구 섹션(node/bun 등)과 달리 객체 가드 테스트가 없어 여기서 고정한다.
  const cases: readonly (readonly [label: string, body: unknown, labelPattern: RegExp])[] = [
    ['dev as string', { ...baseConfig, dev: 'x' }, /config dev must be an object/],
    ['dev as number', { ...baseConfig, dev: 42 }, /config dev must be an object/],
    [
      'dev.wasm as number',
      { ...baseConfig, dev: { wasm: 42 } },
      /config dev\.wasm must be an object/,
    ],
    ['inspector as array', { ...baseConfig, inspector: [] }, /config inspector must be an object/],
    [
      'inspector as string',
      { ...baseConfig, inspector: 'diagnose' },
      /config inspector must be an object/,
    ],
  ];
  for (const [label, body, expected] of cases) {
    assert.match(loadConfigError(body), expected, label);
  }
});

test('a legacy config without dev/inspector sections loads exactly as before', () => {
  const result = loadConfig(baseConfig);
  assert.deepEqual(result.config, baseConfig);
  assert.deepEqual(collectSemanticErrors(baseConfig), []);
});

test('a dev.targt typo fails L1 closed before L2 runs', () => {
  const error = loadConfigError({
    ...baseConfig,
    dev: { targt: 'wasm', wasm: { engine: 'wasmer' } },
  });
  assert.match(error, /unknown config dev key "targt"/i);
  assert.match(error, /did you mean "target"\?/i);
  // L1 실패 시 L2는 진행하지 않는다 — engine 위반 문구가 없어야 한다
  assert.doesNotMatch(error, /engine/i);
});

test('multiple L2 violations are all collected and listed together', () => {
  // L1 통과 후의 JSON을 그대로 재현 — 허용값 벗어난 engine 문자열을 포함한다.
  const body: RustraConfig = {
    ...baseConfig,
    dev: { target: 'wasm', wasm: { engine: 'wasmer' as WasmEngine } },
  };
  const error = loadConfigError(body);
  assert.match(error, /2 semantic errors/i);
  assert.match(error, /dev\.target "wasm" requires a reactNative section/i);
  assert.match(error, /unknown config dev\.wasm\.engine value "wasmer"/i);
  // 수집 순서 고정 — 목록 앞번호가 reactNative, 뒷번호가 engine
  const reactNativeIndex = error.indexOf('requires a reactNative section');
  const engineIndex = error.indexOf('"wasmer"');
  assert.ok(reactNativeIndex >= 0 && engineIndex > reactNativeIndex);
  assert.deepEqual(collectSemanticErrors(body).length, 2);
});

test('a complete wasm dev config with reactNative is accepted', () => {
  const result = loadConfig({
    ...baseConfig,
    reactNative: { rustLibrary: 'rustra_bridge' },
    dev: { target: 'wasm', wasm: { engine: 'wasm3', parityGate: true } },
    inspector: { onMismatch: 'ignore' },
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.config?.dev, {
    target: 'wasm',
    wasm: { engine: 'wasm3', parityGate: true },
  });
  assert.deepEqual(
    collectSemanticErrors({ ...baseConfig, dev: { target: 'wasm' }, reactNative: {} }),
    [],
  );
});

test('a missing config file points at rustra init instead of a raw ENOENT', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'rustra-config-missing-')), 'nope.json');
  try {
    assert.throws(
      () => readConfigSync(missing),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /Config file not found/);
        assert.match(message, /rustra init/);
        assert.ok(!/ENOENT/.test(message), 'raw ENOENT must not leak to users');
        return true;
      },
    );
  } finally {
    rmSync(missing, { force: true });
  }
});

test('rustra.schema.json stays in sync with the config field lists', () => {
  const schemaPath = fileURLToPath(new URL('../rustra.schema.json', import.meta.url));
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
    $schema: string;
    type: string;
    required: string[];
    additionalProperties: boolean;
    properties: Record<string, { enum?: string[]; properties?: Record<string, unknown> }>;
  };

  assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.equal(schema.type, 'object');
  assert.deepEqual([...schema.required].sort(), ['output', 'schema']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), [...CONFIG_ROOT_KEYS].sort());

  const section = (name: string) => {
    const sectionSchema = schema.properties[name] as {
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    assert.equal(sectionSchema.additionalProperties, false, name);
    return Object.keys(sectionSchema.properties ?? {}).sort();
  };
  assert.deepEqual(section('codegen'), [...CODEGEN_CONFIG_KEYS].sort());
  assert.deepEqual(section('reactNative'), [...REACT_NATIVE_CONFIG_KEYS].sort());
  assert.deepEqual(section('node'), [...NODE_CONFIG_KEYS].sort());
  assert.deepEqual(section('bun'), [...BUN_CONFIG_KEYS].sort());
  assert.deepEqual(section('tauri'), []);
  assert.deepEqual(section('dev'), [...DEV_CONFIG_KEYS].sort());
  assert.deepEqual(section('inspector'), [...INSPECTOR_CONFIG_KEYS].sort());

  const devProperties = schema.properties.dev as {
    properties: {
      target: { enum?: string[] };
      wasm: { properties: Record<string, unknown>; additionalProperties?: boolean };
    };
  };
  assert.deepEqual(devProperties.properties.target.enum, [...DEV_TARGETS]);
  assert.equal(devProperties.properties.wasm.additionalProperties, false);
  assert.deepEqual(
    Object.keys(devProperties.properties.wasm.properties).sort(),
    [...DEV_WASM_CONFIG_KEYS].sort(),
  );
  const wasm = devProperties.properties.wasm as {
    properties: { engine: { enum?: string[] } };
  };
  assert.deepEqual(wasm.properties.engine.enum, [...WASM_ENGINES]);
  const inspector = schema.properties.inspector as {
    properties: { onMismatch: { enum?: string[] } };
  };
  assert.deepEqual(inspector.properties.onMismatch.enum, [...ON_MISMATCH_VALUES]);

  const packageJson = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { files: string[] };
  assert.ok(
    packageJson.files.includes('rustra.schema.json'),
    'rustra.schema.json must ship in the published package files field',
  );
});

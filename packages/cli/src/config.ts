import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RustraConfig {
  schema: string;
  output: string;
  cppOutput?: string;
  positional?: boolean;
  codegen?: {
    rustManifest?: string;
    rustPackage?: string;
    rustBinary?: string;
  };
  reactNative?: {
    moduleDir?: string;
    rustManifest?: string;
    rustPackage?: string;
    rustLibrary?: string;
    legacyBenchmarks?: boolean;
  };
  node?: {
    rustManifest?: string;
    rustPackage?: string;
    rustBinary?: string;
    args?: string[];
  };
  bun?: {
    rustManifest?: string;
    rustPackage?: string;
    rustLibrary?: string;
  };
  tauri?: Record<string, never>;
}

export function readConfigSync(configPath: string): RustraConfig {
  const content = readFileSync(resolve(configPath), 'utf-8');
  const parsed = JSON.parse(content) as unknown;
  assertKnownKeys(
    parsed,
    [
      'schema',
      'output',
      'cppOutput',
      'positional',
      'codegen',
      'reactNative',
      'node',
      'bun',
      'tauri',
    ],
    'config',
  );
  const config = parsed as RustraConfig;

  if (
    typeof config.schema !== 'string' ||
    config.schema.length === 0 ||
    typeof config.output !== 'string' ||
    config.output.length === 0
  ) {
    throw new Error(
      'Config file must have "schema" and "output" fields. Example:\n' +
        '{\n  "schema": "./generated/schema.json",\n  "output": "./src/generated"\n}',
    );
  }
  if (/[\0\r\n]/.test(config.schema) || /[\0\r\n]/.test(config.output)) {
    throw new Error('Config schema and output must be non-empty safe paths');
  }
  const codegen = config.codegen;
  if (codegen !== undefined) {
    assertKnownKeys(codegen, ['rustManifest', 'rustPackage', 'rustBinary'], 'config codegen');
    if (typeof codegen !== 'object' || codegen === null || Array.isArray(codegen)) {
      throw new Error('Config codegen must be an object');
    }
    if (
      codegen.rustManifest !== undefined &&
      (typeof codegen.rustManifest !== 'string' ||
        codegen.rustManifest.length === 0 ||
        /[\0\r\n]/.test(codegen.rustManifest))
    ) {
      throw new Error('Config codegen.rustManifest must be a non-empty safe path');
    }
    for (const field of ['rustPackage', 'rustBinary'] as const) {
      const value = codegen[field];
      if (value !== undefined && (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value))) {
        throw new Error(`Config codegen.${field} must be a Cargo identifier`);
      }
    }
  }
  const rn = config.reactNative;
  if (rn !== undefined) {
    assertKnownKeys(
      rn,
      ['moduleDir', 'rustManifest', 'rustPackage', 'rustLibrary', 'legacyBenchmarks'],
      'config reactNative',
    );
    if (typeof rn !== 'object' || rn === null || Array.isArray(rn)) {
      throw new Error('Config reactNative must be an object');
    }
    if ('nativeModule' in rn) {
      throw new Error(
        'Config reactNative.nativeModule was removed. Use the generated @rustra/generated-react-native module.',
      );
    }
    if (
      rn.rustPackage !== undefined &&
      (typeof rn.rustPackage !== 'string' || !/^[A-Za-z0-9_-]+$/.test(rn.rustPackage))
    ) {
      throw new Error('Config reactNative.rustPackage must be a Cargo package name');
    }
    if (
      rn.rustLibrary !== undefined &&
      (typeof rn.rustLibrary !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(rn.rustLibrary))
    ) {
      throw new Error('Config reactNative.rustLibrary must be a static-library identifier');
    }
    for (const [key, path] of [
      ['moduleDir', rn.moduleDir],
      ['rustManifest', rn.rustManifest],
    ] as const) {
      if (
        path !== undefined &&
        (typeof path !== 'string' || path.length === 0 || /[\0\r\n]/.test(path))
      ) {
        throw new Error(`Config reactNative.${key} must be a non-empty safe path`);
      }
    }
    if (rn.legacyBenchmarks !== undefined && typeof rn.legacyBenchmarks !== 'boolean') {
      throw new Error('Config reactNative.legacyBenchmarks must be a boolean');
    }
  }

  for (const [host, value] of [
    ['node', config.node],
    ['bun', config.bun],
    ['tauri', config.tauri],
  ] as const) {
    if (
      value !== undefined &&
      (typeof value !== 'object' || value === null || Array.isArray(value))
    ) {
      throw new Error(`Config ${host} must be an object`);
    }
  }
  if (config.node)
    assertKnownKeys(
      config.node,
      ['rustManifest', 'rustPackage', 'rustBinary', 'args'],
      'config node',
    );
  if (config.bun)
    assertKnownKeys(config.bun, ['rustManifest', 'rustPackage', 'rustLibrary'], 'config bun');
  if (config.tauri) assertKnownKeys(config.tauri, [], 'config tauri');
  for (const [host, value] of [
    ['node', config.node],
    ['bun', config.bun],
  ] as const) {
    if (!value) continue;
    if (
      value.rustManifest !== undefined &&
      (typeof value.rustManifest !== 'string' ||
        value.rustManifest.length === 0 ||
        /[\0\r\n]/.test(value.rustManifest))
    ) {
      throw new Error(`Config ${host}.rustManifest must be a non-empty safe path`);
    }
    if (
      value.rustPackage !== undefined &&
      (typeof value.rustPackage !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value.rustPackage))
    ) {
      throw new Error(`Config ${host}.rustPackage must be a Cargo package name`);
    }
  }
  if (
    config.node?.rustBinary !== undefined &&
    (typeof config.node.rustBinary !== 'string' || !/^[A-Za-z0-9_-]+$/.test(config.node.rustBinary))
  ) {
    throw new Error('Config node.rustBinary must be a Cargo binary name');
  }
  if (
    config.node?.args !== undefined &&
    (!Array.isArray(config.node.args) ||
      config.node.args.some(
        (arg) => typeof arg !== 'string' || arg.length === 0 || /[\0\r\n]/.test(arg),
      ))
  ) {
    throw new Error('Config node.args must be an array of non-empty safe strings');
  }
  if (
    config.bun?.rustLibrary !== undefined &&
    (typeof config.bun.rustLibrary !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.bun.rustLibrary))
  ) {
    throw new Error('Config bun.rustLibrary must be a cdylib identifier');
  }
  if (config.tauri && Object.keys(config.tauri).length > 0) {
    throw new Error('Config tauri currently accepts only an empty object');
  }

  return config;
}

function assertKnownKeys(value: unknown, allowed: readonly string[], label: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown ${label} key "${key}"`);
  }
}

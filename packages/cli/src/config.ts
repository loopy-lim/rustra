// rustra.json 로더 — 파일 적기 + L1 fail-closed 검증(config-sections.ts) + L2 의미
// 수집(config-semantic.ts)으로 구성된 진입점. 계약 데이터(허용 키·타입)는
// config-schema.ts 에서 재수출해 기존 './config.js' 임포트 경로를 유지한다.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  assertDevSection,
  assertInspectorSection,
  assertKnownKeys,
  assertUniffiSection,
} from './config-sections.js';
import { collectSemanticErrors } from './config-semantic.js';
import {
  BUN_CONFIG_KEYS,
  CODEGEN_CONFIG_KEYS,
  CONFIG_ROOT_KEYS,
  NODE_CONFIG_KEYS,
  REACT_NATIVE_CONFIG_KEYS,
  type RustraConfig,
} from './config-schema.js';

export * from './config-schema.js';
export { collectSemanticErrors } from './config-semantic.js';

export function readConfigSync(configPath: string): RustraConfig {
  const resolvedPath = resolve(configPath);
  let content: string;
  try {
    content = readFileSync(resolvedPath, 'utf-8');
  } catch (error) {
    // ENOENT 를 날로 노출하지 않는다 — 신규 사용자의 최빈 원인은 "init 을 아직
    // 안 했다"이므로 그 해결 명령을 첫 줄에 내보내고, 원인 코드는 cause 로 보존.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      throw new Error(
        `Config file not found: ${resolvedPath}. Run "rustra init <dir>" to create a ` +
          `project, or pass the right path via --config.`,
        { cause: error },
      );
    }
    throw error;
  }
  const parsed = JSON.parse(content) as unknown;
  assertKnownKeys(parsed, CONFIG_ROOT_KEYS, 'config');
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
  if (config.$schema !== undefined && typeof config.$schema !== 'string') {
    throw new Error('Config $schema must be a string (JSON Schema reference for editors)');
  }
  const codegen = config.codegen;
  if (codegen !== undefined) {
    assertKnownKeys(codegen, CODEGEN_CONFIG_KEYS, 'config codegen');
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
    assertKnownKeys(rn, REACT_NATIVE_CONFIG_KEYS, 'config reactNative');
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
  if (config.node) assertKnownKeys(config.node, NODE_CONFIG_KEYS, 'config node');
  if (config.bun) assertKnownKeys(config.bun, BUN_CONFIG_KEYS, 'config bun');
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
  assertDevSection(config.dev);
  assertInspectorSection(config.inspector);
  assertUniffiSection(config.uniffi);

  const semanticErrors = collectSemanticErrors(config);
  if (semanticErrors.length > 0) {
    const list = semanticErrors.map((message, index) => `  ${index + 1}. ${message}`).join('\n');
    throw new Error(
      `Config has ${semanticErrors.length} semantic error${semanticErrors.length === 1 ? '' : 's'}:\n${list}`,
    );
  }

  return config;
}

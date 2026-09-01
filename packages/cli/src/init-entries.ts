import { generatedFileHeader } from './generated-header.js';
import { GENERATED_REACT_NATIVE_PACKAGE } from './react-native.js';
import type { CargoHostEntry } from './host-entries.js';

export function generateReactNativeEntryTs(): string {
  const moduleLiteral = JSON.stringify(GENERATED_REACT_NATIVE_PACKAGE);
  return `${generatedFileHeader('react-native.ts', 'schema → host entry')}import { createRustraBootstrap } from '@rustra/react-native';
import { installRustraJSI, getRustraNative } from ${moduleLiteral};
import { GENERATED_CONTRACT_HASH, SCHEMA_VERSION } from './contract.js';
import { rkyvV2Registry } from './rkyv-registry.js';

export * from './commands.js';
export { subscribeEvent } from '@rustra/react-native';

export const rustra = createRustraBootstrap({
  install: installRustraJSI,
  getNative: getRustraNative,
  rkyvV2Codecs: rkyvV2Registry,
  contractHash: GENERATED_CONTRACT_HASH,
  schemaVersion: SCHEMA_VERSION,
});
`;
}

/** 호스트 엔트리 렌더 옵션 — 스키마 이벤트 선언 유무가 구독 export 를 결정한다. */
export type HostEntryRenderOptions = {
  /**
   * 스키마에 `events` 선언이 있을 때 true. 이 값이 true 면 엔트리가 어댑터의
   * 구독 팩토리로 `subscribeEvent` 를 조립해 export 한다(코드젠 `events.ts` 의
   * `SubscribeFn` 계약과 정합). false/미지정이면 출력은 이전 버전과 바이트 동일
   * — 이벤트 없는 기존 프로젝트 재생성 출력이 변하지 않는다.
   */
  events?: boolean;
};

export function generateNodeEntryTs(
  entry: CargoHostEntry & { args?: string[] },
  options?: HostEntryRenderOptions,
): string {
  if (options?.events === true) {
    return `${generatedFileHeader('node.ts', 'schema → host entry')}import { fileURLToPath } from 'node:url';
import { createNodeBootstrap, createNodeEventSubscription } from '@rustra/node';
import { GENERATED_CONTRACT_HASH } from './contract.js';

export * from './commands.js';

const targetDirectory = new URL(${JSON.stringify(entry.targetDirectoryUrl)}, import.meta.url);
const executable = ${JSON.stringify(entry.targetName)} + (process.platform === 'win32' ? '.exe' : '');

export const rustra = createNodeBootstrap({
  binaryName: ${JSON.stringify(entry.targetName)},
  commandCandidates: [
    fileURLToPath(new URL(\`release/\${executable}\`, targetDirectory)),
    fileURLToPath(new URL(\`debug/\${executable}\`, targetDirectory)),
  ],
  args: ${JSON.stringify(entry.args ?? ['invoke'])},
  contractHash: GENERATED_CONTRACT_HASH,
});

export const events = createNodeEventSubscription({
  binaryName: ${JSON.stringify(entry.targetName)},
  commandCandidates: [
    fileURLToPath(new URL(\`release/\${executable}\`, targetDirectory)),
    fileURLToPath(new URL(\`debug/\${executable}\`, targetDirectory)),
  ],
});
export const subscribeEvent = events.subscribeEvent;
`;
  }
  return `${generatedFileHeader('node.ts', 'schema → host entry')}import { fileURLToPath } from 'node:url';
import { createNodeBootstrap } from '@rustra/node';
import { GENERATED_CONTRACT_HASH } from './contract.js';

export * from './commands.js';

const targetDirectory = new URL(${JSON.stringify(entry.targetDirectoryUrl)}, import.meta.url);
const executable = ${JSON.stringify(entry.targetName)} + (process.platform === 'win32' ? '.exe' : '');

export const rustra = createNodeBootstrap({
  binaryName: ${JSON.stringify(entry.targetName)},
  commandCandidates: [
    fileURLToPath(new URL(\`release/\${executable}\`, targetDirectory)),
    fileURLToPath(new URL(\`debug/\${executable}\`, targetDirectory)),
  ],
  args: ${JSON.stringify(entry.args ?? ['invoke'])},
  contractHash: GENERATED_CONTRACT_HASH,
});
`;
}

export function generateBunEntryTs(
  entry: CargoHostEntry,
  options?: HostEntryRenderOptions,
): string {
  if (options?.events === true) {
    return `${generatedFileHeader('bun.ts', 'schema → host entry')}import { fileURLToPath } from 'node:url';
import { suffix } from 'bun:ffi';
import { createBunBootstrap, createBunEventSubscription } from '@rustra/bun';
import { GENERATED_CONTRACT_HASH, SCHEMA_VERSION } from './contract.js';
import { rkyvV2Registry } from './rkyv-registry.js';

export * from './commands.js';

const targetDirectory = new URL(${JSON.stringify(entry.targetDirectoryUrl)}, import.meta.url);
const library = \`\${process.platform === 'win32' ? '' : 'lib'}${entry.targetName}.\${suffix}\`;

export const rustra = createBunBootstrap({
  libraryName: ${JSON.stringify(entry.targetName)},
  libraryCandidates: [
    fileURLToPath(new URL(\`release/\${library}\`, targetDirectory)),
    fileURLToPath(new URL(\`debug/\${library}\`, targetDirectory)),
  ],
  rkyvV2Codecs: rkyvV2Registry,
  contractHash: GENERATED_CONTRACT_HASH,
  schemaVersion: SCHEMA_VERSION,
});

// 이벤트 브릿지는 부트스트랩과 같은 후보 계산으로 cdylib 을 해상한다
// (libraryName 추론 폴백과 RUSTRA_BUN_LIBRARY 도 동일하게 존중 — 옵션 대칭).
export const events = createBunEventSubscription({
  libraryName: ${JSON.stringify(entry.targetName)},
  libraryCandidates: [
    fileURLToPath(new URL(\`release/\${library}\`, targetDirectory)),
    fileURLToPath(new URL(\`debug/\${library}\`, targetDirectory)),
  ],
});
export const subscribeEvent = events.subscribeEvent;
`;
  }
  return `${generatedFileHeader('bun.ts', 'schema → host entry')}import { fileURLToPath } from 'node:url';
import { suffix } from 'bun:ffi';
import { createBunBootstrap } from '@rustra/bun';
import { GENERATED_CONTRACT_HASH, SCHEMA_VERSION } from './contract.js';
import { rkyvV2Registry } from './rkyv-registry.js';

export * from './commands.js';

const targetDirectory = new URL(${JSON.stringify(entry.targetDirectoryUrl)}, import.meta.url);
const library = \`\${process.platform === 'win32' ? '' : 'lib'}${entry.targetName}.\${suffix}\`;

export const rustra = createBunBootstrap({
  libraryName: ${JSON.stringify(entry.targetName)},
  libraryCandidates: [
    fileURLToPath(new URL(\`release/\${library}\`, targetDirectory)),
    fileURLToPath(new URL(\`debug/\${library}\`, targetDirectory)),
  ],
  rkyvV2Codecs: rkyvV2Registry,
  contractHash: GENERATED_CONTRACT_HASH,
  schemaVersion: SCHEMA_VERSION,
});
`;
}

export function generateTauriEntryTs(): string {
  return `${generatedFileHeader('tauri.ts', 'schema → host entry')}import { createTauriBootstrap } from '@rustra/tauri';

export * from './commands.js';
export { subscribeTauriEvent as subscribeEvent } from '@rustra/tauri';

export const rustra = createTauriBootstrap();
`;
}

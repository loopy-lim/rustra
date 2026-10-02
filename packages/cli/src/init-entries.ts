import { generatedFileHeader } from './generated-header.js';
import { GENERATED_REACT_NATIVE_PACKAGE } from './react-native.js';
import type { CargoHostEntry } from './host-entries.js';

/**
 * (M9) 호스트 엔트리 공통 계약 검증 정책 주석 — 4개 엔트리(node/bun/tauri/
 * react-native)가 같은 첫 두 줄로 시작한다. “내 플랫폼에서 contract mismatch 가
 * strict 인가”를 어댑터 소스를 열지 않고 생성 엔트리만으로 답하게 하는 것이
 * 목적이다(DX_AUDIT M9). adapterLines 로 각 엔트리의 전달 옵션 차이를 밝힌다.
 */
const contractPolicyNote = (adapter: string, adapterLines: string[]): string =>
  [
    `// ── 계약 검증 정책(호스트 엔트리 공통) ───────────────────────────`,
    `// 공통 기본값: contractVerification = 'strict' — 스키마/바이너리 불일치는`,
    `// contract.mismatch 로 즉시 실패한다. OTA 롤백 등 의도적 드리프트에만`,
    `// 'warn'/'off' 로 바꿔 쓴다(생성 파일의 이 한 줄이 공식 탈출구).`,
    ...adapterLines.map((line) => `// 이 엔트리(${adapter}): ${line}`),
    ``,
  ].join('\n');

/** (M9) 엔트리별 옵션 정합 변경 이력 — 생성물 헤더 영역에 기록된다. */
const OPTION_UNIFICATION_CHANGELOG = [
  `// Changelog(M9 옵션 정합): node/bun/tauri/react-native 4개 엔트리가 동일한`,
  `//   계약 검증 기본값('strict')과 옵션명을 명시한다. 옵션명 변경/제거는`,
  `//   없다 — 기존 생성 엔트리 코드는 그대로 동작한다(하위 호환).`,
  ``,
].join('\n');

const NODE_POLICY = contractPolicyNote('node', [
  `contractHash + contractVerification: 'strict' 전달.`,
  `schemaVersion(OTA stale 검사)은 bun·react-native 엔트리만 전달 — node`,
  `어댑터(NodeBootstrapOptions)는 해당 옵션을 지원하지 않는다.`,
]);

const BUN_POLICY = contractPolicyNote('bun', [
  `contractHash + contractVerification: 'strict' + schemaVersion 전달`,
  `(프레임 엔진 전체 옵션 집합 — react-native 엔트리와 동일).`,
]);

const RN_POLICY = contractPolicyNote('react-native', [
  `contractHash + contractVerification: 'strict' + schemaVersion 전달`,
  `(프레임 엔진 전체 옵션 집합 — bun 엔트리와 동일).`,
]);

const TAURI_POLICY = contractPolicyNote('tauri', [
  `contractHash + contractVerification: 'strict' 전달.`,
  `rustra_contract_hash IPC 핸드셰이크로 선택된 네이티브 코어를 검증한다.`,
]);

export function generateReactNativeEntryTs(): string {
  const moduleLiteral = JSON.stringify(GENERATED_REACT_NATIVE_PACKAGE);
  return `${generatedFileHeader('react-native.ts', 'schema → host entry')}${RN_POLICY}${OPTION_UNIFICATION_CHANGELOG}import { createRustraBootstrap } from '@rustra/react-native';
import { installRustraJSI, getRustraNative } from ${moduleLiteral};
import { GENERATED_CONTRACT_HASH, SCHEMA_VERSION } from './contract.js';
import { frameRegistry } from './frame-registry.js';

export * from './commands.js';
export { subscribeEvent } from '@rustra/react-native';

export const rustra = createRustraBootstrap({
  install: installRustraJSI,
  getNative: getRustraNative,
  frameCodecs: frameRegistry,
  contractHash: GENERATED_CONTRACT_HASH,
  contractVerification: 'strict',
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

const BOOTSTRAP_EVENT_EXPORTS = `
const eventUnsubscribes = new Set<() => void>();
const subscribe: typeof rustra.subscribeEvent = (name, callback) => {
  const unsubscribe = rustra.subscribeEvent(name, callback);
  const remove = () => {
    eventUnsubscribes.delete(remove);
    unsubscribe();
  };
  eventUnsubscribes.add(remove);
  return remove;
};
export const events = {
  subscribeEvent: subscribe,
  dispose() {
    for (const unsubscribe of [...eventUnsubscribes]) unsubscribe();
    eventUnsubscribes.clear();
  },
};
export const subscribeEvent = events.subscribeEvent;
const disposeBootstrap = rustra.dispose.bind(rustra);
rustra.dispose = () => {
  events.dispose();
  disposeBootstrap();
};
`;

export function generateNodeEntryTs(
  entry: CargoHostEntry & { args?: string[]; persistent?: boolean },
  options?: HostEntryRenderOptions,
): string {
  if (options?.events === true) {
    return `${generatedFileHeader('node.ts', 'schema → host entry')}${NODE_POLICY}${OPTION_UNIFICATION_CHANGELOG}import { fileURLToPath } from 'node:url';
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
  args: ${JSON.stringify(entry.args ?? ['serve'])},
  persistent: true,
  contractHash: GENERATED_CONTRACT_HASH,
  contractVerification: 'strict',
});

${BOOTSTRAP_EVENT_EXPORTS}`;
  }
  return `${generatedFileHeader('node.ts', 'schema → host entry')}${NODE_POLICY}${OPTION_UNIFICATION_CHANGELOG}import { fileURLToPath } from 'node:url';
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
  args: ${JSON.stringify(entry.args ?? (entry.persistent ? ['serve'] : ['invoke']))},
${entry.persistent ? '  persistent: true,\n' : ''}  contractHash: GENERATED_CONTRACT_HASH,
  contractVerification: 'strict',
});
`;
}

export function generateBunEntryTs(
  entry: CargoHostEntry,
  options?: HostEntryRenderOptions,
): string {
  if (options?.events === true) {
    return `${generatedFileHeader('bun.ts', 'schema → host entry')}${BUN_POLICY}${OPTION_UNIFICATION_CHANGELOG}import { fileURLToPath } from 'node:url';
import { suffix } from 'bun:ffi';
import { createBunBootstrap } from '@rustra/bun';
import { GENERATED_CONTRACT_HASH, SCHEMA_VERSION } from './contract.js';
import { frameRegistry } from './frame-registry.js';

export * from './commands.js';

const targetDirectory = new URL(${JSON.stringify(entry.targetDirectoryUrl)}, import.meta.url);
const library = \`\${process.platform === 'win32' ? '' : 'lib'}${entry.targetName}.\${suffix}\`;

export const rustra = createBunBootstrap({
  libraryName: ${JSON.stringify(entry.targetName)},
  libraryCandidates: [
    fileURLToPath(new URL(\`release/\${library}\`, targetDirectory)),
    fileURLToPath(new URL(\`debug/\${library}\`, targetDirectory)),
  ],
  frameCodecs: frameRegistry,
  contractHash: GENERATED_CONTRACT_HASH,
  contractVerification: 'strict',
  schemaVersion: SCHEMA_VERSION,
});

${BOOTSTRAP_EVENT_EXPORTS}`;
  }
  return `${generatedFileHeader('bun.ts', 'schema → host entry')}${BUN_POLICY}${OPTION_UNIFICATION_CHANGELOG}import { fileURLToPath } from 'node:url';
import { suffix } from 'bun:ffi';
import { createBunBootstrap } from '@rustra/bun';
import { GENERATED_CONTRACT_HASH, SCHEMA_VERSION } from './contract.js';
import { frameRegistry } from './frame-registry.js';

export * from './commands.js';

const targetDirectory = new URL(${JSON.stringify(entry.targetDirectoryUrl)}, import.meta.url);
const library = \`\${process.platform === 'win32' ? '' : 'lib'}${entry.targetName}.\${suffix}\`;

export const rustra = createBunBootstrap({
  libraryName: ${JSON.stringify(entry.targetName)},
  libraryCandidates: [
    fileURLToPath(new URL(\`release/\${library}\`, targetDirectory)),
    fileURLToPath(new URL(\`debug/\${library}\`, targetDirectory)),
  ],
  frameCodecs: frameRegistry,
  contractHash: GENERATED_CONTRACT_HASH,
  contractVerification: 'strict',
  schemaVersion: SCHEMA_VERSION,
});
`;
}

export function generateTauriEntryTs(): string {
  return `${generatedFileHeader('tauri.ts', 'schema → host entry')}${TAURI_POLICY}${OPTION_UNIFICATION_CHANGELOG}import { createTauriBootstrap } from '@rustra/tauri';
import { GENERATED_CONTRACT_HASH } from './contract.js';

export * from './commands.js';
export { subscribeTauriEvent as subscribeEvent } from '@rustra/tauri';

export const rustra = createTauriBootstrap({
  contractHash: GENERATED_CONTRACT_HASH,
  contractVerification: 'strict',
});
`;
}

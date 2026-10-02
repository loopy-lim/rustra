// ── rustra generated ────────────────────────────────────────
// File:   node.ts
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  schema → host entry
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────

// ── 계약 검증 정책(호스트 엔트리 공통) ───────────────────────────
// 공통 기본값: contractVerification = 'strict' — 스키마/바이너리 불일치는
// contract.mismatch 로 즉시 실패한다. OTA 롤백 등 의도적 드리프트에만
// 'warn'/'off' 로 바꿔 쓴다(생성 파일의 이 한 줄이 공식 탈출구).
// 이 엔트리(node): contractHash + contractVerification: 'strict' 전달.
// 이 엔트리(node): schemaVersion(OTA stale 검사)은 bun·react-native 엔트리만 전달 — node
// 이 엔트리(node): 어댑터(NodeBootstrapOptions)는 해당 옵션을 지원하지 않는다.
// Changelog(M9 옵션 정합): node/bun/tauri/react-native 4개 엔트리가 동일한
//   계약 검증 기본값('strict')과 옵션명을 명시한다. 옵션명 변경/제거는
//   없다 — 기존 생성 엔트리 코드는 그대로 동작한다(하위 호환).
import { fileURLToPath } from 'node:url';
import { createNodeBootstrap } from '@rustra/node';
import { GENERATED_CONTRACT_HASH } from './contract.js';

export * from './commands.js';

const targetDirectory = new URL("../../../target/", import.meta.url);
const executable = "rustra-crud-example" + (process.platform === 'win32' ? '.exe' : '');

export const rustra = createNodeBootstrap({
  binaryName: "rustra-crud-example",
  commandCandidates: [
    fileURLToPath(new URL(`release/${executable}`, targetDirectory)),
    fileURLToPath(new URL(`debug/${executable}`, targetDirectory)),
  ],
  args: ["serve"],
  persistent: true,
  contractHash: GENERATED_CONTRACT_HASH,
  contractVerification: 'strict',
});

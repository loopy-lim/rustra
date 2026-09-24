// ── rustra generated ────────────────────────────────────────
// File:   tauri.ts
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  schema → host entry
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────

// ── 계약 검증 정책(호스트 엔트리 공통) ───────────────────────────
// 공통 기본값: contractVerification = 'strict' — 스키마/바이너리 불일치는
// contract.mismatch 로 즉시 실패한다. OTA 롤백 등 의도적 드리프트에만
// 'warn'/'off' 로 바꿔 쓴다(생성 파일의 이 한 줄이 공식 탈출구).
// 이 엔트리(tauri): JSON 엔진 경로 — 클라이언트측 contractHash 핸드셰이크가 없어
// 이 엔트리(tauri): contractVerification/schemaVersion 옵션을 받지 않는다(와이어가 JSON).
// 이 엔트리(tauri): 계약 드리프트는 네이티브 rustra_dispatch 실행 오류로 표면화된다.
// Changelog(M9 옵션 정합): node/bun/tauri/react-native 4개 엔트리가 동일한
//   계약 검증 기본값('strict')과 옵션명을 명시한다. 옵션명 변경/제거는
//   없다 — 기존 생성 엔트리 코드는 그대로 동작한다(하위 호환).
import { createTauriBootstrap } from '@rustra/tauri';

export * from './commands.js';
export { subscribeTauriEvent as subscribeEvent } from '@rustra/tauri';

export const rustra = createTauriBootstrap();

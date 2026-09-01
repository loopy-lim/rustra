/**
 * 모든 코드젠 산출물에 각인되는 자기서술 헤더.
 *
 * 듀얼 패스 시대의 유산 — "이 파일을 뭐가 만들었지? 뭘 돌려야 최신이지?" — 를
 * 파일 자체가 대답한다. 바이트 안정적이어야 한다(스냅샷·매니페스트 게이트 정합).
 */
export function generatedFileHeader(fileName: string, stage: string): string {
  return [
    `// ── rustra generated ────────────────────────────────────────`,
    `// File:   ${fileName}`,
    `// Source: schema.json (single source of truth for this file)`,
    `// Regen:  rustra codegen --config rustra.json`,
    `// Stage:  ${stage}`,
    `// DO NOT EDIT — changes will be overwritten and fail codegen --check.`,
    `// ────────────────────────────────────────────────────────────`,
    ``,
    ``,
  ].join('\n');
}

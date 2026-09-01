/**
 * `codegen --explain` — 표면 지도.
 *
 * 코드젠의 입력(schema.json)과 렌더러별 출력 파일을 한 표로 대답한다:
 * "이 파일은 어디서 왔고, 뭘 고쳐야 반영되는가". 순수 조회 — 파일을 쓰지 않고
 * cargo/TS 렌더러를 실행하지 않는다. facts는 cli-codegen.ts가 config에서
 * 파싱해 주입한다(렌더러 의존 없음 → 저비용 테스트 가능).
 */

export type ExplainFacts = {
  /** C++ 코덱 출력(cppOutput 또는 RN 스캐폴드)이 켜져 있는가. */
  hasCpp: boolean;
  /** React Native 스캐폴드가 켜져 있는가. */
  hasReactNative: boolean;
  /** positional facade 출력이 켜져 있는가. */
  positional: boolean;
  /** 활성 호스트 엔트리 파일명(node.ts/bun.ts/tauri.ts/react-native.ts). */
  hostEntries: string[];
};

export type ExplainRow = {
  output: string;
  renderer: string;
  stage: string;
};

const TS_CORE: Array<{ output: string; stage: string }> = [
  { output: 'types.ts', stage: 'types' },
  { output: 'commands.ts', stage: 'command helpers' },
  { output: 'contract.ts', stage: 'contract hash + schema version' },
  { output: 'rkyv-codecs.ts', stage: 'rkyv codecs (TS)' },
  { output: 'rkyv-registry.ts', stage: 'rkyv registry (TS)' },
];

export function explainCodegenSurfaces(facts: ExplainFacts): ExplainRow[] {
  const rows: ExplainRow[] = [
    {
      output: 'generated/schema.json',
      renderer: 'rust probe',
      stage: 'contract probe → schema only',
    },
  ];
  for (const core of TS_CORE)
    rows.push({ output: core.output, renderer: 'ts renderer', stage: core.stage });
  if (facts.positional)
    rows.push({
      output: 'positional-facade.ts',
      renderer: 'ts renderer',
      stage: 'positional facade (JSI fast path)',
    });
  for (const entry of facts.hostEntries)
    rows.push({ output: entry, renderer: 'ts renderer', stage: 'host entry' });
  if (facts.hasCpp)
    rows.push({
      output: 'rustra-generated-codecs.hpp / .cpp',
      renderer: 'cpp codec renderer',
      stage: 'rkyv codecs (C++)',
    });
  if (facts.hasReactNative)
    rows.push({
      output: 'react-native module scaffold',
      renderer: 'ts renderer',
      stage: 'RN native module wrapper',
    });
  rows.push({
    output: '.rustra-generated.json',
    renderer: 'manifest',
    stage: 'freshness sidecar (codegen --check, doctor)',
  });
  return rows;
}

export function formatExplainText(rows: ExplainRow[]): string {
  const lines = [
    'rustra codegen surfaces — single arrow: schema.json in, every surface rendered:',
    '',
    '  OUTPUT                          RENDERER             STAGE',
  ];
  for (const row of rows)
    lines.push(`  ${row.output.padEnd(31)} ${row.renderer.padEnd(20)} ${row.stage}`);
  lines.push('', '  Regenerate everything: rustra codegen --config rustra.json');
  return lines.join('\n');
}

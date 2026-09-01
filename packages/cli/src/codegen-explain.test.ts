import assert from 'node:assert/strict';
import test from 'node:test';
import { explainCodegenSurfaces, formatExplainText, type ExplainFacts } from './codegen-explain.js';

const FULL: ExplainFacts = {
  hasCpp: true,
  hasReactNative: true,
  positional: true,
  hostEntries: ['node.ts', 'bun.ts'],
};

test('explain lists every surface with source and stage', () => {
  const rows = explainCodegenSurfaces(FULL);
  assert.ok(rows.some((row) => row.output === 'types.ts' && row.renderer === 'ts renderer'));
  assert.ok(rows.some((row) => row.output === 'rkyv-codecs.ts'));
  assert.ok(rows.some((row) => row.output === 'rkyv-registry.ts'));
  // C++ 표면
  assert.ok(rows.some((row) => row.renderer === 'cpp codec renderer'));
  // RN 스캐폴드 + positional facade
  assert.ok(rows.some((row) => row.output === 'positional-facade.ts'));
  // 호스트 엔트리
  assert.ok(rows.some((row) => row.output === 'node.ts'));
  assert.ok(rows.some((row) => row.output === 'bun.ts'));
  // manifest sidecar
  assert.ok(rows.some((row) => row.output === '.rustra-generated.json'));
});

test('explain text mentions the single input and the regen command', () => {
  const text = formatExplainText(explainCodegenSurfaces(FULL));
  assert.match(text, /schema\.json/);
  assert.match(text, /rustra codegen/);
});

test('explain honors config without cpp/rn sections', () => {
  const rows = explainCodegenSurfaces({
    hasCpp: false,
    hasReactNative: false,
    positional: false,
    hostEntries: [],
  });
  assert.ok(!rows.some((row) => row.renderer === 'cpp codec renderer'));
  assert.ok(!rows.some((row) => row.output === 'positional-facade.ts'));
  assert.ok(!rows.some((row) => row.output === 'react-native.ts'));
  // 코어 TS 표면은 항상 존재한다.
  for (const core of [
    'types.ts',
    'commands.ts',
    'contract.ts',
    'rkyv-codecs.ts',
    'rkyv-registry.ts',
  ])
    assert.ok(
      rows.some((row) => row.output === core),
      `${core} must be listed`,
    );
});

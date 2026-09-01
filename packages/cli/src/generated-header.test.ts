import { describe, expect, test } from 'bun:test';
import { generatedFileHeader } from './generated-header.js';

describe('generatedFileHeader', () => {
  test('deterministic — same inputs, same bytes', () => {
    const a = generatedFileHeader('types.ts', 'rust-probe schema → ts renderer');
    const b = generatedFileHeader('types.ts', 'rust-probe schema → ts renderer');
    expect(a).toBe(b);
  });

  test('contains source, regen command, do-not-edit, and stage', () => {
    const header = generatedFileHeader('rkyv-codecs.ts', 'rust-probe schema → ts renderer');
    expect(header).toContain('// ── rustra generated');
    expect(header).toContain('Source: schema.json');
    expect(header).toContain('Regen:  rustra codegen --config rustra.json');
    expect(header).toContain('DO NOT EDIT');
    expect(header).toContain('Stage:  rust-probe schema → ts renderer');
  });

  test('ends with a single blank line — content follows directly', () => {
    const header = generatedFileHeader('types.ts', 'x');
    expect(header.endsWith('\n\n')).toBe(true);
    expect(header.endsWith('\n\n\n')).toBe(false);
  });
});

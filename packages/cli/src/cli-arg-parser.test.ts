import { describe, expect, test } from 'bun:test';
import { parseCliArgs } from './cli-arg-parser.js';

describe('parseCliArgs', () => {
  test('rejects unknown flags with closest-flag suggestion', () => {
    expect(() =>
      parseCliArgs(['--configg', 'x'], {
        command: 'codegen',
        valueFlags: ['config'],
        booleanFlags: ['check'],
      }),
    ).toThrow(/Unknown codegen option: --configg[\s\S]*--config/);
  });

  test('supports --flag=value', () => {
    const parsed = parseCliArgs(['--config=x'], {
      command: 'codegen',
      valueFlags: ['config'],
      booleanFlags: [],
    });
    expect(parsed.values.get('config')).toBe('x');
  });

  test('rejects unknown flags without a close match with the available set', () => {
    expect(() =>
      parseCliArgs(['--zzz'], {
        command: 'diff',
        valueFlags: ['old', 'new'],
        booleanFlags: ['check'],
      }),
    ).toThrow(/Unknown diff option: --zzz[\s\S]*--old, --new, --check/);
  });

  test('reports near-miss flags past a typo', () => {
    expect(() =>
      parseCliArgs(['--format', 'json', '--strick'], {
        command: 'doctor',
        valueFlags: ['config', 'format'],
        booleanFlags: ['strict'],
      }),
    ).toThrow(/Unknown doctor option: --strick[\s\S]*Did you mean --strict/);
  });
});

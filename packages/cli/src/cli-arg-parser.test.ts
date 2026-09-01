import { describe, expect, test } from 'bun:test';
import { cliFormat, parseCliArgs, requiredCliValue } from './cli-arg-parser.js';
import { UsageError } from './cli-usage-error.js';

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

  // exit-2 계약 — usage 오류는 UsageError 인스턴스다. index.ts 가 메시지
  // 정규식 대신 instanceof 로 판별하므로 타입 자체가 CI 계약 표면이다.
  test('usage errors are UsageError instances (exit-2 contract)', () => {
    const usageThrows: Array<() => unknown> = [
      () =>
        parseCliArgs(['--configg', 'x'], {
          command: 'codegen',
          valueFlags: ['config'],
          booleanFlags: ['check'],
        }),
      () =>
        parseCliArgs(['stray'], {
          command: 'codegen',
          valueFlags: ['config'],
          booleanFlags: [],
        }),
      () =>
        parseCliArgs(['--check=yes'], {
          command: 'codegen',
          valueFlags: ['config'],
          booleanFlags: ['check'],
        }),
      () =>
        parseCliArgs(['--config'], {
          command: 'codegen',
          valueFlags: ['config'],
          booleanFlags: [],
        }),
      () => cliFormat('yaml', 'diff'),
      // requiredCliValue 의 누락 값도 기존 정규식 관례상 usage 오류였다.
      () => requiredCliValue({ values: new Map(), flags: new Set(), positionals: [] }, 'old'),
    ];
    for (const usageThrow of usageThrows) {
      expect(usageThrow).toThrow(UsageError);
    }
  });

  test('runtime failures are NOT UsageError instances (exit-1 contract)', () => {
    // 파일 없음 등 런타임 실패는 usage 가 아니므로 UsageError 여서는 안 된다 —
    // 일반 Error 는 그대로 exit 1 이어야 한다.
    const runtimeError = new Error('ENOENT: no such file');
    expect(runtimeError).not.toBeInstanceOf(UsageError);
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

  test('accepts separated --flag value and -h boolean', () => {
    const parsed = parseCliArgs(['--config', 'a.json', '-h'], {
      command: 'codegen',
      valueFlags: ['config', 'format'],
      booleanFlags: ['check', 'help', 'h'],
    });
    expect(parsed.values.get('config')).toBe('a.json');
    expect(parsed.flags.has('h')).toBe(true);
  });

  test('boolean flags reject an inline value', () => {
    expect(() =>
      parseCliArgs(['--check=yes'], {
        command: 'codegen',
        valueFlags: ['config'],
        booleanFlags: ['check'],
      }),
    ).toThrow(/--check does not accept a value/);
  });

  test('value flags require a value', () => {
    expect(() =>
      parseCliArgs(['--config'], {
        command: 'codegen',
        valueFlags: ['config'],
        booleanFlags: [],
      }),
    ).toThrow(/--config requires a value/);
  });

  test('positionals are rejected unless allowed', () => {
    expect(() =>
      parseCliArgs(['stray'], {
        command: 'codegen',
        valueFlags: ['config'],
        booleanFlags: [],
      }),
    ).toThrow(/Unknown codegen option: stray/);
    const parsed = parseCliArgs(['target-dir', '--force'], {
      command: 'init',
      valueFlags: [],
      booleanFlags: ['force'],
      allowPositionals: true,
    });
    expect(parsed.positionals).toEqual(['target-dir']);
    expect(parsed.flags.has('force')).toBe(true);
  });
});

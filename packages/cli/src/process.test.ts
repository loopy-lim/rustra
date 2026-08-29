import { describe, expect, test } from 'bun:test';
import { spawnInherit } from './process.js';

// 스피너 진단은 선택된 progressStream(console.error)으로 흘러 JSON stdout을
// 오염시키지 않는다. 여기서는 1.3초짜리 자식 프로세스로 경과 클록을 검증한다.
describe('spawnInherit progress spinner', () => {
  test('emits spinner frames and elapsed time while a command runs', async () => {
    const chunks: string[] = [];
    const originalError = console.error;
    console.error = (...parts: unknown[]) => {
      chunks.push(parts.join(' '));
    };
    try {
      await spawnInherit('node', ['-e', 'setTimeout(() => {}, 1300)'], process.cwd(), {
        progressLabel: 'spinner probe',
        progressStream: 'stderr',
        childOutput: 'stderr',
      });
    } finally {
      console.error = originalError;
    }
    const output = chunks.join('\n');
    expect(output).toContain('[rustra] ⠋ spinner probe...');
    expect(output).toMatch(/spinner probe still running \(1s\)/);
    expect(output).toMatch(/spinner probe done in 1\.\ds/);
  }, 10000);

  test('spinner respects a fake timer-compatible 1s cadence for short commands', async () => {
    const chunks: string[] = [];
    const originalError = console.error;
    console.error = (...parts: unknown[]) => {
      chunks.push(parts.join(' '));
    };
    try {
      await spawnInherit('node', ['-e', 'process.exit(0)'], process.cwd(), {
        progressLabel: 'fast op',
        progressStream: 'stderr',
        childOutput: 'stderr',
      });
    } finally {
      console.error = originalError;
    }
    const output = chunks.join('\n');
    expect(output).toContain('[rustra] ⠋ fast op...');
    expect(output).toMatch(/fast op done in 0\.\ds/);
    expect(output).not.toContain('still running');
  }, 10000);
});

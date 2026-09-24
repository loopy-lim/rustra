import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnInherit } from './process.js';

// 스피너 진단은 선택된 progressStream(console.error)으로 흘러 JSON stdout을
// 오염시키지 않는다. 여기서는 1.3초짜리 자식 프로세스로 경과 클록을 검증한다.
describe('spawnInherit progress spinner', () => {
  test(
    'emits spinner frames and elapsed time while a command runs',
    { timeout: 10000 },
    async () => {
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
      assert.ok(output.includes('[rustra] ⠋ spinner probe...'));
      assert.match(output, /spinner probe still running \(1s\)/);
      assert.match(output, /spinner probe done in 1\.\ds/);
    },
  );

  test(
    'spinner respects a fake timer-compatible 1s cadence for short commands',
    { timeout: 10000 },
    async () => {
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
      assert.ok(output.includes('[rustra] ⠋ fast op...'));
      assert.match(output, /fast op done in 0\.\ds/);
      assert.ok(!output.includes('still running'));
    },
  );

  // Q3 — 성공 체크마크는 exit 코드 판정 후에만. 비정상 종료 시 ✗ failed 로그와
  // exit 코드 reject가 함께 나와야 CI 로그를 오독하지 않는다.
  test(
    'failure verdict replaces the done mark and the rejection keeps the exit code',
    { timeout: 10000 },
    async () => {
      const chunks: string[] = [];
      const originalError = console.error;
      console.error = (...parts: unknown[]) => {
        chunks.push(parts.join(' '));
      };
      try {
        await assert.rejects(
          spawnInherit('node', ['-e', 'process.exit(101)'], process.cwd(), {
            progressLabel: 'doomed build',
            progressStream: 'stderr',
            childOutput: 'stderr',
          }),
          /exit 101/,
        );
      } finally {
        console.error = originalError;
      }
      const output = chunks.join('\n');
      assert.match(output, /✗ doomed build failed in 0\.\ds/);
      assert.ok(!output.includes('✓'), `success mark leaked after failure:\n${output}`);
    },
  );
});

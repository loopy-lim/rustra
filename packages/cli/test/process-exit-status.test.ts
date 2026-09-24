import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnInherit } from '../src/process.js';

// Q3 — 성공 마크는 exit 코드 판정 후에만 찍힌다. 실패한 cargo 빌드 직후
// "✓ done"이 남으면 CI 로그 독자가 원인을 잘못 짚는다. 여기서는 진짜 자식
// 프로세스로 세 분기(정상 종료 / 비정상 exit / 시그널 종료)를 검증한다.
describe('spawnInherit exit-status verdict line', () => {
  async function captureConsole(run: () => Promise<void>): Promise<string[]> {
    const chunks: string[] = [];
    const originalError = console.error;
    console.error = (...parts: unknown[]) => {
      chunks.push(parts.join(' '));
    };
    try {
      await run();
    } finally {
      console.error = originalError;
    }
    return chunks;
  }

  test('exit 0 prints ✓ done and resolves', { timeout: 10000 }, async () => {
    const chunks = await captureConsole(() =>
      spawnInherit('node', ['-e', 'process.exit(0)'], process.cwd(), {
        progressLabel: 'clean exit',
        progressStream: 'stderr',
        childOutput: 'stderr',
      }),
    );
    const output = chunks.join('\n');
    assert.match(output, /✓ clean exit done in 0\.\ds/);
    assert.ok(!output.includes('✗'), `unexpected failure mark in:\n${output}`);
  });

  test(
    'non-zero exit prints ✗ failed (no ✓) and still rejects with the exit code',
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
            progressLabel: 'cargo build',
            progressStream: 'stderr',
            childOutput: 'stderr',
          }),
          /exit 101/,
        );
      } finally {
        console.error = originalError;
      }
      const output = chunks.join('\n');
      assert.match(output, /✗ cargo build failed in 0\.\ds/);
      assert.ok(!output.includes('✓'), `success mark leaked after failure:\n${output}`);
    },
  );

  test(
    'signal termination prints ✗ failed and rejects with the signal name',
    { timeout: 10000 },
    async () => {
      const chunks: string[] = [];
      const originalError = console.error;
      console.error = (...parts: unknown[]) => {
        chunks.push(parts.join(' '));
      };
      try {
        await assert.rejects(
          spawnInherit('node', ['-e', 'process.kill(process.pid, "SIGTERM")'], process.cwd(), {
            progressLabel: 'doomed op',
            progressStream: 'stderr',
            childOutput: 'stderr',
          }),
          /terminated by SIGTERM/,
        );
      } finally {
        console.error = originalError;
      }
      const output = chunks.join('\n');
      assert.match(output, /✗ doomed op failed in 0\.\ds/);
      assert.ok(!output.includes('✓'), `success mark leaked after signal death:\n${output}`);
    },
  );
});

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnInherit } from './process.js';

// 스피너 진단은 선택된 progressStream(console.error)으로 흘러 JSON stdout을
// 오염시키지 않는다. 여기서는 1.3초짜리 자식 프로세스로 경과 클록을 검증한다.
describe('spawnInherit progress spinner', () => {
  test('ignored verbose output cannot block a child on an unread pipe', async () => {
    await spawnInherit(
      process.execPath,
      [
        '-e',
        'process.stdout.write(Buffer.alloc(1024 * 1024)); process.stderr.write(Buffer.alloc(1024 * 1024));',
      ],
      process.cwd(),
      { childOutput: 'ignore', signal: AbortSignal.timeout(1500) },
    );
  });

  test('forwarded output stays with the stream owner captured at child creation', async () => {
    const originalWrite = process.stderr.write;
    const owner: string[] = [];
    const replacement: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      owner.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const child = spawnInherit(
        process.execPath,
        ['-e', 'process.stderr.write("owned output")'],
        process.cwd(),
        { childOutput: 'stderr' },
      );
      process.stderr.write = ((chunk: string | Uint8Array) => {
        replacement.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      await child;
      assert.equal(owner.join(''), 'owned output');
      assert.deepEqual(replacement, []);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test('waits for inherited output pipes to close before completing', async () => {
    const chunks: string[] = [];
    const originalWrite = process.stderr.write;
    let sawTail!: () => void;
    const tail = new Promise<void>((resolve) => {
      sawTail = resolve;
    });
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      if (chunks.join('').includes('last child output')) sawTail();
      return true;
    }) as typeof process.stderr.write;
    try {
      const grandchild = 'setTimeout(() => process.stderr.write("last child output"), 100)';
      await spawnInherit(
        process.execPath,
        [
          '-e',
          `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio: 'inherit'}); process.exit(0);`,
        ],
        process.cwd(),
        { childOutput: 'stderr' },
      );
      assert.match(chunks.join(''), /last child output/);
    } finally {
      await tail;
      process.stderr.write = originalWrite;
    }
  });

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

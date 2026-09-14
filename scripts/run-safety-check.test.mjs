import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

for (const code of [0, 7]) {
  test(`safety capture preserves stdout, stderr and exit ${code}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'rustra-safety-'));
    try {
      const result = spawnSync(
        'bash',
        [
          resolve('scripts/run-safety-check.sh'),
          'probe',
          'sh',
          '-c',
          `echo output; echo diagnostic >&2; exit ${code}`,
        ],
        {
          env: { ...process.env, SAFETY_LOG_DIR: dir },
          encoding: 'utf8',
          cwd: tmpdir(),
        },
      );
      assert.equal(result.status, code, result.stderr);
      const log = readFileSync(join(dir, 'probe.log'), 'utf8');
      assert.match(log, /output/);
      assert.match(log, /diagnostic/);
      assert.equal(readFileSync(join(dir, 'probe.exit-code'), 'utf8').trim(), String(code));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

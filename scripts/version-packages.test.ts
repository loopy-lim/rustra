import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caretMinorRange, syncReactNativeRange } from './version-packages.mjs';

test('caretMinorRange tracks the minor on 0.x and keeps major bumps on 1.x+', () => {
  assert.equal(caretMinorRange('0.4.0'), '^0.4.0');
  assert.equal(caretMinorRange('0.4.2'), '^0.4.0');
  assert.equal(caretMinorRange('1.2.3'), '^1.2.0');
  assert.throws(() => caretMinorRange('0.4'), /not a released x\.y\.z version/);
});

test('syncReactNativeRange rewrites only the range value and preserves formatting', () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-version-packages-'));
  try {
    const manifestPath = join(root, 'package.json');
    const original = [
      '{',
      '  "name": "@rustra/cli",',
      '  "rustraTemplate": {',
      '    "cargoRange": "^0.9.0",',
      '    "reactNativeRange": "^0.7.0"',
      '  }',
      '}',
      '',
    ].join('\n');
    writeFileSync(manifestPath, original);

    assert.equal(syncReactNativeRange(manifestPath, '0.8.0'), true, 'range moved');
    assert.deepEqual(
      readFileSync(manifestPath, 'utf8').split('\n'),
      original.replace('"reactNativeRange": "^0.7.0"', '"reactNativeRange": "^0.8.0"').split('\n'),
      'byte-identical except the range value',
    );

    assert.equal(syncReactNativeRange(manifestPath, '0.8.1'), false, 'already in range — no-op');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

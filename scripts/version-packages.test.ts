import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  caretMinorRange,
  syncLockWorkspaceMetadata,
  syncReactNativeRange,
} from './version-packages.mjs';

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

test('syncLockWorkspaceMetadata rewrites workspace version and internal ranges only', () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-version-packages-'));
  try {
    const lockPath = join(root, 'bun.lock');
    const lock = [
      '{',
      '  "workspaces": {',
      '    "": {',
      '      "name": "rustra-bridge",',
      '      "devDependencies": {',
      '        "typescript": "^5.9.0",',
      '      },',
      '    },',
      '    "packages/cli": {',
      '      "name": "@rustra/cli",',
      '      "version": "0.8.0",',
      '      "bin": {',
      '        "rustra": "./dist/index.js",',
      '      },',
      '      "dependencies": {',
      '        "@rustra/types": "^0.8.0",',
      '      },',
      '    },',
      '  },',
      '  "packages": {',
      '    "typescript@5.9.0": {',
      '      "version": "5.9.0",',
      '    },',
      '  },',
      '}',
      '',
    ].join('\n');
    writeFileSync(lockPath, lock);

    const manifests = {
      'packages/cli': { version: '0.9.0', dependencies: { '@rustra/types': '^0.9.0' } },
    };
    assert.equal(syncLockWorkspaceMetadata(lockPath, manifests), true);
    const updated = readFileSync(lockPath, 'utf8');
    assert.match(updated, /"@rustra\/cli",\n      "version": "0\.9\.0"/);
    assert.match(updated, /"@rustra\/types": "\^0\.9\.0"/);
    // 레지스트리 패키지 해석 영역과 무관 workspace 블록은 그대로.
    assert.match(updated, /"typescript@5\.9\.0": \{\n      "version": "5\.9\.0"/);
    assert.doesNotMatch(updated, /"typescript": "\^0\.9\.0"/);

    assert.equal(
      syncLockWorkspaceMetadata(lockPath, manifests),
      false,
      'already synced — no-op',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

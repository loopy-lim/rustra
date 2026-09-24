import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGeneratedManifest, checkGeneratedFiles } from '../src/manifest.js';

// Q4 — drift의 1차 소비자는 CI다. 변형(this 종류)만 바뀌고 "다음 행동"이 없는
// 메시지는 복구 시간을 늘린다. 9종 변형 전부가 doctor의 fix: 관례와 같은
// 재생성 힌트로 끝나는지 실제 checkGeneratedFiles 경로로 검증한다.
const HINT_SUFFIX = /Run rustra codegen --config rustra\.json\.$/;

async function expectDriftWithHint(run: () => Promise<void>, variant: RegExp): Promise<void> {
  await assert.rejects(run, (error: Error) => {
    assert.match(error.message, variant);
    assert.match(error.message, HINT_SUFFIX);
    return true;
  });
}

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('Generated drift messages carry the regeneration hint', () => {
  test('missing manifest file', async () => {
    const root = tempRoot('rustra-hint-missing-manifest-');
    try {
      const manifestPath = join(root, '.rustra-generated.json');
      await expectDriftWithHint(
        () => checkGeneratedFiles([], manifestPath),
        /Generated drift \(missing\): .*\.rustra-generated\.json/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('invalid manifest shape', async () => {
    const root = tempRoot('rustra-hint-invalid-manifest-');
    try {
      const manifestPath = join(root, '.rustra-generated.json');
      writeFileSync(manifestPath, '{}\n');
      await expectDriftWithHint(
        () => checkGeneratedFiles([], manifestPath),
        /Generated drift \(invalid manifest\)/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('schema changed', async () => {
    const root = tempRoot('rustra-hint-schema-');
    try {
      const manifestPath = join(root, '.rustra-generated.json');
      writeFileSync(manifestPath, `${JSON.stringify(buildGeneratedManifest('{}', '0.8.0', []))}\n`);
      await expectDriftWithHint(
        () => checkGeneratedFiles([], manifestPath, { schemaContent: 'edited' }),
        /Generated drift \(schema changed\): schema\.json/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('generator changed', async () => {
    const root = tempRoot('rustra-hint-generator-');
    try {
      const manifestPath = join(root, '.rustra-generated.json');
      writeFileSync(manifestPath, `${JSON.stringify(buildGeneratedManifest('{}', '0.8.0', []))}\n`);
      await expectDriftWithHint(
        () => checkGeneratedFiles([], manifestPath, { generatorVersion: '0.9.0' }),
        /Generated drift \(generator changed\): 0\.8\.0 -> 0\.9\.0/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('missing manifest entry for an expected file', async () => {
    const root = tempRoot('rustra-hint-no-entry-');
    try {
      const manifestPath = join(root, '.rustra-generated.json');
      writeFileSync(
        manifestPath,
        `${JSON.stringify(
          buildGeneratedManifest('{}', '0.8.0', [{ path: 'other.ts', content: 'x' }]),
        )}\n`,
      );
      writeFileSync(join(root, 'types.ts'), 'x\n');
      await expectDriftWithHint(
        () => checkGeneratedFiles([{ path: join(root, 'types.ts'), content: 'x\n' }], manifestPath),
        /Generated drift \(missing manifest entry\): .*types\.ts/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('missing generated file on disk', async () => {
    const root = tempRoot('rustra-hint-missing-file-');
    try {
      const manifestPath = join(root, '.rustra-generated.json');
      writeFileSync(
        manifestPath,
        `${JSON.stringify(
          buildGeneratedManifest('{}', '0.8.0', [{ path: 'types.ts', content: 'x' }]),
        )}\n`,
      );
      await expectDriftWithHint(
        () => checkGeneratedFiles([{ path: join(root, 'types.ts'), content: 'x' }], manifestPath),
        /Generated drift \(missing\): .*types\.ts/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('disk bytes changed', async () => {
    const root = tempRoot('rustra-hint-disk-');
    try {
      const manifestPath = join(root, '.rustra-generated.json');
      writeFileSync(join(root, 'types.ts'), 'old\n');
      writeFileSync(
        manifestPath,
        `${JSON.stringify(
          buildGeneratedManifest('{}', '0.8.0', [{ path: 'types.ts', content: 'new\n' }]),
        )}\n`,
      );
      await expectDriftWithHint(
        () =>
          checkGeneratedFiles([{ path: join(root, 'types.ts'), content: 'new\n' }], manifestPath),
        /Generated drift \(disk changed\): .*types\.ts/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('manifest stale', async () => {
    const root = tempRoot('rustra-hint-stale-');
    try {
      const manifestPath = join(root, '.rustra-generated.json');
      writeFileSync(join(root, 'types.ts'), 'new\n');
      writeFileSync(
        manifestPath,
        `${JSON.stringify(
          buildGeneratedManifest('{}', '0.8.0', [{ path: 'types.ts', content: 'old\n' }]),
        )}\n`,
      );
      await expectDriftWithHint(
        () =>
          checkGeneratedFiles([{ path: join(root, 'types.ts'), content: 'new\n' }], manifestPath),
        /Generated drift \(manifest stale\): .*types\.ts/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('unexpected manifest entry', async () => {
    const root = tempRoot('rustra-hint-unexpected-');
    try {
      const manifestPath = join(root, '.rustra-generated.json');
      writeFileSync(join(root, 'types.ts'), 'x');
      writeFileSync(
        manifestPath,
        `${JSON.stringify(
          buildGeneratedManifest('{}', '0.8.0', [
            { path: 'types.ts', content: 'x' },
            { path: 'extra.ts', content: 'x' },
          ]),
        )}\n`,
      );
      await expectDriftWithHint(
        () => checkGeneratedFiles([{ path: join(root, 'types.ts'), content: 'x' }], manifestPath),
        /Generated drift \(unexpected\): .*extra\.ts/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureHostDependencies } from './dependencies.js';
import { renderInitProjectFiles, templateVersions } from './init-template.js';

const ranges = {
  '@rustra/types': '^0.10.0',
  '@rustra/node': '^0.10.0',
  '@rustra/bun': '^0.10.0',
  '@rustra/tauri': '^0.9.0',
};
const node = { targetName: 'app', targetDirectoryUrl: './target/' };

for (const version of ['0.10.0', '0.10.2', '^0.10.0']) {
  test(`codegen preserves compatible ${version} pins and independent Tauri version`, async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'rustra-dependency-pin-'));
    const manifest = {
      dependencies: { '@rustra/types': version, '@rustra/tauri': '0.9.0' },
      devDependencies: { '@rustra/node': version },
    };
    try {
      await writeFile(join(appRoot, 'package.json'), JSON.stringify(manifest));
      await ensureHostDependencies({ appRoot, node, tauri: true }, ranges);
      assert.deepEqual(JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8')), manifest);
    } finally {
      await rm(appRoot, { recursive: true, force: true });
    }
  });
}
for (const version of ['0.9.9', '0.11.0', '0.10.1-beta.1', '*', 'latest']) {
  test(`codegen refuses incompatible or unbounded dependency ${version} without rewriting it`, async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'rustra-dependency-reject-'));
    const raw = JSON.stringify({ dependencies: { '@rustra/types': version } });
    try {
      await writeFile(join(appRoot, 'package.json'), raw);
      await assert.rejects(
        ensureHostDependencies({ appRoot, node }, ranges),
        /Align the Rustra release line/,
      );
      assert.equal(await readFile(join(appRoot, 'package.json'), 'utf8'), raw);
    } finally {
      await rm(appRoot, { recursive: true, force: true });
    }
  });
}
test('missing host dependencies use their independent ranges', async () => {
  const appRoot = await mkdtemp(join(tmpdir(), 'rustra-dependency-insert-'));
  try {
    await writeFile(join(appRoot, 'package.json'), '{}');
    await ensureHostDependencies({ appRoot, node, bun: node, tauri: true }, ranges);
    assert.deepEqual(
      JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8')).dependencies,
      ranges,
    );
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
});
test('CLI patch versions do not require an unpublished Node adapter patch', () => {
  const files = renderInitProjectFiles(templateVersions('0.10.1', '^0.10.0', '^0.10.0'), {
    reactNative: false,
    nodeRange: '^0.10.0',
  });
  const manifest = JSON.parse(files.packageJson);
  assert.equal(manifest.devDependencies['@rustra/cli'], '^0.10.1');
  assert.equal(manifest.dependencies['@rustra/node'], '^0.10.0');
});

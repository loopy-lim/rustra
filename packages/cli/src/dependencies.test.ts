import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureHostDependencies, ensureReactNativeDependency } from './dependencies.js';
import { renderInitProjectFiles, templateVersions } from './init-template.js';

const ranges = {
  '@rustra/types': '^0.10.0',
  '@rustra/node': '^0.10.0',
  '@rustra/bun': '^0.10.0',
  '@rustra/tauri': '^0.9.0',
};
const node = { targetName: 'app', targetDirectoryUrl: './target/' };

for (const covered of [true, false]) {
  test(`RN codegen registers modules at the owning monorepo root (covered=${covered})`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'rustra-monorepo-'));
    const app = join(root, 'apps/mobile');
    const workspaces = covered ? ['apps/*', 'apps/*/modules/*'] : ['apps/*'];
    try {
      await mkdir(app, { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ workspaces }));
      await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'mobile' }));
      await ensureReactNativeDependency(app, join(app, 'modules/bridge'), '^0.9.0');
      const child = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
      const owner = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      assert.equal(child.workspaces, undefined);
      assert.equal(child.dependencies['@rustra/generated-react-native'], 'workspace:*');
      assert.deepEqual(
        owner.workspaces,
        covered ? workspaces : ['apps/*', 'apps/mobile/modules/bridge'],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('standalone RN example does not modify an unrelated ancestor workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rustra-independent-app-'));
  const app = join(root, 'examples/mobile');
  const raw = JSON.stringify({ workspaces: ['packages/*'] });
  try {
    await mkdir(app, { recursive: true });
    await writeFile(join(root, 'package.json'), raw);
    await writeFile(join(app, 'package.json'), '{}');
    await ensureReactNativeDependency(app, join(app, 'modules/bridge'), '^0.9.0');
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), raw);
    assert.deepEqual(JSON.parse(await readFile(join(app, 'package.json'), 'utf8')).workspaces, [
      'modules/bridge',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const excluded of [true, false]) {
  test(`monorepo ownership respects brace globs and exclusions (excluded=${excluded})`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'rustra-glob-owner-'));
    const app = join(root, 'apps/mobile');
    const workspaces = {
      packages: [
        'apps/{mobile,web}',
        ...(excluded ? ['!apps/*/modules/{bridge,legacy}'] : ['apps/*/modules/*']),
      ],
      nohoist: ['react-native'],
    };
    const raw = JSON.stringify({ workspaces });
    try {
      await mkdir(app, { recursive: true });
      await writeFile(join(root, 'package.json'), raw);
      await writeFile(join(app, 'package.json'), '{}');
      const run = ensureReactNativeDependency(app, join(app, 'modules/bridge'), '^0.9.0');
      if (excluded) {
        await assert.rejects(run, /excluded by workspaces/);
        assert.equal(await readFile(join(app, 'package.json'), 'utf8'), '{}');
      } else {
        await run;
        assert.equal(
          JSON.parse(await readFile(join(app, 'package.json'), 'utf8')).workspaces,
          undefined,
        );
      }
      assert.equal(await readFile(join(root, 'package.json'), 'utf8'), raw);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

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

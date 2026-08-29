import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function packPackage(packageName, destination) {
  const packageRoot = join(repositoryRoot, 'packages', packageName);
  execFileSync('bun', ['pm', 'pack', '--cwd', packageRoot, '--destination', destination], {
    stdio: 'pipe',
  });
  const archives = readdirSync(destination).filter((name) => name.endsWith('.tgz'));
  if (archives.length !== 1) {
    throw new Error(`Expected one ${packageName} archive, found ${archives.length}`);
  }
  return join(destination, archives[0]);
}

export function createConsumerManifest({ typesArchive, cliArchive, reactNativeArchive }) {
  const typesSpecifier = `file:${typesArchive}`;
  return {
    name: 'rustra-packed-rn-consumer',
    private: true,
    type: 'module',
    dependencies: {
      '@rustra/types': typesSpecifier,
      '@rustra/cli': `file:${cliArchive}`,
      '@rustra/react-native': `file:${reactNativeArchive}`,
    },
    overrides: {
      '@rustra/types': typesSpecifier,
    },
  };
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'rustra-packed-rn-consumer-'));
  const archivesRoot = join(root, 'archives');
  try {
    const typesArchive = packPackage('types', join(archivesRoot, 'types'));
    const cliArchive = packPackage('cli', join(archivesRoot, 'cli'));
    const reactNativeArchive = packPackage('react-native', join(archivesRoot, 'react-native'));
    const reactNativeManifest = JSON.parse(
      readFileSync(join(repositoryRoot, 'packages/react-native/package.json'), 'utf8'),
    );
    const adapterRange = `^${reactNativeManifest.version}`;

    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify(createConsumerManifest({ typesArchive, cliArchive, reactNativeArchive })),
    );
    execFileSync(
      'bun',
      ['install', '--cwd', root, '--cache-dir', join(root, 'bun-cache'), '--no-progress'],
      { stdio: 'pipe' },
    );

    const types = await import(
      pathToFileURL(join(root, 'node_modules/@rustra/types/dist/index.js')).href,
    );
    if (typeof types.createComplexCodec !== 'function') {
      throw new Error('packed @rustra/types does not expose createComplexCodec');
    }

    const { renderReactNativeModule } = await import(
      pathToFileURL(join(root, 'node_modules/@rustra/cli/dist/index.js')).href,
    );
    const appRoot = join(root, 'app');
    const moduleDir = join(appRoot, 'modules/rustra-bridge');
    const files = renderReactNativeModule({
      appRoot,
      moduleDir,
      cppOutputPath: join(moduleDir, 'generated'),
      rustManifestPath: join(root, 'Cargo.toml'),
      rustPackage: 'packed-consumer',
      rustLibrary: 'packed_consumer',
      adapterRange,
    });
    const podspec = files['RustraBridge.podspec'];
    const gradle = files['android/build.gradle'];
    if (!podspec?.includes('node_modules/@rustra/react-native/native')) {
      throw new Error('packed consumer podspec did not resolve installed React Native native sources');
    }
    if (!gradle?.includes('node_modules/@rustra/react-native/native')) {
      throw new Error('packed consumer Gradle file did not resolve installed React Native native sources');
    }
    if (podspec.includes(`${repositoryRoot}/packages/react-native`)) {
      throw new Error('packed consumer accidentally resolved the repository source package');
    }
    console.log(`packed React Native consumer ok: adapter ${reactNativeManifest.version}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(repositoryRoot, 'packages', 'react-native');
const packageJsonPath = join(packageRoot, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

const requiredNativeFiles = [
  'native/android/rustra-jsi-jni.cpp',
  'native/cpp/RustraJSIBridge.cpp',
  'native/cpp/RustraJSIBridge.hpp',
  'native/cpp/rustra-codec.hpp',
  'native/ios/RustraJSIModule.mm',
];

const missingFromSource = requiredNativeFiles.filter(
  (relativePath) => !existsSync(join(packageRoot, relativePath)),
);
if (missingFromSource.length > 0) {
  throw new Error(`React Native adapter source is missing: ${missingFromSource.join(', ')}`);
}

const packPatterns = new Set(packageJson.files ?? []);
if (!packPatterns.has('native/**/*') && !packPatterns.has('native')) {
  throw new Error('packages/react-native/package.json must publish the native adapter directory');
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'rustra-react-native-pack-'));
try {
  execFileSync(
    'bun',
    ['pm', 'pack', '--cwd', packageRoot, '--destination', temporaryDirectory],
    { stdio: 'pipe' },
  );

  const archives = readdirSync(temporaryDirectory).filter((name) => name.endsWith('.tgz'));
  if (archives.length !== 1) {
    throw new Error(`Expected one React Native package archive, found ${archives.length}`);
  }

  const archivePath = join(temporaryDirectory, archives[0]);
  const archiveEntries = new Set(
    execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean),
  );
  const missingFromArchive = requiredNativeFiles.filter(
    (relativePath) => !archiveEntries.has(`package/${relativePath}`),
  );
  if (missingFromArchive.length > 0) {
    throw new Error(`React Native package archive is missing: ${missingFromArchive.join(', ')}`);
  }

  console.log(
    `React Native package ${packageJson.version} contains ${requiredNativeFiles.length} native adapter files`,
  );
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

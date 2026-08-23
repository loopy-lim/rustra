import { readFileSync } from 'node:fs';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const cargo = readFileSync('Cargo.toml', 'utf8');
const workspaceVersion = cargo.match(/^version = "([^"]+)"$/m)?.[1];
if (!workspaceVersion) throw new Error('workspace.package.version not found');

const cli = readJson('packages/cli/package.json');
const types = readJson('packages/types/package.json');
const cargoMinor = workspaceVersion.split('.').slice(0, 2).join('.');
const expectedTypesRange = `^${types.version}`;
const failures = [];

if (cli.rustraTemplate?.cargoMinor !== cargoMinor) {
  failures.push(
    `@rustra/cli rustraTemplate.cargoMinor=${cli.rustraTemplate?.cargoMinor} but crates=${cargoMinor}`,
  );
}
if (cli.dependencies?.['@rustra/types'] !== expectedTypesRange) {
  failures.push(
    `@rustra/cli depends on @rustra/types ${cli.dependencies?.['@rustra/types']} but release has ${expectedTypesRange}`,
  );
}

for (const name of ['bun', 'devtools', 'node', 'react-native', 'react', 'tauri', 'testing']) {
  const manifest = readJson(`packages/${name}/package.json`);
  if (manifest.dependencies?.['@rustra/types'] !== expectedTypesRange) {
    failures.push(
      `${manifest.name} depends on @rustra/types ${manifest.dependencies?.['@rustra/types']} but release has ${expectedTypesRange}`,
    );
  }
}

const lock = readFileSync('bun.lock', 'utf8');
for (const name of [
  'bun',
  'cli',
  'devtools',
  'node',
  'react-native',
  'react',
  'tauri',
  'testing',
  'types',
]) {
  const manifest = readJson(`packages/${name}/package.json`);
  const workspacePath = `packages/${name}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = lock.match(
    new RegExp(`"${workspacePath}"\\s*:\\s*\\{([\\s\\S]*?)\\n    \\},`),
  )?.[1];
  const lockedVersion = block?.match(/"version"\s*:\s*"([^"]+)"/)?.[1];
  if (lockedVersion !== manifest.version) {
    failures.push(
      `${manifest.name} lock version=${lockedVersion} but manifest=${manifest.version}`,
    );
  }
}

if (failures.length > 0) {
  console.error('release coherence failed:\n- ' + failures.join('\n- '));
  process.exit(1);
}
console.log(
  `release coherence ok: crates ${workspaceVersion}, cli ${cli.version}, types ${types.version}`,
);

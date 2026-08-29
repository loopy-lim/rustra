import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLISHED_PACKAGES = [
  'bun',
  'cli',
  'devtools',
  'node',
  'react-native',
  'react',
  'tauri',
  'testing',
  'types',
];

function readJson(root, relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(left, right) {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

function upperBoundForCaret(base) {
  if (base[0] > 0) return [base[0] + 1, 0, 0];
  if (base[1] > 0) return [0, base[1] + 1, 0];
  return [0, 0, base[2] + 1];
}

function rangeContainsVersion(range, version) {
  const parsedVersion = parseVersion(version);
  if (!parsedVersion) return false;
  const normalized = String(range).trim();
  if (!normalized || normalized === '*' || normalized === 'latest') return true;

  const comparatorParts = normalized.split(/\s+/).filter(Boolean);
  return comparatorParts.every((part) => {
    const match = /^(\^|~|>=|<=|>|<|=)?(\d+(?:\.\d+)?(?:\.\d+)?)$/.exec(part);
    if (!match) return false;
    const prefix = match[1] ?? '';
    const numbers = match[2].split('.').map(Number);
    const base = [numbers[0], numbers[1] ?? 0, numbers[2] ?? 0];
    if (prefix === '^') {
      return compareVersions(parsedVersion, base) >= 0 && compareVersions(parsedVersion, upperBoundForCaret(base)) < 0;
    }
    if (prefix === '~') {
      return compareVersions(parsedVersion, base) >= 0 && compareVersions(parsedVersion, [base[0], base[1] + 1, 0]) < 0;
    }
    if (prefix === '>=') return compareVersions(parsedVersion, base) >= 0;
    if (prefix === '<=') return compareVersions(parsedVersion, base) <= 0;
    if (prefix === '>') return compareVersions(parsedVersion, base) > 0;
    if (prefix === '<') return compareVersions(parsedVersion, base) < 0;
    if (prefix === '=') return compareVersions(parsedVersion, base) === 0;
    if (numbers.length === 1) return parsedVersion[0] === base[0];
    if (numbers.length === 2) return parsedVersion[0] === base[0] && parsedVersion[1] === base[1];
    return compareVersions(parsedVersion, base) === 0;
  });
}

function workspaceVersion(cargo) {
  const workspace = cargo.match(/\[workspace\.package\][\s\S]*?^version = "([^"]+)"/m)?.[1];
  if (!workspace) throw new Error('workspace.package.version not found');
  return workspace;
}

function lockWorkspaceBlock(lock, packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return lock.match(new RegExp(`"${escaped}"\\s*:\\s*\\{([\\s\\S]*?)\\n    \\},`))?.[1] ?? null;
}

function lockField(block, field) {
  return block?.match(new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`))?.[1];
}

/**
 * Check release metadata without requiring all public packages to share a
 * version. The return value is empty when the supplied repository is coherent.
 */
export function checkReleaseCoherence(root = process.cwd()) {
  const cargo = readFileSync(join(root, 'Cargo.toml'), 'utf8');
  const cargoVersion = workspaceVersion(cargo);
  const cli = readJson(root, 'packages/cli/package.json');
  const types = readJson(root, 'packages/types/package.json');
  const changesets = readJson(root, '.changeset/config.json');
  const lock = readFileSync(join(root, 'bun.lock'), 'utf8');
  const rootLicense = readFileSync(join(root, 'LICENSE'), 'utf8');
  const failures = [];

  const forcedPublicGroup = changesets.fixed?.find(
    (group) =>
      Array.isArray(group) &&
      group.length > 1 &&
      PUBLISHED_PACKAGES.every((name) => group.includes(`@rustra/${name}`)),
  );
  if (forcedPublicGroup) {
    failures.push('Changesets must not force all published @rustra/* packages into one fixed version group');
  }

  const cargoRange = cli.rustraTemplate?.cargoRange;
  if (typeof cargoRange !== 'string' || !rangeContainsVersion(cargoRange, cargoVersion)) {
    failures.push(`@rustra/cli rustraTemplate.cargoRange=${cargoRange} does not contain Rust ${cargoVersion}`);
  }

  const typesVersion = types.version;
  for (const name of PUBLISHED_PACKAGES) {
    const packagePath = `packages/${name}`;
    const manifest = readJson(root, `${packagePath}/package.json`);
    if (!parseVersion(manifest.version ?? '')) failures.push(`${manifest.name} has invalid version=${manifest.version}`);
    if (!manifest.files?.includes('LICENSE')) {
      failures.push(`${manifest.name} package files omit LICENSE`);
    }
    try {
      const packageLicense = readFileSync(join(root, `${packagePath}/LICENSE`), 'utf8');
      if (packageLicense !== rootLicense) failures.push(`${manifest.name} LICENSE differs from root LICENSE`);
    } catch {
      failures.push(`${manifest.name} LICENSE is missing`);
    }

    const block = lockWorkspaceBlock(lock, packagePath);
    if (!block) {
      failures.push(`${manifest.name} is missing from bun.lock workspaces`);
    } else if (lockField(block, 'version') !== manifest.version) {
      failures.push(`${manifest.name} lock version=${lockField(block, 'version')} but manifest=${manifest.version}`);
    }

    if (name !== 'types') {
      const dependencyRange = manifest.dependencies?.['@rustra/types'];
      if (typeof dependencyRange !== 'string' || !rangeContainsVersion(dependencyRange, typesVersion)) {
        failures.push(`${manifest.name} depends on @rustra/types ${dependencyRange}, which does not contain ${typesVersion}`);
      }
      const lockDependencyRange = block?.match(/"@rustra\/types"\s*:\s*"([^"]+)"/)?.[1];
      if (lockDependencyRange !== dependencyRange) {
        failures.push(`${manifest.name} lock @rustra/types=${lockDependencyRange} but manifest=${dependencyRange}`);
      }
    }
  }

  return failures;
}

function run() {
  const failures = checkReleaseCoherence();
  if (failures.length > 0) {
    console.error('release coherence failed:\n- ' + failures.join('\n- '));
    process.exitCode = 1;
    return;
  }
  const npmVersions = PUBLISHED_PACKAGES.map((name) => readJson(process.cwd(), `packages/${name}/package.json`).version);
  console.log(`release coherence ok: ${new Set(npmVersions).size} npm versions, Rust ${workspaceVersion(readFileSync(resolve('Cargo.toml'), 'utf8'))}`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) run();

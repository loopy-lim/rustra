import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const EXACT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NPM_REGISTRY = 'https://registry.npmjs.org/';
const CRATES_IO_SOURCES = new Set([
  'registry+https://github.com/rust-lang/crates.io-index',
  'registry+https://index.crates.io/',
]);

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function hashFiles(root, relativePaths) {
  const files = {};
  for (const relativePath of [...relativePaths].sort()) {
    const path = join(root, relativePath);
    if (existsSync(path)) files[relativePath] = sha256File(path);
  }
  return files;
}

export function generatedFiles(projectDir) {
  const root = join(projectDir, 'src', 'generated');
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path.slice(projectDir.length + 1));
    }
  };
  visit(root);
  return files.sort();
}

export function assertExactVersion(value, label) {
  if (typeof value !== 'string' || !EXACT_SEMVER.test(value))
    throw new Error(`${label} must be an exact version, received ${JSON.stringify(value)}`);
}

export function validateVersionManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1)
    throw new Error('version manifest schemaVersion must be 1');
  const npmNames = ['@rustra/cli', '@rustra/types', '@rustra/node', '@rustra/bun'];
  const rustNames = ['rustra', 'rustra-macros', 'rustra-naming'];
  if (
    !manifest.npm ||
    Object.keys(manifest.npm).sort().join('\n') !== [...npmNames].sort().join('\n')
  )
    throw new Error(`version manifest npm keys must be exactly ${npmNames.join(', ')}`);
  for (const name of npmNames) assertExactVersion(manifest.npm[name], `npm.${name}`);
  const phases = ['baseline', 'candidate', 'rollback'];
  if (
    !manifest.phases ||
    Object.keys(manifest.phases).sort().join('\n') !== [...phases].sort().join('\n')
  )
    throw new Error(`version manifest phases must be exactly ${phases.join(', ')}`);
  for (const phase of phases) {
    const versions = manifest.phases[phase];
    if (!versions || Object.keys(versions).sort().join('\n') !== [...rustNames].sort().join('\n'))
      throw new Error(`${phase} Rust keys must be exactly ${rustNames.join(', ')}`);
    for (const name of rustNames) assertExactVersion(versions[name], `${phase}.${name}`);
  }
  for (const name of rustNames) {
    if (manifest.phases.rollback[name] !== manifest.phases.baseline[name])
      throw new Error(`rollback ${name} must exactly equal baseline`);
    if (manifest.phases.candidate[name] === manifest.phases.baseline[name])
      throw new Error(`candidate ${name} must differ from baseline`);
  }
  // hosts — GUI/모바일 여정(tauri, react-native)이 쓰는 선택 정확 핀. Node/Bun CLI
  // 게이트는 이 섹션 없이도 그대로 통과해야 한다(키 검사는 엄격 유지).
  const hostNames = ['@rustra/tauri', '@rustra/react-native'];
  if (manifest.hosts !== undefined) {
    if (!manifest.hosts || typeof manifest.hosts !== 'object' || Array.isArray(manifest.hosts))
      throw new Error('version manifest hosts must be an object when present');
    for (const [name, version] of Object.entries(manifest.hosts)) {
      if (!hostNames.includes(name))
        throw new Error(`version manifest hosts has unknown key ${name}`);
      assertExactVersion(version, `hosts.${name}`);
    }
  }
  return manifest;
}

function manifestDependencySpecs(packageJson) {
  return {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
    ...(packageJson.optionalDependencies ?? {}),
  };
}

function cargoDependencyBlocks(cargo) {
  return cargo
    .split(/(?=^\[)/m)
    .filter((section) =>
      /^\[(?:target\.[^\]]+\.)?(?:build-)?dependencies(?:\.[^\]]+)?\]\s*$/m.test(section),
    );
}

export function assertNoConsumerContamination(
  projectDir,
  { expectedNpm, allowedWorkspacePackages = [] } = {},
) {
  const violations = [];
  const packagePath = join(projectDir, 'package.json');
  if (existsSync(packagePath)) {
    const manifest = readJson(packagePath);
    for (const field of ['overrides', 'resolutions', 'pnpm']) {
      if (manifest[field] !== undefined) violations.push(`package.json contains ${field}`);
    }
    for (const [name, spec] of Object.entries(manifestDependencySpecs(manifest))) {
      if (typeof spec !== 'string') {
        violations.push(`${name} has a non-string dependency spec`);
        continue;
      }
      if (/^(?:workspace:|file:|link:|git(?:\+|:)|https?:\/\/.*\.git(?:#|$))/.test(spec)) {
        // RN 코드젠 계약 — 생성된 네이티브 모듈은 workspace:* 로 등록된다
        // (ensureReactNativeDependency). 로컬 Rustra 소스 우회가 아니라 코드젠
        // 산출물이므로 여정마다 명시적으로 허용 목록에 넣어 쓴다.
        const isGeneratedWorkspace =
          spec === 'workspace:*' && allowedWorkspacePackages.includes(name);
        if (!isGeneratedWorkspace) violations.push(`${name} uses forbidden dependency source ${spec}`);
      }
      if (name.startsWith('@rustra/')) {
        const canonicalCliRange = expectedNpm?.[name] ? `^${expectedNpm[name]}` : null;
        if (!EXACT_SEMVER.test(spec) && spec !== canonicalCliRange && spec !== 'workspace:*')
          violations.push(`${name} uses unsupported version spec ${spec}`);
      }
    }
  }
  const cargoPath = join(projectDir, 'Cargo.toml');
  if (existsSync(cargoPath)) {
    const cargo = readFileSync(cargoPath, 'utf8');
    if (/^\s*\[patch(?:\.|\])/m.test(cargo)) violations.push('Cargo.toml contains [patch]');
    if (/^\s*\[replace\]/m.test(cargo)) violations.push('Cargo.toml contains [replace]');
    if (cargoDependencyBlocks(cargo).some((block) => /\b(?:path|git)\s*=/.test(block)))
      violations.push('Cargo.toml contains a path/git dependency');
    for (const name of ['rustra', 'rustra-macros', 'rustra-naming']) {
      const escaped = name.replaceAll('-', '\\-');
      // 두 표기 모두 잡는다 — `rustra = "x"` 와 `rustra = { version = "x", … }`.
      // brace 형태를 파싱하지 않으면 features 지정 소비자가 핀 없이 통과하고,
      // version 키 자체가 없으면(워크스페이스 상속 등) 최신 해석으로 뜬다.
      const stringMatch = cargo.match(new RegExp(`^${escaped}\\s*=\\s*"([^"]+)"`, 'm'));
      const braceMatch = cargo.match(new RegExp(`^${escaped}\\s*=\\s*\\{([^}]*)\\}`, 'm'));
      const spec = stringMatch
        ? stringMatch[1]
        : (braceMatch?.[1].match(/version\s*=\s*"([^"]+)"/)?.[1] ?? null);
      if (braceMatch && spec === null)
        violations.push(`${name} brace dependency declares no version pin`);
      if (spec !== null && !spec.startsWith('='))
        violations.push(`${name} is not pinned with =version`);
      if (spec !== null) assertExactVersion(spec.slice(1), `Cargo ${name}`);
    }
  }
  for (const name of ['cli', 'types', 'node', 'bun']) {
    const path = join(projectDir, 'node_modules', '@rustra', name);
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      violations.push(`${path} is a symlink`);
  }
  if (violations.length > 0)
    throw new Error(`consumer contamination detected:\n- ${violations.join('\n- ')}`);
  return { ok: true };
}

export function assertExactNpmProvenance(projectDir, expected) {
  const lock = readJson(join(projectDir, 'package-lock.json'));
  if (lock.lockfileVersion < 2 || !lock.packages)
    throw new Error('npm package-lock v2+ packages data is required');
  if (!lock.packages['']) throw new Error('package-lock is missing the root consumer entry');
  const proof = {};
  for (const [name, expectedVersion] of Object.entries(expected)) {
    assertExactVersion(expectedVersion, `expected npm ${name}`);
    const locked = lock.packages[`node_modules/${name}`];
    if (!locked) throw new Error(`package-lock is missing ${name}`);
    const packageDir = join(projectDir, 'node_modules', ...name.split('/'));
    if (!existsSync(packageDir)) throw new Error(`installed package is missing: ${name}`);
    if (lstatSync(packageDir).isSymbolicLink())
      throw new Error(`installed package ${name} is a symlink`);
    const installed = readJson(join(packageDir, 'package.json'));
    for (const [kind, actual] of [
      ['locked', locked.version],
      ['installed', installed.version],
    ]) {
      if (actual !== expectedVersion)
        throw new Error(
          `${name} ${kind} version ${actual} does not match expected ${expectedVersion}`,
        );
    }
    let resolved;
    try {
      resolved = new URL(locked.resolved);
    } catch {
      throw new Error(`${name} has a malformed package-lock resolved source: ${locked.resolved}`);
    }
    if (`${resolved.protocol}//${resolved.host}/` !== NPM_REGISTRY)
      throw new Error(`${name} has non-registry npm source ${locked.resolved}`);
    if (typeof locked.integrity !== 'string' || locked.integrity.length === 0)
      throw new Error(`${name} package-lock entry is missing integrity`);
    proof[name] = {
      version: expectedVersion,
      resolved: locked.resolved,
      integrity: locked.integrity,
      packageJsonSha256: sha256File(join(packageDir, 'package.json')),
      realpath: realpathSync(packageDir),
    };
  }
  return proof;
}

function cargoLockPackages(lockText) {
  return lockText
    .split(/^\[\[package\]\]\s*$/m)
    .slice(1)
    .map((block) => {
      const read = (key) => block.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'))?.[1] ?? null;
      return {
        name: read('name'),
        version: read('version'),
        source: read('source'),
        checksum: read('checksum'),
      };
    });
}

function assertCratesIoSource(source, label) {
  if (!CRATES_IO_SOURCES.has(source))
    throw new Error(`${label} must resolve from crates.io, received ${source}`);
}

function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function assertCargoProvenance({ metadata, lockText, expected, consumerManifestPath }) {
  if (!metadata || !Array.isArray(metadata.packages))
    throw new Error('Cargo metadata packages are required');
  const consumerPath = canonicalPath(consumerManifestPath);
  for (const pkg of metadata.packages) {
    const isRoot = canonicalPath(pkg.manifest_path) === consumerPath;
    if (pkg.source === null && !isRoot)
      throw new Error(
        `${pkg.name} has a non-registry Cargo source (only the root consumer may have source=null)`,
      );
    if (pkg.source !== null) assertCratesIoSource(pkg.source, pkg.name);
  }
  const lockedPackages = cargoLockPackages(lockText);
  const proof = {};
  for (const [name, expectedVersion] of Object.entries(expected)) {
    assertExactVersion(expectedVersion, `expected Cargo ${name}`);
    const resolvedPackages = metadata.packages.filter((pkg) => pkg.name === name);
    if (resolvedPackages.length !== 1)
      throw new Error(
        `Cargo metadata must resolve exactly one ${name}, found ${resolvedPackages.length}`,
      );
    const pkg = resolvedPackages[0];
    if (pkg.version !== expectedVersion)
      throw new Error(
        `${name} resolved version ${pkg.version} does not match expected ${expectedVersion}`,
      );
    assertCratesIoSource(pkg.source, name);
    const locked = lockedPackages.find(
      (entry) => entry.name === name && entry.version === expectedVersion,
    );
    if (!locked) throw new Error(`Cargo.lock is missing ${name} ${expectedVersion}`);
    assertCratesIoSource(locked.source, `Cargo.lock ${name}`);
    if (!locked.checksum) throw new Error(`Cargo.lock ${name} ${expectedVersion} lacks checksum`);
    proof[name] = {
      version: expectedVersion,
      source: pkg.source,
      lockSource: locked.source,
      checksum: locked.checksum,
      manifestPath: pkg.manifest_path,
    };
  }
  return proof;
}

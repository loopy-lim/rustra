/**
 * 코드젠 대상 Rust 입력의 내용 지문 — 웜 루프 계획(2026-09-20) §(b) Stage 1.
 *
 * mtime 만 보면 두 방향으로 모두 틀린다: 내용 불변인 재쓰기는 과트리거(불필요한
 * 전체 파이프라인), 같은 mtime 안의 연속 쓰기는 과소트리거(스킵이어야 할 틱에
 * stale 코드젠)다. 그래서 파일 **내용**을 해시한다. 해시 대상 트리는 감시자가
 * 걷는 것과 같다(watch.ts snapshotPath) — 빌드·캐시·VCS 디렉터리(target,
 * node_modules, .git)는 제외하고, 심볼릭 링크는 따라가지 않고 링크 텍스트를
 * 기록한다(트리 밖 추종과 디렉터리 사이클 진입을 막는 감시자의 no-follow 규약).
 *
 * 오래 계약 — 이 함수는 불확실성을 삼키지 않는다: 루트가 없거나(ENOENT) 걷는
 * 도중 어떤 fs 오류가 나면 그대로 throw 한다. dev 루프의 호출자는 throw 를
 * "스킵 금지"로 번역한다(전체 파이프라인 fail-safe — 판단 불가 시 스킵 없음).
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { readCargoMetadata, selectHostPackage, type CargoMetadata } from './cargo-metadata.js';
import { cargoInvocationInputs, cargoDepInfoBaseDirectories } from './cargo-config-inputs.js';
import { parse } from 'smol-toml';

/** 감시자와 같은 제외 규칙 — 빌드·캐시 트리는 지문에서도 소음일 뿐이다. */
const EXCLUDED_DIRECTORIES = new Set(['target', 'node_modules', '.git']);

/** 디렉터리 항목 순서는 readdir 규약상 무정의다 — 로캘 독립 비교로 정규화한다. */
function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function hashPath(
  hash: ReturnType<typeof createHash>,
  path: string,
  excluded: string[] = [],
): void {
  if (excluded.some((root) => path === root || path.startsWith(`${root}${sep}`))) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    // no-follow — 지문의 대상은 링크 텍스트다. 링크 대상 교체는 지문을 바꾸지만,
    // 대상 파일 내용의 변화는 감시 범위 밖이다(감시자도 같은 한계를 두었다).
    hash.update(`${path}\0`);
    hash.update(readlinkSync(path));
    return;
  }
  if (!stat.isDirectory()) {
    // 경로 프레이밍 — 내용만으로는 "어느 파일이 담겼는지"가 사라지므로 경로와
    // 내용을 NUL 로 구해 해시한다(경로·내용 접기 모호성 제거). 디렉터리 이름은
    // 자식 경로에 흡수되므로 따로 기록하지 않는다(빈 디렉터리는 cargo 입력이
    // 아니라 감시 소음).
    hash.update(`${path}\0`);
    hash.update(readFileSync(path));
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true }).sort(byName)) {
    if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    hashPath(hash, join(path, entry.name), excluded);
  }
}

/**
 * roots 에 담긴 파일·디렉터리 트리의 내용 지문(SHA-256 hex). 디렉터리는 재귀로
 * 걷되 감시자와 같은 제외 규칙을 적용한다. 순회 순서는 항목명 정규화로
 * 결정적이다 — 같은 트리는 항상 같은 지문을 낸다. fs 오류는 삼키지 않고
 * 전파한다(호출자의 fail-safe 계약 — 모듈 상단 주석).
 */
export function rustInputFingerprint(roots: string[]): string {
  const hash = createHash('sha256');
  for (const root of roots) hashPath(hash, root);
  return hash.digest('hex');
}

export type RustInputPaths = { trees: string[]; files: string[]; excluded?: string[] };
export type RustInputInvocation = { manifestPath: string; rustPackage?: string; cwd?: string };
type CargoTarget = CargoMetadata['packages'][number]['targets'][number];
type CargoOutput = { targets: CargoTarget[]; profileNames: Set<string> };

/**
 * Cargo source roots, local dependencies, build scripts and workspace-owned inputs.
 * Resolve all producers together: one producer's output directory may contain
 * another producer's source, so their exclusions cannot be merged independently.
 */
export function resolveRustInputPaths(
  manifestPath: string,
  rustPackage?: string,
  cwd = process.cwd(),
  additional: readonly RustInputInvocation[] = [],
): RustInputPaths {
  const trees = new Set<string>();
  const files = new Set<string>();
  const excluded = new Set<string>();
  const profilesByTarget = new Map<string, string[]>();
  const outputs = new Map<string, CargoOutput>();
  const sources = new Set<string>();
  const visited = new Set<string>();
  const visit = (
    manifest: string,
    requested: string | undefined,
    invocationCwd: string,
    known?: CargoMetadata,
  ): void => {
    const metadata = known ?? readCargoMetadata(manifest, invocationCwd);
    const pkg = selectHostPackage(metadata, manifest, requested);
    const manifestFile = resolve(pkg.manifest_path);
    const context = `${manifestFile}\0${invocationCwd}`;
    if (visited.has(context)) return;
    visited.add(context);
    const directory = dirname(manifestFile);
    const workspace = metadata.workspace_root ?? directory;
    trees.add(join(directory, 'src'));
    files.add(manifestFile);
    files.add(join(directory, 'build.rs'));
    files.add(join(workspace, 'Cargo.toml'));
    files.add(join(workspace, 'Cargo.lock'));
    for (const input of cargoInvocationInputs(directory, invocationCwd)) files.add(input);
    const targetDirectory =
      metadata.target_directory && canonicalInputPath(metadata.target_directory);
    if (targetDirectory) {
      let output = outputs.get(targetDirectory);
      if (!output) {
        output = { targets: [], profileNames: new Set(['debug', 'release']) };
        outputs.set(targetDirectory, output);
      }
      output.targets.push(...pkg.targets);
      const profile = parse(readFileSync(join(workspace, 'Cargo.toml'), 'utf8')).profile;
      if (profile && typeof profile === 'object') {
        for (const name of Object.keys(profile)) {
          if (
            !['dev', 'test', 'release', 'bench'].includes(name) &&
            !output.profileNames.has(name)
          ) {
            output.profileNames.add(name);
            profilesByTarget.delete(targetDirectory);
          }
        }
      }
    }
    for (const target of pkg.targets) {
      if (!target.src_path) continue;
      if (target.kind?.some((kind) => ['test', 'bench', 'example'].includes(kind))) continue;
      sources.add(canonicalInputPath(target.src_path));
      if (target.kind?.includes('custom-build')) files.add(target.src_path);
      else trees.add(dirname(target.src_path));
    }
    for (const dependency of pkg.dependencies ?? []) {
      if (!dependency.path) continue;
      const dependencyManifest = join(dependency.path, 'Cargo.toml');
      const inWorkspace = metadata.packages.some(
        (candidate) => resolve(candidate.manifest_path) === resolve(dependencyManifest),
      );
      visit(dependencyManifest, undefined, invocationCwd, inWorkspace ? metadata : undefined);
    }
    if (targetDirectory) {
      const output = outputs.get(targetDirectory)!;
      let profiles = profilesByTarget.get(targetDirectory);
      if (!profiles) {
        profiles = cargoArtifactProfiles(targetDirectory, output.profileNames);
        profilesByTarget.set(targetDirectory, profiles);
      }
      const generated = cargoOutputExclusions(targetDirectory, output, profiles, sources);
      for (const profile of profiles) {
        for (const target of pkg.targets) {
          if (
            target.kind?.some((kind) => ['test', 'bench', 'example', 'custom-build'].includes(kind))
          )
            continue;
          const library = !target.kind?.includes('bin') && !target.crate_types.includes('bin');
          const name = library ? target.name.replace(/-/g, '_') : target.name;
          const depfile = join(profile, `${library ? 'lib' : ''}${name}.d`);
          let content: string;
          try {
            content = readFileSync(depfile, 'utf8');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
          }
          const rawDependencies = cargoDepInfoPaths(content);
          const bases = rawDependencies.some((path) => !isAbsolute(path))
            ? cargoDepInfoBaseDirectories(directory, invocationCwd)
            : [];
          const source = target.src_path && canonicalInputPath(target.src_path);
          const base = bases.find((candidate) =>
            rawDependencies.some((path) => canonicalInputPath(resolve(candidate, path)) === source),
          );
          const dependencies: string[] = [];
          for (const path of rawDependencies) {
            if (isAbsolute(path)) dependencies.push(path);
            else if (base !== undefined) dependencies.push(resolve(base, path));
          }
          if (
            target.src_path &&
            !dependencies.some(
              (path) => canonicalInputPath(path) === canonicalInputPath(target.src_path!),
            )
          )
            continue;
          for (const dependency of dependencies) {
            const path = canonicalInputPath(dependency);
            if (generated.some((root) => path === root || path.startsWith(`${root}${sep}`)))
              continue;
            if ([...trees].some((tree) => path === tree || path.startsWith(`${tree}${sep}`)))
              continue;
            try {
              if (lstatSync(path).isDirectory()) trees.add(path);
              else files.add(path);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              files.add(path);
            }
          }
        }
      }
    }
  };
  visit(manifestPath, rustPackage, resolve(cwd));
  for (const invocation of additional)
    visit(invocation.manifestPath, invocation.rustPackage, resolve(invocation.cwd ?? cwd));
  for (const [directory, output] of outputs) {
    for (const path of cargoOutputExclusions(
      directory,
      output,
      cargoArtifactProfiles(directory, output.profileNames),
      sources,
    ))
      excluded.add(path);
  }
  const distinctTrees = [...trees]
    .sort()
    .filter(
      (tree, _, all) => !all.some((other) => tree !== other && tree.startsWith(`${other}${sep}`)),
    );
  return { trees: distinctTrees, files: [...files].sort(), excluded: [...excluded].sort() };
}

/** Missing optional inputs still contribute their path, so creation/deletion invalidates. */
export function devInputFingerprint(paths: RustInputPaths): string {
  const hash = createHash('sha256');
  const excluded = (paths.excluded ?? []).map(canonicalInputPath);
  for (const path of [...paths.trees, ...paths.files]) {
    let canonical: string;
    try {
      canonical = realpathSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hash.update(`missing:${path}\0`);
      continue;
    }
    // Follow the subscribed root like its watcher; nested links stay no-follow.
    // Errors during traversal propagate: a torn read is not a valid skip basis.
    hash.update(`${path}\0`);
    hashPath(hash, canonical, excluded);
  }
  return hash.digest('hex');
}

/** Canonicalize existing parents too, since a generated output may not exist yet. */
function canonicalInputPath(path: string): string {
  path = resolve(path);
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    return parent === path ? path : join(canonicalInputPath(parent), basename(path));
  }
}

function cargoArtifactProfiles(targetDirectory: string, names: ReadonlySet<string>): string[] {
  // Include profiles before the first build so new output files are already excluded.
  const profiles = new Set([...names].map((name) => join(targetDirectory, name)));
  let entries;
  try {
    entries = readdirSync(targetDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [...profiles];
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const directory = join(targetDirectory, entry.name);
    if (names.has(entry.name)) continue;
    for (const nested of readdirSync(directory, { withFileTypes: true })) {
      if (nested.isDirectory() && names.has(nested.name))
        profiles.add(join(directory, nested.name));
    }
  }
  return [...profiles];
}

/** A target directory may contain the crate itself (for example target-dir="."). */
function cargoOutputExclusions(
  directory: string,
  output: CargoOutput,
  profiles: string[],
  sources: ReadonlySet<string>,
): string[] {
  const containsSource = (root: string) =>
    [...sources].some((source) => source === root || source.startsWith(`${root}${sep}`));
  if (!containsSource(directory)) return [directory];
  const generated = [join(directory, '.rustc_info.json'), join(directory, 'CACHEDIR.TAG')];
  for (const profile of profiles) {
    for (const name of [
      'deps',
      'build',
      'incremental',
      'examples',
      '.fingerprint',
      '.cargo-lock',
      '.cargo-build-lock',
      '.cargo-artifact-lock',
    ])
      generated.push(join(profile, name));
    for (const target of output.targets) {
      if (target.kind?.includes('custom-build')) continue;
      const library = !target.kind?.includes('bin') && !target.crate_types.includes('bin');
      const name = library ? target.name.replace(/-/g, '_') : target.name;
      const stem = library ? `lib${name}` : name;
      generated.push(join(profile, `${stem}.d`));
      for (const suffix of library
        ? ['.rlib', '.rmeta', '.a', '.so', '.dylib', '.dylib.dSYM']
        : ['', '.exe', '.dSYM'])
        generated.push(join(profile, `${stem}${suffix}`));
      for (const suffix of ['.dll', '.lib', '.pdb'])
        generated.push(join(profile, `${name}${suffix}`));
    }
  }
  return generated.filter((path) => !containsSource(path));
}

/** Parse the first Makefile rule, including escaped spaces and continuations. */
function cargoDepInfoPaths(content: string): string[] {
  const line = content.replace(/\\\r?\n/g, ' ').split(/\r?\n/)[0] ?? '';
  const boundary = line.indexOf(': ');
  if (boundary < 0) return [];
  const paths: string[] = [];
  let current = '';
  for (let index = boundary + 2; index < line.length; index++) {
    const char = line[index]!;
    if (char === '\\' && /[\s\\]/.test(line[index + 1] ?? '')) {
      current += line[++index];
    } else if (/\s/.test(char)) {
      if (current) paths.push(current);
      current = '';
    } else current += char;
  }
  if (current) paths.push(current);
  return paths;
}

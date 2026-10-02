import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';

/** Configs used by Cargo launched from the CLI cwd or a selected crate. */
export function cargoConfigInputs(manifestDirectory: string, cwd = process.cwd()): string[] {
  const paths = new Set<string>();
  for (const start of [manifestDirectory, cwd]) {
    for (let directory = resolve(start); ; directory = dirname(directory)) {
      paths.add(join(directory, '.cargo', 'config.toml'));
      paths.add(join(directory, '.cargo', 'config'));
      if (dirname(directory) === directory) break;
    }
  }
  const cargoHome = resolve(cwd, process.env.CARGO_HOME ?? join(homedir(), '.cargo'));
  paths.add(join(cargoHome, 'config.toml'));
  paths.add(join(cargoHome, 'config'));
  return [...paths].sort();
}

/** Toolchain selection is also an input to Cargo launched from this cwd. */
export function cargoInvocationInputs(manifestDirectory: string, cwd = process.cwd()): string[] {
  const paths = new Set(cargoConfigInputs(manifestDirectory, cwd));
  for (const start of [manifestDirectory, cwd]) {
    for (let directory = resolve(start); ; directory = dirname(directory)) {
      paths.add(join(directory, 'rust-toolchain'));
      paths.add(join(directory, 'rust-toolchain.toml'));
      if (dirname(directory) === directory) break;
    }
  }
  return [...paths].sort();
}

/** Candidate bases for previously built dep-info, validated against its source target. */
export function cargoDepInfoBaseDirectories(
  manifestDirectory: string,
  cwd = process.cwd(),
): string[] {
  const bases = new Set<string>();
  const environment = process.env.CARGO_BUILD_DEP_INFO_BASEDIR;
  if (environment !== undefined) {
    bases.add(resolve(cwd, environment));
    bases.add(resolve(manifestDirectory, environment));
  }
  for (const path of cargoConfigInputs(manifestDirectory, cwd)) {
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const build = parse(content).build;
    if (build && typeof build === 'object' && 'dep-info-basedir' in build) {
      const base = build['dep-info-basedir'];
      // Cargo config paths are relative to the parent of the .cargo directory.
      if (typeof base === 'string') bases.add(resolve(dirname(dirname(path)), base));
    }
  }
  return [...bases];
}

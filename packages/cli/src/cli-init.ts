import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { renderInitProjectFiles, templateVersions } from './init-template.js';
import { cliManifest, cliVersion } from './cli-runtime.js';

export async function runInit(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) return;
  const force = args.includes('--force');
  const directories = args.filter((argument) => !argument.startsWith('--'));
  if (directories.length !== 1)
    throw new Error('Provide one project directory. Usage: rustra init my-project [--force]');
  const root = resolve(directories[0]!);
  const versions = templateVersions(
    cliVersion,
    cliManifest.dependencies['@rustra/types'],
    cliManifest.rustraTemplate.cargoRange,
  );
  const files = renderInitProjectFiles(versions);
  const contents: Record<string, string> = {
    'Cargo.toml': files.cargoToml,
    'src/lib.rs': files.libRs,
    'src/main.rs': files.mainRs,
    'src/bin/generate.rs': files.generateRs,
    'src/index.ts': files.appTs,
    'package.json': files.packageJson,
    'rustra.json': files.rustraJson,
    '.gitignore': files.gitignore,
    'tsconfig.json': files.tsconfig,
  };
  const existing = Object.keys(contents).filter((file) => existsSync(resolve(root, file)));
  if (existing.length > 0 && !force)
    throw new Error(
      `Refusing to overwrite existing files in ${root}: ${existing.join(', ')}. Re-run with --force to replace them.`,
    );
  for (const [file, content] of Object.entries(contents)) {
    const path = resolve(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  console.log(`Created rustra project in ${root}:`);
  console.log(`  ${Object.keys(contents).join(', ')}`);
  console.log('\nNext steps:');
  console.log(`  cd ${directories[0]}`);
  console.log('  bun install');
  console.log('  bun run codegen');
  console.log('  bun run demo');
  console.log('  cargo run');
}

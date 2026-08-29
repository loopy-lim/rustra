import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnInherit } from './process.js';
import { readConfigSync } from './config.js';
import { resolveCodegenTarget } from './host-entries.js';
import { runGenerate } from './cli-generate.js';
import { parseCodegenArgs, type CliOutputFormat } from './cli-options.js';

function status(format: CliOutputFormat | undefined, message: string): void {
  (format === 'json' ? console.error : console.log)(message);
}

export async function runCodegen(args: string[]): Promise<void> {
  const options = parseCodegenArgs(args);
  if (options.help) return;
  const configPath = resolve(options.configPath!);
  const config = readConfigSync(configPath);
  const target = resolveCodegenTarget(configPath, config);
  const manifestPath = resolve(dirname(configPath), config.output, '.rustra-generated.json');
  if (options.check && !existsSync(manifestPath))
    throw new Error(`Generated check requires ${manifestPath}; run rustra codegen first`);
  status(
    options.format,
    `[rustra] Rust schema: cargo run --manifest-path ${target.manifestPath} --package ${target.packageName} --bin ${target.binaryName}`,
  );
  const checkRoot = options.check
    ? await mkdtemp(resolve(tmpdir(), 'rustra-codegen-check-'))
    : null;
  try {
    try {
      await spawnInherit(
        'cargo',
        [
          'run',
          '--manifest-path',
          target.manifestPath,
          '--package',
          target.packageName,
          '--bin',
          target.binaryName,
        ],
        target.cwd,
        {
          ...(checkRoot ? { env: { RUSTRA_SCHEMA_OUT: checkRoot } } : {}),
          progressLabel: `Rust schema generation (${target.packageName}/${target.binaryName})`,
          progressStream: options.format === 'json' ? 'stderr' : 'stdout',
          childOutput: options.format === 'json' ? 'stderr' : 'inherit',
        },
      );
    } catch (error) {
      throw new Error(
        `Rust schema generation failed for ${target.packageName}/${target.binaryName} (${target.manifestPath}): ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (checkRoot) {
      const temporarySchema = resolve(checkRoot, 'schema.json');
      if (!existsSync(temporarySchema))
        throw new Error(
          `Rust codegen did not produce ${temporarySchema}; the generator must honor RUSTRA_SCHEMA_OUT in check mode`,
        );
      status(options.format, `[rustra] TypeScript/C++: generate --config ${configPath} --check`);
      try {
        await runGenerate(
          [
            '--config',
            configPath,
            '--check',
            ...(options.format ? ['--format', options.format] : []),
          ],
          temporarySchema,
          { quiet: true },
        );
      } catch (error) {
        throw new Error(
          `TypeScript/C++ generation check failed for ${configPath} (schema ${temporarySchema}): ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
  } finally {
    if (checkRoot) await rm(checkRoot, { recursive: true, force: true });
  }
  if (options.check) {
    if (options.format === 'json')
      console.log(JSON.stringify({ command: 'codegen', checked: true, configPath }));
    return;
  }
  status(options.format, `[rustra] TypeScript/C++: generate --config ${configPath}`);
  try {
    const files = await runGenerate(
      ['--config', configPath, ...(options.format ? ['--format', options.format] : [])],
      undefined,
      { quiet: true },
    );
    if (options.format === 'json')
      console.log(JSON.stringify({ command: 'codegen', checked: false, configPath, files }));
  } catch (error) {
    throw new Error(
      `TypeScript/C++ generation failed for ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

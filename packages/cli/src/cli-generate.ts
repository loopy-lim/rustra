import { dirname, resolve } from 'node:path';
import type { ReactNativeScaffoldOptions } from './react-native.js';
import { readConfigSync, type RustraConfig } from './config.js';
import { createFileWatch, createWatchLoop, type WatchHandle } from './watch.js';
import {
  resolveHostEntries,
  resolveReactNativeScaffold,
  type HostEntries,
} from './host-entries.js';
import { parseGenerateArgs, type GenerateOptions } from './cli-options.js';
import { cliManifest, cliVersion } from './cli-runtime.js';
import { generateFromSchema } from './cli-generate-files.js';
import { autoRebuild } from './cli-rebuild.js';

export async function runGenerate(
  args: string[],
  schemaOverride?: string,
  internal: { quiet?: boolean } = {},
): Promise<string[]> {
  const options = parseGenerateArgs(args);
  if (options.help) return [];
  autoRebuild();
  const paths = resolvePaths(options, schemaOverride);
  const written = await generateFromSchema(
    paths.schemaPath,
    paths.outputPath,
    paths.cppOutputPath,
    paths.positional,
    paths.reactNativeScaffold,
    paths.hostEntries,
    options.check,
  );
  if (!internal.quiet) {
    if (options.format === 'json') {
      console.log(
        JSON.stringify({
          command: 'generate',
          checked: Boolean(options.check),
          outputPath: paths.outputPath,
          files: written,
        }),
      );
    } else {
      console.log(
        `${options.check ? 'Verified' : 'Generated'} TypeScript files in ${paths.outputPath}:`,
      );
      for (const file of written) console.log(`  ${file}`);
    }
  }
  return written;
}

function resolvePaths(
  options: GenerateOptions,
  schemaOverride?: string,
): {
  schemaPath: string;
  outputPath: string;
  cppOutputPath?: string;
  positional?: boolean;
  reactNativeScaffold?: ReactNativeScaffoldOptions;
  hostEntries?: HostEntries;
} {
  let schemaPath: string;
  let outputPath: string;
  let config: RustraConfig | undefined;
  if (options.configPath) {
    config = readConfigSync(options.configPath);
    schemaPath = resolve(dirname(options.configPath), config.schema);
    outputPath = resolve(dirname(options.configPath), config.output);
  } else if (options.schemaPath && options.outputPath) {
    schemaPath = options.schemaPath;
    outputPath = options.outputPath;
  } else throw new Error('Provide --schema and --output, or --config with a config file.');
  if (schemaOverride) schemaPath = schemaOverride;
  const reactNativeScaffold = config?.reactNative
    ? resolveReactNativeScaffold(
        config,
        options.configPath!,
        cliManifest.rustraTemplate.reactNativeRange,
      )
    : undefined;
  const cppOutputPath = options.cppOutputPath
    ? resolve(options.cppOutputPath)
    : config?.cppOutput
      ? resolve(dirname(options.configPath!), config.cppOutput)
      : reactNativeScaffold?.cppOutputPath;
  const resolvedOutputPath = resolve(outputPath);
  return {
    schemaPath: resolve(schemaPath),
    outputPath: resolvedOutputPath,
    cppOutputPath,
    positional: options.positional ?? config?.positional,
    reactNativeScaffold: reactNativeScaffold
      ? { ...reactNativeScaffold, cppOutputPath: cppOutputPath! }
      : undefined,
    hostEntries: config
      ? resolveHostEntries(config, options.configPath!, resolvedOutputPath)
      : undefined,
  };
}

export async function runWatch(args: string[]): Promise<WatchHandle> {
  const options = parseGenerateArgs(args);
  if (options.help) return { dispose() {} };
  const paths = resolvePaths(options);
  await generateFromSchema(
    paths.schemaPath,
    paths.outputPath,
    paths.cppOutputPath,
    paths.positional,
    paths.reactNativeScaffold,
    paths.hostEntries,
  );
  console.log(`\nWatching ${paths.schemaPath} for changes...`);
  const loop = createWatchLoop(
    async () => {
      try {
        await generateFromSchema(
          paths.schemaPath,
          paths.outputPath,
          paths.cppOutputPath,
          paths.positional,
          paths.reactNativeScaffold,
          paths.hostEntries,
        );
        console.log(`[${new Date().toLocaleTimeString()}] Regenerated`);
      } catch (error) {
        console.error(`Regeneration failed: ${error instanceof Error ? error.message : error}`);
      }
    },
    () => true,
    100,
  );
  const fileWatch = createFileWatch([
    {
      path: dirname(paths.schemaPath),
      onChange: (_path, filename) => {
        if (filename && resolve(dirname(paths.schemaPath), filename) === resolve(paths.schemaPath))
          loop.schedule('schema change');
      },
    },
  ]);
  return {
    dispose() {
      loop.dispose();
      fileWatch.dispose();
    },
  };
}

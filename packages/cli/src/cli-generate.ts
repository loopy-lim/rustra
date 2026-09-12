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
import { UsageError } from './cli-usage-error.js';
import { cliManifest } from './cli-runtime.js';
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
  } else throw new UsageError('Provide --schema and --output, or --config with a config file.');
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
  let paths = resolvePaths(options);
  let schemaWatch: WatchHandle | undefined;
  let disposed = false;
  async function regenerate(): Promise<void> {
    paths = resolvePaths(options);
    if (schemaWatch && !disposed) subscribeSchema();
    await generateFromSchema(
      paths.schemaPath,
      paths.outputPath,
      paths.cppOutputPath,
      paths.positional,
      paths.reactNativeScaffold,
      paths.hostEntries,
    );
  }
  await regenerate();
  console.log(`\nWatching ${paths.schemaPath} for changes...`);
  const loop = createWatchLoop(
    async () => {
      try {
        // 재구독은 regenerate() 안에서(설정 재해석 직후, 산출물 쓰기 전) 일어난다.
        // 여기서 다시 구독하면 재생성이 끝나는 순간의 재스냅샷이 그 사이에 들어온
        // 스키마 변경을 삼킨다 — 폴링 감시자가 죽은 유일한 창이다.
        await regenerate();
        console.log(`[${new Date().toLocaleTimeString()}] Regenerated`);
      } catch (error) {
        console.error(`Regeneration failed: ${error instanceof Error ? error.message : error}`);
      }
    },
    () => true,
    100,
  );
  function subscribeSchema(): void {
    schemaWatch?.dispose();
    schemaWatch = createFileWatch([
      { path: paths.schemaPath, onChange: () => loop.schedule('schema change') },
    ]);
  }
  subscribeSchema();
  const configWatch = createFileWatch(
    options.configPath
      ? [{ path: resolve(options.configPath), onChange: () => loop.schedule('config change') }]
      : [],
  );
  return {
    dispose() {
      disposed = true;
      loop.dispose();
      schemaWatch?.dispose();
      configWatch.dispose();
    },
  };
}

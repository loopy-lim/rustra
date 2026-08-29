import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { PackageSchema } from './schema.js';
import { parsePackageSchema } from './schema-validation.js';
import {
  generateTypesTs,
  generateCommandsTs,
  generateEventsTs,
  generateContractTs,
  generateRkyvCodecsTs,
  generateRkyvRegistryTs,
  generateRkyvCodecsHpp,
  generateRkyvCodecsCpp,
  generatePositionalFacadeTs,
} from './generate.js';
import { renderReactNativeModule, type ReactNativeScaffoldOptions } from './react-native.js';
import {
  generateBunEntryTs,
  generateNodeEntryTs,
  generateReactNativeEntryTs,
  generateTauriEntryTs,
} from './init-template.js';
import {
  buildGeneratedManifest,
  checkGeneratedFiles,
  manifestPathFor,
  type GeneratedFile,
} from './manifest.js';
import { ensureHostDependencies, ensureReactNativeDependency } from './dependencies.js';
import type { HostEntries } from './host-entries.js';
import { cliVersion } from './cli-runtime.js';

export async function generateFromSchema(
  schemaPath: string,
  outputPath: string,
  cppOutputPath?: string,
  positional = false,
  reactNativeScaffold?: ReactNativeScaffoldOptions,
  hostEntries?: HostEntries,
  check = false,
): Promise<string[]> {
  const schemaContent = await readFile(schemaPath, 'utf-8');
  const schema: PackageSchema = parsePackageSchema(JSON.parse(schemaContent));
  warnIfFieldOrderIsUnspecified(schema);
  const files: GeneratedFile[] = [];
  const addFile = (targetDir: string, name: string, content: string) =>
    files.push({ path: resolve(targetDir, name), content });
  addFile(outputPath, 'types.ts', generateTypesTs(schema));
  addFile(outputPath, 'commands.ts', generateCommandsTs(schema));
  addFile(outputPath, 'contract.ts', generateContractTs(schemaContent));
  addFile(outputPath, 'rkyv-codecs.ts', generateRkyvCodecsTs(schema));
  addFile(outputPath, 'rkyv-registry.ts', generateRkyvRegistryTs(schema));
  const events = generateEventsTs(schema);
  if (events) addFile(outputPath, 'events.ts', events);
  if (positional) addFile(outputPath, 'positional-facade.ts', generatePositionalFacadeTs(schema));
  if (reactNativeScaffold) addFile(outputPath, 'react-native.ts', generateReactNativeEntryTs());
  if (hostEntries?.node) addFile(outputPath, 'node.ts', generateNodeEntryTs(hostEntries.node));
  if (hostEntries?.bun) addFile(outputPath, 'bun.ts', generateBunEntryTs(hostEntries.bun));
  if (hostEntries?.tauri) addFile(outputPath, 'tauri.ts', generateTauriEntryTs());
  if (cppOutputPath) {
    addFile(cppOutputPath, 'rustra-generated-codecs.hpp', generateRkyvCodecsHpp(schema));
    addFile(cppOutputPath, 'rustra-generated-codecs.cpp', generateRkyvCodecsCpp(schema));
  }
  if (reactNativeScaffold) {
    for (const [name, content] of Object.entries(renderReactNativeModule(reactNativeScaffold)))
      addFile(reactNativeScaffold.moduleDir, name, content);
  }
  const written: string[] = [];
  if (check) {
    written.push(...files.map((file) => `${manifestPathFor(outputPath, file.path)} (verified)`));
    await checkGeneratedFiles(files, resolve(outputPath, '.rustra-generated.json'), {
      schemaContent,
      generatorVersion: cliVersion,
    });
    return written;
  }
  for (const file of files) {
    let existing: string | null = null;
    try {
      existing = await readFile(file.path, 'utf-8');
    } catch {
      /* missing */
    }
    const relativePath = manifestPathFor(outputPath, file.path);
    if (existing === file.content) written.push(`${relativePath} (unchanged)`);
    else {
      await mkdir(dirname(file.path), { recursive: true });
      await writeFile(file.path, file.content);
      written.push(existing === null ? relativePath : `${relativePath} (updated)`);
    }
  }
  if (reactNativeScaffold)
    await ensureReactNativeDependency(
      reactNativeScaffold.appRoot,
      reactNativeScaffold.moduleDir,
      reactNativeScaffold.adapterRange,
    );
  if (hostEntries) await ensureHostDependencies(hostEntries, cliVersion);
  await writeFile(
    resolve(outputPath, '.rustra-generated.json'),
    `${JSON.stringify(
      buildGeneratedManifest(
        schemaContent,
        cliVersion,
        files.map((file) => ({
          path: manifestPathFor(outputPath, file.path),
          content: file.content,
        })),
      ),
      null,
      2,
    )}\n`,
  );
  return written;
}

function warnIfFieldOrderIsUnspecified(schema: PackageSchema): void {
  if (schema.fieldOrder === 'declaration') return;
  let suspects = 0;
  for (const command of schema.commands)
    for (const current of [command.inputSchema, command.outputSchema]) {
      const names = Object.keys(current.properties ?? {});
      if (names.length > 1 && JSON.stringify(names) === JSON.stringify([...names].sort()))
        suspects++;
    }
  if (suspects >= 3)
    console.warn(
      `[rustra] WARN: ${suspects} field sets appear alphabetically sorted and the schema has no fieldOrder=declaration guarantee; regenerate with current rustra or verify field order manually.`,
    );
}

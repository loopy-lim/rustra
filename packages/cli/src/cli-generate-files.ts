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
import { generatedFileHeader } from './generated-header.js';
import {
  clearCodegenWarnings,
  formatCodegenWarning,
  takeCodegenWarnings,
} from './codegen-warnings.js';

/** 파일명 → 생성 단계 표기. 헤더의 "Stage:" 행이 다중 표면 출처를 대답한다. */
function stageFor(fileName: string): string {
  if (fileName.endsWith('.hpp') || fileName.endsWith('.cpp')) return 'schema → cpp codec renderer';
  if (fileName === 'rkyv-codecs.ts' || fileName === 'rkyv-registry.ts')
    return 'schema → ts codec renderer';
  if (fileName === 'positional-facade.ts') return 'schema → positional facade';
  if (['node.ts', 'bun.ts', 'tauri.ts', 'react-native.ts'].includes(fileName))
    return 'schema → host entry';
  return 'rust-probe schema → ts renderer';
}

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
  clearCodegenWarnings();
  const files: GeneratedFile[] = [];
  // 자기서술 헤더는 이 한 곳에서 주입한다 — 렌더러 개별 모듈은 헤더를 모른다.
  // 단, 렌더러가 이미 헤더를 각인하는 파일(C++ 코덱 등)은 이중 접합하지 않는다.
  const addFile = (targetDir: string, name: string, content: string) =>
    files.push({
      path: resolve(targetDir, name),
      content: content.startsWith('// ── rustra generated')
        ? content
        : `${generatedFileHeader(name, stageFor(name))}${content}`,
    });
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
  // 코드젠 경고는 생성 파일 바이트와 무관한 별도 진행 채널 — stderr 로 출력해
  // 머신이 읽는 stdout(JSON 리포트)을 오염시키지 않는다.
  for (const warning of takeCodegenWarnings()) console.error(formatCodegenWarning(warning));
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

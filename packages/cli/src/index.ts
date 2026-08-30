#!/usr/bin/env node
import { isCliEntry } from './cli-runtime.js';
import { main } from './cli-main.js';

export * from './generate.js';
export type { PackageSchema, CommandSchema, JsonSchema } from './schema.js';
export { diffSchemas, formatDiffResult } from './schema-diff.js';
export type { BreakingChange, DiffResult } from './schema-diff.js';
export { createValidatedEngine } from './validate-engine.js';
export type { EngineClient as ValidateEngineClient, ValidateOptions } from './validate-engine.js';
export { rustraPlugin } from './vite.js';
export type { RustraVitePluginOptions } from './vite.js';
export { GENERATED_REACT_NATIVE_PACKAGE, renderReactNativeModule } from './react-native.js';
export type { ReactNativeScaffoldOptions } from './react-native.js';
export { parsePackageSchema } from './schema-validation.js';
export { selectCodegenBinary } from './cargo.js';
export { createWatchLoop } from './watch.js';
export type { GeneratedFile, GeneratedManifest } from './manifest.js';
export { buildGeneratedManifest, checkGeneratedFiles, manifestPathFor } from './manifest.js';
export {
  generateBunEntryTs,
  generateNodeEntryTs,
  generateReactNativeEntryTs,
  generateTauriEntryTs,
  renderInitProjectFiles,
  templateVersions,
} from './init-template.js';
export { resolveCodegenTarget, selectReactNativeCargoTarget } from './host-entries.js';
export { runCodegen } from './cli-codegen.js';
export { runGenerate, runWatch } from './cli-generate.js';
export { runInit } from './cli-init.js';
export { runDiff } from './cli-diff.js';
export { runDoctor } from './cli-doctor.js';

if (isCliEntry()) {
  main().catch((error) => {
    console.error('Error:', error instanceof Error ? error.message : error);
    // Usage errors (bad flags/values from the shared arg parser) exit 2 so CI
    // can distinguish "invoked the CLI wrong" from runtime failures (exit 1).
    const message = error instanceof Error ? error.message : String(error);
    const isUsageError =
      /Unknown .* option|requires a value|does not accept a value|must be text or json/.test(
        message,
      );
    process.exitCode = isUsageError ? 2 : 1;
  });
}

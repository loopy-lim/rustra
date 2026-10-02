import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { readConfigSync } from './config.js';
import { readCargoMetadata, selectHostPackage } from './cargo-metadata.js';
import { resolveCodegenTarget } from './host-entries.js';
import { cliManifest } from './cli-runtime.js';
import { toPosixPath } from './paths.js';
import { packageFactories, renderTauriRegistration } from './setup-tauri-render.js';
import { cargoDependency, dependencyManifest, rustraDependencyLine } from './setup-tauri-cargo.js';

export interface TauriIntegrationOptions {
  nativeManifestPath?: string;
  packageFunction?: string;
}

export interface TauriIntegrationResult {
  files: string[];
  instructions: string[];
  packageJsonChanged: boolean;
}

export async function setupTauriIntegration(
  configPath: string,
  options: TauriIntegrationOptions = {},
): Promise<TauriIntegrationResult> {
  const config = readConfigSync(configPath);
  const result: TauriIntegrationResult = { files: [], instructions: [], packageJsonChanged: false };
  if (!config.tauri) return result;
  const root = dirname(resolve(configPath));
  const nativeManifest = options.nativeManifestPath
    ? resolve(root, options.nativeManifestPath)
    : join(root, basename(root) === 'src-tauri' ? '' : 'src-tauri', 'Cargo.toml');
  if (!existsSync(nativeManifest))
    throw new Error(
      `Tauri setup could not find ${nativeManifest}. Keep rustra.json at the frontend root of an existing Tauri app, or provide nativeManifestPath.`,
    );
  const nativeRoot = dirname(nativeManifest);
  const native = parse(readFileSync(nativeManifest, 'utf8'));
  const selected = resolveCodegenTarget(configPath, config);
  const pkg = selectHostPackage(
    readCargoMetadata(selected.manifestPath, selected.cwd),
    selected.manifestPath,
    selected.packageName,
  );
  const libraries = pkg.targets.filter(
    (target) => !target.crate_types.includes('bin') && target.src_path,
  );
  if (libraries.length !== 1)
    throw new Error(
      `Tauri setup requires one Rust library in ${pkg.name}; expose your package factory from src/lib.rs.`,
    );
  const functions = packageFactories(await readFile(libraries[0]!.src_path!, 'utf8'));
  const factory = options.packageFunction ?? (functions.length === 1 ? functions[0] : undefined);
  if (!factory || !/^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$/.test(factory))
    throw new Error(
      `Tauri setup cannot select a public zero-argument Package factory in ${libraries[0]!.src_path}: ${functions.map((name) => `${name}()`).join(', ') || 'none'}. Export exactly one factory, or provide packageFunction explicitly.`,
    );
  const dependencies = (native.dependencies ?? {}) as Record<string, unknown>;
  let producer = 'crate';
  const cargoLines: string[] = [];
  if (realpathSync(nativeManifest) !== realpathSync(pkg.manifest_path)) {
    const dependency = Object.entries(dependencies).find(
      ([name]) =>
        dependencyManifest(cargoDependency(nativeManifest, name)) ===
        realpathSync(pkg.manifest_path),
    );
    producer = dependency
      ? (dependency[0] === pkg.name ? libraries[0]!.name : dependency[0]).replace(/-/g, '_')
      : 'rustra_setup_core';
    if (!dependency) {
      if (dependencies.rustra_setup_core !== undefined)
        throw new Error(
          'Tauri Cargo dependency rustra_setup_core already exists for another producer; rename that dependency or connect the selected core explicitly.',
        );
      cargoLines.push(
        `rustra_setup_core = { package = ${JSON.stringify(pkg.name)}, path = ${JSON.stringify(toPosixPath(relative(realpathSync(nativeRoot), dirname(pkg.manifest_path))))} }`,
      );
    }
  }
  const rustra = cargoDependency(nativeManifest, 'rustra');
  if (rustra === undefined)
    cargoLines.push(
      rustraDependencyLine(
        cargoDependency(pkg.manifest_path, 'rustra'),
        nativeRoot,
        cliManifest.rustraTemplate.cargoRange,
      ),
    );
  else if (
    typeof rustra.value !== 'object' ||
    rustra.value === null ||
    !('features' in rustra.value) ||
    !Array.isArray(rustra.value.features) ||
    !rustra.value.features.includes('tauri')
  )
    result.instructions.push(
      'Add "tauri" to the existing rustra dependency features in the native Cargo.toml.',
    );
  const adapterPath = join(nativeRoot, 'src', 'rustra_setup.rs');
  const adapter = renderTauriRegistration(`${producer}::${factory}`);
  if (existsSync(adapterPath) && (await readFile(adapterPath, 'utf8')) !== adapter)
    throw new Error(
      `Refusing to overwrite ${adapterPath}; review the existing adapter before removing or replacing it.`,
    );
  const tauriConfigPath = join(nativeRoot, 'tauri.conf.json');
  const tauriRaw = await readFile(tauriConfigPath, 'utf8');
  const tauriConfig = JSON.parse(tauriRaw) as Record<string, unknown>;
  if (
    !tauriConfig ||
    typeof tauriConfig !== 'object' ||
    Array.isArray(tauriConfig) ||
    (tauriConfig.app !== undefined &&
      (!tauriConfig.app || typeof tauriConfig.app !== 'object' || Array.isArray(tauriConfig.app)))
  )
    throw new Error(
      `Tauri setup requires an object app section in ${tauriConfigPath}; existing configuration was preserved.`,
    );
  const app = (tauriConfig.app ?? {}) as Record<string, unknown>;
  if (!existsSync(adapterPath)) {
    await mkdir(dirname(adapterPath), { recursive: true });
    await writeFile(adapterPath, adapter, { flag: 'wx' });
    result.files.push(adapterPath);
  }
  if (app.withGlobalTauri !== true) {
    tauriConfig.app = { ...app, withGlobalTauri: true };
    await writeFile(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);
    result.files.push(tauriConfigPath);
  }
  if (cargoLines.length)
    result.instructions.push(
      `Add under [dependencies] in ${nativeManifest}:\n${cargoLines.join('\n')}`,
    );
  result.instructions.push(
    'In the native lib.rs/main.rs, add `mod rustra_setup;` and wrap your existing builder with `let builder = rustra_setup::register(builder);` before .run/.build.',
  );
  result.instructions.push(
    'If the app has .invoke_handler(tauri::generate_handler![...]), replace that call with `let builder = rustra_setup::with_app_commands(builder, tauri::generate_handler![...]);` instead of register. Keep this as the final handler installation.',
  );
  result.instructions.push(
    `Import commands from ${toPosixPath(relative(root, resolve(root, config.output, 'tauri.js')))} and rebuild the Tauri host. Use matching Rustra development source until these helpers are released.`,
  );
  return result;
}

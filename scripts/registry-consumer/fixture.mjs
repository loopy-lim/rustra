import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RESULT_MARKER = '__RUSTRA_REGISTRY_RESULT__';

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function pinCargoVersions(projectDir, versions) {
  const path = join(projectDir, 'Cargo.toml');
  let cargo = readFileSync(path, 'utf8');
  for (const name of ['rustra', 'rustra-macros', 'rustra-naming']) {
    const next = `${name} = "=${versions[name]}"`;
    const pattern = new RegExp(`^${name.replaceAll('-', '\\-')}\\s*=\\s*"[^"]+"`, 'm');
    if (pattern.test(cargo)) cargo = cargo.replace(pattern, next);
    else {
      const dependencies = cargo.match(/^\[dependencies\]\s*$/m);
      if (!dependencies) throw new Error('Cargo.toml is missing [dependencies]');
      cargo = cargo.replace(/^\[dependencies\]\s*$/m, `[dependencies]\n${next}`);
    }
  }
  writeFileSync(path, cargo);
}

export function pinOriginalScaffold(projectDir, versions) {
  const packagePath = join(projectDir, 'package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  packageJson.dependencies = {
    '@rustra/node': `^${versions.npm['@rustra/node']}`,
    '@rustra/types': `^${versions.npm['@rustra/types']}`,
  };
  packageJson.devDependencies = { '@rustra/cli': versions.npm['@rustra/cli'] };
  writeJson(packagePath, packageJson);
  pinCargoVersions(projectDir, versions.phases.baseline);
}

export function prepareRegistryFixture(projectDir, versions) {
  const packagePath = join(projectDir, 'package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  packageJson.dependencies = {
    '@rustra/node': `^${versions.npm['@rustra/node']}`,
    '@rustra/bun': `^${versions.npm['@rustra/bun']}`,
    '@rustra/types': `^${versions.npm['@rustra/types']}`,
  };
  packageJson.devDependencies = { '@rustra/cli': versions.npm['@rustra/cli'] };
  writeJson(packagePath, packageJson);

  const cargoPath = join(projectDir, 'Cargo.toml');
  let cargo = readFileSync(cargoPath, 'utf8');
  if (!/^\[lib\]$/m.test(cargo))
    cargo = cargo.replace(
      '[dependencies]',
      '[lib]\nname = "rustra_app"\ncrate-type = ["rlib", "cdylib"]\n\n[dependencies]',
    );
  writeFileSync(cargoPath, cargo);
  pinCargoVersions(projectDir, versions.phases.baseline);

  const configPath = join(projectDir, 'rustra.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.node = config.node ?? {};
  config.bun = config.bun ?? {};
  writeJson(configPath, config);

  const libPath = join(projectDir, 'src', 'lib.rs');
  let lib = readFileSync(libPath, 'utf8');
  lib = lib.replace(
    '\npub fn package() -> Package {',
    `\n#[rustra::command]\nfn fail_echo(_input: EchoInput) -> Result<EchoOutput> {\n    Err(RustraError::invalid_args("registry gate error propagation"))\n}\n\npub fn package() -> Package {`,
  );
  const originalBuilder = /Package::builder\("app\.demo"\)\s*\.command_fn\(echo\)\.build\(\)/;
  const extendedBuilder =
    'Package::builder("app.demo").command_fn(echo).command_fn(fail_echo).build()';
  if (!originalBuilder.test(lib))
    throw new Error('extended fixture package builder anchor not found');
  lib = lib.replace(
    originalBuilder,
    `let package = ${extendedBuilder};\n    package.register_ffi();\n    package`,
  );
  if (!lib.includes('rustra::native_entry!(package);'))
    lib += '\nrustra::native_entry!(package);\n';
  writeFileSync(libPath, lib);
  writeProbeFiles(projectDir);
}

function writeProbeFiles(projectDir) {
  writeFileSync(
    join(projectDir, 'src', 'node-probe.ts'),
    `import { echo, failEcho, rustra } from './generated/node.js';\n\nconst repeat = process.env.RUSTRA_EXPECT_REPEAT ? Number(process.env.RUSTRA_EXPECT_REPEAT) : undefined;\nconst input = repeat === undefined ? { message: 'registry-node' } : { message: 'registry-node', repeat };\ntry {\n  await rustra.ready();\n  const result = await echo(input as never);\n  let propagatedError: { code: unknown; message: string } | null = null;\n  try { await failEcho(input as never); } catch (error: any) { propagatedError = { code: error?.code ?? null, message: error?.message ?? String(error) }; }\n  if (!propagatedError || !propagatedError.message.includes('registry gate error propagation')) throw new Error('Node error did not cross stdio');\n  if (result.message !== input.message || (repeat !== undefined && (result as any).repeat !== repeat)) throw new Error('Node result mismatch: ' + JSON.stringify(result));\n  console.log('${RESULT_MARKER}' + JSON.stringify({ host: 'node', adapter: '@rustra/node', transport: 'stdio', contractVerification: 'strict-generated-entry', result, propagatedError }));\n} finally { rustra.dispose(); }\n`,
  );
  writeFileSync(
    join(projectDir, 'src', 'bun-probe.ts'),
    `import { echo, failEcho, rustra } from './generated/bun.js';\n\nconst repeat = process.env.RUSTRA_EXPECT_REPEAT ? Number(process.env.RUSTRA_EXPECT_REPEAT) : undefined;\nconst input = repeat === undefined ? { message: 'registry-bun' } : { message: 'registry-bun', repeat };\ntry {\n  await rustra.ready();\n  const result = await echo(input as never);\n  let propagatedError: { code: unknown; message: string } | null = null;\n  try { await failEcho(input as never); } catch (error: any) { propagatedError = { code: error?.code ?? null, message: error?.message ?? String(error) }; }\n  if (!propagatedError || !propagatedError.message.includes('registry gate error propagation')) throw new Error('Bun error did not cross FFI');\n  if (result.message !== input.message || (repeat !== undefined && (result as any).repeat !== repeat)) throw new Error('Bun result mismatch: ' + JSON.stringify(result));\n  console.log('${RESULT_MARKER}' + JSON.stringify({ host: 'bun', adapter: '@rustra/bun', transport: 'ffi', contractVerification: 'strict-generated-entry', result, propagatedError }));\n} finally { rustra.dispose(); }\n`,
  );
}

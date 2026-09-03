import { constants, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  RUSTRA_MSRV,
  type DoctorCheck,
  type DoctorConfig,
  type DoctorOptions,
  type DoctorRunner,
} from './doctor-types.js';
import { isVersionAtLeast, parseRustVersion } from './doctor-types.js';
import {
  addAndroidChecks,
  canAccess,
  check,
  commandCheck,
  conditionalCheck,
  getCargoMetadata,
  nearestExistingParent,
  REGISTRY_CHECK_ID,
  resolveManifest,
  safeResolve,
  selectGenerator,
} from './doctor-support.js';
import { sha256 } from './hash.js';
import { cliVersion } from './cli-runtime.js';

export function collectBaseChecks(
  options: DoctorOptions,
  runner: DoctorRunner,
  /** collectDoctorReportAsync 가 미리 당겨 온 registry.reachability 프리브 결과. */
  registry?: DoctorCheck,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const rustc = runner('rustc', ['--version']);
  const version = parseRustVersion(`${rustc.stdout}\n${rustc.stderr}`);
  checks.push(
    conditionalCheck(
      'rustc.present',
      true,
      rustc.ok,
      'rustc is available',
      'rustc is unavailable',
      rustc.stderr || rustc.error,
      ['Install Rust with https://rustup.rs'],
    ),
  );
  checks.push(
    conditionalCheck(
      'rustc.msrv',
      true,
      Boolean(rustc.ok && version && isVersionAtLeast(version, RUSTRA_MSRV)),
      version ? `Rust ${version.join('.')} satisfies MSRV 1.88` : 'Rust satisfies MSRV 1.88',
      `Rust 1.88 or newer is required${version ? ` (found ${version.join('.')})` : ''}`,
      rustc.stderr || rustc.error,
      ['rustup toolchain install 1.88.0', 'rustup default 1.88.0'],
    ),
  );
  const cargo = runner('cargo', ['--version']);
  checks.push(
    conditionalCheck(
      'cargo.present',
      true,
      cargo.ok,
      'cargo is available',
      'cargo is unavailable',
      cargo.stderr || cargo.error,
      ['Install Cargo with https://rustup.rs'],
    ),
  );
  // registry 도달성 — cargo 부재는 경고할 것도 없다(설치 자체가 선행 과제). 프리브가
  // 없는 동기 경로(collectDoctorReport 직접 호출)는 skip 으로 명시해 기계 판독이
  // "검사 누락"과 "의도된 스킵"을 구별하게 한다.
  if (!registry)
    checks.push(
      check(
        REGISTRY_CHECK_ID,
        'skip',
        false,
        'Skipped registry reachability because the probe was not run',
      ),
    );
  else if (!cargo.ok)
    checks.push(
      check(
        REGISTRY_CHECK_ID,
        'skip',
        false,
        'Skipped registry reachability because cargo is unavailable',
      ),
    );
  else checks.push(registry);
  const node = runner('node', ['--version']);
  const bun = runner('bun', ['--version']);
  checks.push(
    conditionalCheck(
      'js.runtime',
      true,
      node.ok || bun.ok,
      node.ok ? 'Node.js is available' : 'Bun is available',
      'Node.js or Bun is unavailable',
      node.stderr || bun.stderr || node.error || bun.error,
      ['Install Node.js 18+ or Bun 1.4+'],
    ),
  );
  const platform = options.platform ?? process.platform;
  const compiler = platform === 'win32' ? 'cl' : 'c++';
  checks.push(
    commandCheck(
      runner,
      compiler,
      platform === 'win32' ? ['/Bv'] : ['--version'],
      'toolchain.cpp',
      'C/C++ compiler',
      [
        platform === 'win32'
          ? 'Open a Visual Studio Developer Command Prompt or install the MSVC C++ workload'
          : 'Install the platform C++ compiler (Xcode Command Line Tools or build-essential)',
      ],
    ),
  );
  checks.push(
    commandCheck(runner, 'cmake', ['--version'], 'toolchain.cmake', 'CMake', [
      'Install CMake and ensure it is on PATH',
    ]),
  );
  return checks;
}

export function collectConfigChecks(
  options: DoctorOptions,
  runner: DoctorRunner,
  configPath: string,
  config: DoctorConfig,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const root = dirname(configPath);
  const cargo = runner('cargo', ['--version']);
  const manifest = resolveManifest(root, config);
  checks.push(
    conditionalCheck(
      'codegen.rust_manifest',
      true,
      Boolean(manifest),
      `Cargo manifest: ${manifest ?? ''}`,
      'Could not find Cargo.toml for codegen',
      undefined,
      ['Set codegen.rustManifest in rustra.json'],
    ),
  );
  if (manifest && existsSync(manifest) && cargo.ok) {
    const metadata = getCargoMetadata(runner, manifest);
    if (metadata.metadata) {
      const selected = selectGenerator(
        metadata.metadata,
        manifest,
        config.codegen?.rustPackage,
        config.codegen?.rustBinary,
      );
      checks.push(
        conditionalCheck(
          'codegen.rust_binary',
          true,
          Boolean(selected.binaryName),
          `Rust generator: ${selected.packageName ?? 'package'} / ${selected.binaryName ?? ''}`,
          'Could not select a Cargo generator binary',
          selected.error,
          ['Set codegen.rustPackage and codegen.rustBinary in rustra.json'],
        ),
      );
    } else
      checks.push(
        check(
          'codegen.rust_binary',
          'fail',
          true,
          'Cargo metadata could not inspect the generator',
          metadata.error,
          ['Run cargo metadata manually and fix the Cargo manifest'],
        ),
      );
  } else
    checks.push(
      check(
        'codegen.rust_binary',
        'skip',
        true,
        'Skipped Cargo binary selection because the manifest or cargo is unavailable',
      ),
    );

  const schemaPath = safeResolve(root, config.schema);
  const outputPath = safeResolve(root, config.output);
  checks.push(
    schemaPath && existsSync(schemaPath)
      ? conditionalCheck(
          'codegen.schema_output',
          true,
          statSync(schemaPath).isFile() && canAccess(schemaPath, constants.R_OK),
          `Schema exists and is readable: ${schemaPath}`,
          `Schema exists but is not readable: ${schemaPath}`,
          undefined,
          ['Check file permissions for schema.json'],
        )
      : check(
          'codegen.schema_output',
          'warn',
          false,
          `Schema is not generated yet: ${schemaPath ?? 'invalid schema path'}`,
          undefined,
          ['Run rustra codegen --config rustra.json'],
        ),
  );
  if (outputPath && existsSync(outputPath))
    checks.push(
      conditionalCheck(
        'codegen.output_directory',
        true,
        statSync(outputPath).isDirectory() && canAccess(outputPath, constants.W_OK),
        `Generated output directory is writable: ${outputPath}`,
        `Generated output directory is not writable: ${outputPath}`,
        undefined,
        ['Check directory permissions for generated output'],
      ),
    );
  else if (outputPath) {
    const parent = nearestExistingParent(dirname(outputPath));
    const writable = parent !== undefined && canAccess(parent, constants.W_OK);
    checks.push(
      check(
        'codegen.output_directory',
        'warn',
        false,
        writable
          ? `Generated output directory will be created: ${outputPath}`
          : `Generated output directory may not be creatable: ${outputPath}`,
        writable
          ? undefined
          : `Nearest existing parent is not writable: ${parent ?? dirname(outputPath)}`,
        ['Create the output directory or grant write permission'],
      ),
    );
  }
  const platform = options.platform ?? process.platform;
  if (config.reactNative) {
    checks.push(
      platform === 'darwin'
        ? check('rn.ios.platform', 'pass', true, 'macOS is available for React Native iOS builds')
        : check('rn.ios.platform', 'skip', false, 'React Native iOS build requires macOS'),
    );
    if (platform === 'darwin') {
      checks.push(
        commandCheck(runner, 'xcodebuild', ['-version'], 'rn.ios.xcodebuild', 'Xcode', [
          'Install Xcode and run xcode-select --install',
        ]),
      );
      checks.push(
        commandCheck(runner, 'pod', ['--version'], 'rn.ios.cocoapods', 'CocoaPods', [
          'Install CocoaPods with gem install cocoapods',
        ]),
      );
    }
    addAndroidChecks(checks, runner, options.env ?? process.env);
  }
  if (config.tauri) {
    const command =
      platform === 'darwin' ? 'xcodebuild' : platform === 'win32' ? 'cl' : 'pkg-config';
    const args =
      command === 'xcodebuild' ? ['-version'] : command === 'pkg-config' ? ['--version'] : [];
    checks.push(
      commandCheck(runner, command, args, 'tauri.platform_tools', `Tauri ${platform} build tools`, [
        'Install the native build tools required by the current platform',
      ]),
    );
  }
  // Task A3 — wasm dev 타깃 고지. 협동형(단일스레드) 취소만 재현하므로 동시성
  // 버그(race/취소/백프레셔)는 wasm dev 에서 절대 재현되지 않는다 — 경고는
  // required 가 아니지만(warn), wasm32 빌드 타깃 부재는 필수 fail 이다(wasm32
  // 없이는 엔진 빌드 자체가 성공하지 않는다). 네이티브 타깃은 어느 쪽도 수집하지
  // 않는다(절대 음성).
  // 코드젠 산출물 신선도 — .rustra-generated.json 매니페스트 기반 저비용 검사.
  // 바이트 전수 검증은 codegen --check 의 소관이다 (doctor 는 읽기 전용 저비용 유지).
  // 스키마 자체가 없으면 codegen.schema_output 이 이미 warn 이므로 이중 보고하지 않는다.
  const manifestPath = outputPath ? resolve(outputPath, '.rustra-generated.json') : undefined;
  if (manifestPath && existsSync(manifestPath) && schemaPath && existsSync(schemaPath)) {
    let stale: string | undefined;
    let detail: string | undefined;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        schemaVersion?: unknown;
        schemaHash?: unknown;
        generatorVersion?: unknown;
      };
      if (
        manifest.schemaVersion !== 1 ||
        typeof manifest.schemaHash !== 'string' ||
        typeof manifest.generatorVersion !== 'string'
      )
        stale = 'Generated manifest is invalid — generated output may be stale';
      else {
        const currentSchemaHash = sha256(readFileSync(schemaPath, 'utf8'));
        if (manifest.schemaHash !== currentSchemaHash)
          stale = 'schema.json changed after the last codegen — generated output is stale';
        else if (manifest.generatorVersion !== cliVersion)
          stale = `Generator version drift: manifest ${manifest.generatorVersion}, CLI ${cliVersion}`;
      }
    } catch (error) {
      stale = 'Generated manifest could not be read — generated output may be stale';
      detail = error instanceof Error ? error.message : String(error);
    }
    checks.push(
      stale
        ? check('codegen.generated_freshness', 'warn', false, stale, detail, [
            'Run rustra codegen --config rustra.json',
          ])
        : check(
            'codegen.generated_freshness',
            'pass',
            false,
            'Generated output is fresh (schema and generator match the manifest)',
          ),
    );
  } else if (schemaPath && existsSync(schemaPath))
    checks.push(
      check(
        'codegen.generated_freshness',
        'warn',
        false,
        'Generated manifest is missing — generated output may be stale or absent',
        undefined,
        ['Run rustra codegen --config rustra.json'],
      ),
    );
  else
    checks.push(
      check(
        'codegen.generated_freshness',
        'skip',
        false,
        'Skipped freshness because schema.json is not generated yet',
      ),
    );
  if (config.dev?.target === 'wasm') {
    checks.push(
      check(
        'dev.wasm.experimental',
        'warn',
        false,
        'wasm dev target: cooperative cancellation only — verify natively before release',
        // 한국어 고지는 detail 로 — summary 는 기계 판독(JSON) 대비 영문 고정.
        // detail 은 text 출력에서도 `detail:` 라인으로 렌더된다(시각 동일).
        '협동형 취소만 유효 — 릴리스 전 native 검증 필수',
        [
          'Run the native build/test loop before releasing — wasm32 cannot reproduce ' +
            'race/cancellation/backpressure behavior',
        ],
      ),
    );
    const targets = runner('rustup', ['target', 'list', '--installed']);
    const installed = new Set(targets.stdout.split(/\r?\n/).map((target) => target.trim()));
    checks.push(
      conditionalCheck(
        'dev.wasm.rust_target',
        true,
        targets.ok && installed.has('wasm32-unknown-unknown'),
        'wasm32-unknown-unknown Rust target is installed',
        'Rust target wasm32-unknown-unknown is missing',
        targets.stderr || targets.error,
        ['rustup target add wasm32-unknown-unknown'],
      ),
    );
  }
  return checks;
}

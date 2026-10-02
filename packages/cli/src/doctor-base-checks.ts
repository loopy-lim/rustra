import {
  RUSTRA_MSRV,
  isVersionAtLeast,
  parseRustVersion,
  type DoctorCheck,
  type DoctorConfig,
  type DoctorOptions,
  type DoctorRunner,
} from './doctor-types.js';
import { check, commandCheck, conditionalCheck, REGISTRY_CHECK_ID } from './doctor-support.js';
import { collectJavaScriptRuntimeChecks } from './doctor-runtime-checks.js';

export function nativeToolRequirements(config?: DoctorConfig): { cpp: boolean; cmake: boolean } {
  return {
    cpp: Boolean(config?.reactNative || config?.cppOutput),
    cmake: Boolean(config?.reactNative),
  };
}

export function collectBaseChecks(
  options: DoctorOptions,
  runner: DoctorRunner,
  /** collectDoctorReportAsync 가 미리 당겨 온 registry.reachability 프리브 결과. */
  registry?: DoctorCheck,
  config?: DoctorConfig,
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
  checks.push(...collectJavaScriptRuntimeChecks(runner, config));
  const platform = options.platform ?? process.platform;
  const required = nativeToolRequirements(config);
  const compiler = platform === 'win32' ? 'cl' : 'c++';
  checks.push(
    required.cpp
      ? commandCheck(
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
        )
      : check(
          'toolchain.cpp',
          'skip',
          false,
          'C/C++ compiler is not required by the configured hosts',
        ),
  );
  checks.push(
    required.cmake
      ? commandCheck(runner, 'cmake', ['--version'], 'toolchain.cmake', 'CMake', [
          'Install CMake and ensure it is on PATH',
        ])
      : check('toolchain.cmake', 'skip', false, 'CMake is not required by the configured hosts'),
  );
  return checks;
}

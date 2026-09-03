import { accessSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { cargoPackagesForManifest, findCargoManifest, selectCodegenBinary } from './cargo.js';
import { readConfigSync } from './config.js';
import {
  ANDROID_NDK_VERSION,
  DEFAULT_ANDROID_TARGETS,
  type CargoMetadata,
  type DoctorCheck,
  type DoctorCommandResult,
  type DoctorConfig,
  type DoctorFetcher,
  type DoctorRunner,
  type DoctorStatus,
} from './doctor-types.js';

export function memoizeRunner(runner: DoctorRunner): DoctorRunner {
  const cache = new Map<string, DoctorCommandResult>();
  return (command, args) => {
    const key = JSON.stringify([command, args]);
    const cached = cache.get(key);
    if (cached) return cached;
    const result = runner(command, args);
    cache.set(key, result);
    return result;
  };
}
export function check(
  id: string,
  status: DoctorStatus,
  required: boolean,
  summary: string,
  detail?: string,
  fix?: string[],
): DoctorCheck {
  return { id, status, required, summary, ...(detail ? { detail } : {}), ...(fix ? { fix } : {}) };
}
export function conditionalCheck(
  id: string,
  required: boolean,
  condition: boolean,
  passSummary: string,
  failSummary: string,
  detail?: string,
  fix?: string[],
): DoctorCheck {
  return condition
    ? check(id, 'pass', required, passSummary)
    : check(id, 'fail', required, failSummary, detail, fix);
}
export function commandCheck(
  runner: DoctorRunner,
  command: string,
  args: string[],
  id: string,
  summary: string,
  fix: string[],
): DoctorCheck {
  const result = runner(command, args);
  return conditionalCheck(
    id,
    true,
    result.ok,
    summary,
    `${summary} is unavailable`,
    result.stderr || result.error,
    fix,
  );
}
export function readConfig(configPath: string): { config?: DoctorConfig; error?: string } {
  try {
    return { config: readConfigSync(configPath) as DoctorConfig };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
export function canAccess(path: string, mode: number): boolean {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}
export function nearestExistingParent(path: string): string | undefined {
  let current = resolve(path);
  while (true) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
export function safeResolve(root: string, value: string | undefined): string | undefined {
  if (!value || value.includes('\0') || /[\r\n]/.test(value)) return undefined;
  return resolve(root, value);
}
export function resolveManifest(configRoot: string, config: DoctorConfig): string | undefined {
  return safeResolve(configRoot, config.codegen?.rustManifest) ?? findCargoManifest(configRoot);
}
export function getCargoMetadata(
  runner: DoctorRunner,
  manifestPath: string,
): { metadata?: CargoMetadata; error?: string } {
  const result = runner('cargo', [
    'metadata',
    '--format-version',
    '1',
    '--no-deps',
    '--manifest-path',
    manifestPath,
  ]);
  if (!result.ok) return { error: result.stderr || result.error || 'cargo metadata failed' };
  try {
    return { metadata: JSON.parse(result.stdout) as CargoMetadata };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
export function selectGenerator(
  metadata: CargoMetadata,
  manifestPath: string,
  requestedPackage: string | undefined,
  requestedBinary: string | undefined,
): { packageName?: string; binaryName?: string; error?: string } {
  const packages = cargoPackagesForManifest(
    metadata.packages ?? [],
    manifestPath,
    requestedPackage,
  );
  if (packages.length !== 1)
    return {
      error:
        packages.length === 0
          ? 'no Cargo package matches the configured manifest/package'
          : `multiple Cargo packages match: ${packages.map((candidate) => candidate.name).join(', ')}`,
    };
  const candidate = packages[0]!;
  const binaries = (candidate.targets ?? []).filter(
    (target) => target.kind?.includes('bin') || target.crate_types?.includes('bin'),
  );
  const validBinaries = binaries.filter(
    (target): target is { name: string; kind?: string[]; crate_types?: string[] } =>
      typeof target.name === 'string',
  );
  try {
    return {
      packageName: candidate.name,
      binaryName: selectCodegenBinary(validBinaries, requestedBinary),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
export function javaMajor(value: string): number | null {
  const match = /version\s+["'](\d+)(?:\.(\d+))?/.exec(value);
  if (!match) return null;
  const major = Number(match[1]);
  return major === 1 && match[2] ? Number(match[2]) : major;
}

// ── registry 도달성 (registry.reachability) ──────────────────────────────────
//
// runner 는 명령 실행만 가능하고 HTTP 를 못 하므로 이 프리브는 fetch 시임이다.
// 프록시 뒤 사용자는 첫 cargo build 에서 22초 무응답 + 원문 영문 cargo 에러를
// 만난다 — cargo 가 망가진 뒤가 아니라 doctor 가 미리 진단한다. 네트워크 부재는
// 환경 문제이지 설치 결함이 아니므로 warn 이 상한이다(fail-closed 금지 — 무네트워크
// CI 에서 doctor 가 빨개지면 온보딩 게이트가 깨진다).

/** crates.io sparse index config — 인증 없이 가장 작고 캐시 친화적인 도달성 표적. */
export const REGISTRY_PROBE_URL = 'https://index.crates.io/config.json';
/** doctor 는 CI 에서도 돈다 — 프리브가 느려도 3초면 충분하다. */
export const REGISTRY_PROBE_TIMEOUT_MS = 3_000;
/** 검사 id — JSON 소비자가 문자열로 조인하므로 단일 출처로 관리한다. */
export const REGISTRY_CHECK_ID = 'registry.reachability';

const REGISTRY_UNREACHABLE_SUMMARY =
  'crates.io registry is unreachable — cargo build may fail or hang';
const REGISTRY_REACHABILITY_FIX = [
  'If a proxy is required, configure HTTPS_PROXY/HTTP_PROXY in the environment',
  'For vendored or offline builds, set CARGO_NET_OFFLINE=true',
];

/**
 * Node undici 가 네트워크 실패를 "fetch failed" TypeError 로 감싸고 실제 원인
 * (ENOTFOUND/ECONNREFUSED/프록시 거절)은 cause 에 숨긴다 — 이 검사가 사는 페르소나가
 * 정확히 그 원인을 봐야 하므로 한 겹만 벗긴다. Bun 은 cause 가 없어 폴백이 그대로 쓰인다.
 */
function registryProbeFailureDetail(error: unknown): string {
  if (error instanceof Error && error.message === 'fetch failed') {
    const cause = error.cause;
    if (cause instanceof Error && cause.message) return cause.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function probeRegistryReachability(
  fetchImpl: DoctorFetcher = globalThis.fetch,
): Promise<DoctorCheck> {
  try {
    const response = await fetchImpl(REGISTRY_PROBE_URL, {
      signal: AbortSignal.timeout(REGISTRY_PROBE_TIMEOUT_MS),
    });
    if (!response.ok)
      return check(
        REGISTRY_CHECK_ID,
        'warn',
        false,
        REGISTRY_UNREACHABLE_SUMMARY,
        `${REGISTRY_PROBE_URL} responded with HTTP ${response.status}`,
        REGISTRY_REACHABILITY_FIX,
      );
    return check(REGISTRY_CHECK_ID, 'pass', false, 'crates.io registry is reachable');
  } catch (error) {
    return check(
      REGISTRY_CHECK_ID,
      'warn',
      false,
      REGISTRY_UNREACHABLE_SUMMARY,
      `${REGISTRY_PROBE_URL}: ${registryProbeFailureDetail(error)}`,
      REGISTRY_REACHABILITY_FIX,
    );
  }
}
function ndkPath(env: NodeJS.ProcessEnv): string | undefined {
  const direct = env.ANDROID_NDK_HOME;
  if (direct && existsSync(join(direct, 'source.properties'))) return direct;
  for (const sdk of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
    if (!sdk) continue;
    const candidate = join(sdk, 'ndk', ANDROID_NDK_VERSION);
    if (existsSync(join(candidate, 'source.properties'))) return candidate;
  }
  return undefined;
}
export function addAndroidChecks(
  checks: DoctorCheck[],
  runner: DoctorRunner,
  env: NodeJS.ProcessEnv,
): void {
  const java = runner('java', ['-version']);
  const javaVersion = javaMajor(`${java.stdout}\n${java.stderr}`);
  checks.push(
    conditionalCheck(
      'rn.android.java',
      true,
      java.ok && javaVersion === 17,
      'Java 17 is available',
      `Java 17 is required${javaVersion ? ` (found ${javaVersion})` : ''}`,
      java.stderr || java.error,
      ['Install Java 17 and set JAVA_HOME'],
    ),
  );
  checks.push(
    commandCheck(runner, 'adb', ['version'], 'rn.android.sdk', 'Android SDK adb', [
      'Install Android SDK platform tools and ensure adb is on PATH',
    ]),
  );
  const sdkmanager = runner('sdkmanager', ['--version']);
  checks.push(
    conditionalCheck(
      'rn.android.sdkmanager',
      true,
      sdkmanager.ok,
      'Android sdkmanager is available',
      'Android sdkmanager is unavailable',
      sdkmanager.stderr || sdkmanager.error,
      ['Install Android command-line tools and ensure sdkmanager is on PATH'],
    ),
  );
  const ndk = ndkPath(env);
  checks.push(
    conditionalCheck(
      'rn.android.ndk',
      true,
      Boolean(ndk),
      `Android NDK ${ANDROID_NDK_VERSION} is available`,
      `Android NDK ${ANDROID_NDK_VERSION} is missing`,
      'Set ANDROID_NDK_HOME or ANDROID_HOME/ANDROID_SDK_ROOT to an SDK containing the pinned NDK',
      [`sdkmanager "ndk;${ANDROID_NDK_VERSION}"`],
    ),
  );
  const targets = runner('rustup', ['target', 'list', '--installed']);
  const installed = new Set(targets.stdout.split(/\r?\n/).map((target) => target.trim()));
  const missing = DEFAULT_ANDROID_TARGETS.filter((target) => !installed.has(target));
  checks.push(
    conditionalCheck(
      'rn.android.rust_targets',
      true,
      targets.ok && missing.length === 0,
      'Android Rust targets are installed',
      `Missing Android Rust targets: ${missing.join(', ')}`,
      targets.stderr || targets.error,
      [`rustup target add ${missing.join(' ')}`],
    ),
  );
}

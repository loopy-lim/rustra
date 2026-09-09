/**
 * dylib dev 타깃 빌드 헬퍼 — 핫스왑용 네이티브 cdylib 를 빌드하고 산출물 경로를
 * 돌려준다. wasm 헬퍼(dev.ts buildWasmEngine)와 같은 오케스트레이션 위치의
 * 대응물이지만, 산출물 경로의 근원이 다르다: wasm 은 cargo 규약으로 경로를
 * **계산**하지만, dylib 는 `--message-format=json` 의 compiler-artifact 메시지가
 * 알려주는 경로를 **수신**한다 — 플랫폼별 확장자(.dylib/.so/.dll)와 프로필
 * 디렉터리를 재발명하지 않기 위해서다. stdout 이 기계 판독 대상이므로 cargo 의
 * 사람용 출력은 전부 stderr 로 흘려야 한다(spawnInherit childOutput 계약과 같은
 * 제약 — 진행 표기도 stderr).
 *
 * 빌드만으로 스왑이 일어나지 않는다 — 빌드는 cargo 타깃 경로(스크래치)에만 닿고,
 * 감시자(hot_core_watch 의 sha256 폴링)가 폴링하는 라이브 경로는 게이트 통과
 * 빌드만 원자적으로 발행한다(liveArtifactPath + publishGatedArtifact).
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readCargoMetadata, selectHostPackage } from './cargo-metadata.js';
import type { ResolvedDevDylib } from './dev-config.js';

/** cargo compiler-artifact 메시지 중 파싱에 필요한 필드만. */
interface CargoArtifactMessage {
  reason?: string;
  filenames?: string[];
  target?: { kind?: string[] };
}

/** 호스트 플랫폼 → cdylib 산출물 확장자. 미지 플랫폼은 호스트 선호 없이 수신 순. */
const HOST_DYLIB_EXTENSION: Record<NodeJS.Platform, string | undefined> = {
  darwin: '.dylib',
  linux: '.so',
  win32: '.dll',
  aix: undefined,
  android: undefined,
  freebsd: undefined,
  haiku: undefined,
  openbsd: undefined,
  sunos: undefined,
  cygwin: undefined,
  netbsd: undefined,
};

const DYLIB_EXTENSIONS = ['.dylib', '.so', '.dll'] as const;

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/**
 * stdout 을 문자열로 수집하는 cargo 스폰 — machine-readable stdout 이 필요한
 * 호출자 전용이다. process.ts 의 spawnInherit 은 stdout 을 수집하지 않아서
 * (void 계약) 여기에 둔다. 진행 스피너·cargo stderr 는 전부 stderr 로 — 첫
 * 빌드가 수 분 걸릴 수 있어 "멈춤"으로 보이면 안 되는 것은 spawnInherit 과
 * 같은 이유다.
 */
function spawnCapturingStdout(args: string[], cwd: string, progressLabel: string): Promise<string> {
  return new Promise((resolveSpawn, rejectSpawn) => {
    const child = spawn('cargo', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => void chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    const started = Date.now();
    let tick = 0;
    const render = (suffix: string): void => {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      const frame = SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
      console.error(`[rustra] ${frame} ${progressLabel} ${suffix} (${elapsed}s)`);
      tick += 1;
    };
    const timer = setInterval(() => render('still running'), 1000);
    timer.unref?.();
    console.error(`[rustra] ⠋ ${progressLabel}...`);
    const finish = (): void => {
      if (timer) clearInterval(timer);
    };
    child.on('error', (error) => {
      finish();
      rejectSpawn(error);
    });
    // close — exit 이 아니라. exit 는 stdout 드레인을 기다리지 않는다(빠른 빌드일
    //수록 data 이벤트가 exit 뒤에 온다). compiler-artifact 수신이 이 헬퍼의 전부이므로
    // 스트림이 닫힌 뒤 판정해야 한다.
    child.on('close', (code, signal) => {
      finish();
      const total = ((Date.now() - started) / 1000).toFixed(1);
      console.error(`[rustra] ✓ ${progressLabel} done in ${total}s`);
      if (code === 0) {
        resolveSpawn(Buffer.concat(chunks).toString('utf8'));
      } else {
        rejectSpawn(new Error(`cargo ${signal ? `terminated by ${signal}` : `exit ${code}`}`));
      }
    });
  });
}

/**
 * compiler-artifact 메시지들에서 cdylib 산출물을 고른다. 판정 규칙:
 * reason === "compiler-artifact" 이고 target.kind 에 cdylib 가 있어야 하며,
 * 파일명은 dylib 확장자 셋으로 좁힌다. 호스트 플랫폼 확장자를 선호하고(hot-core
 * dlopen 대상이므로), 그러도 여러 개면 **가장 최신 메시지의 마지막 후보**가
 * 이긴다 — cargo 는 빌드 단위마다 메시지를 내므로 뒤 메시지가 최신 산출이다.
 * cdylib 가 아닌 산출물(rmeta, bin 등)은 애초에 후보가 아니다.
 */
export function pickCdylibArtifact(stdout: string): string | undefined {
  const hostExtension = HOST_DYLIB_EXTENSION[process.platform];
  let picked: string | undefined;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let message: CargoArtifactMessage;
    try {
      message = JSON.parse(trimmed) as CargoArtifactMessage;
    } catch {
      continue;
    }
    if (message.reason !== 'compiler-artifact') continue;
    if (!message.target?.kind?.includes('cdylib')) continue;
    const candidates = (message.filenames ?? []).filter((file) =>
      DYLIB_EXTENSIONS.some((extension) => file.endsWith(extension)),
    );
    if (candidates.length === 0) continue;
    const hostMatches = hostExtension
      ? candidates.filter((file) => file.endsWith(hostExtension))
      : [];
    const chosen = hostMatches.length > 0 ? hostMatches : candidates;
    picked = chosen[chosen.length - 1];
  }
  return picked;
}

/**
 * dylib dev 타깃의 rust 재빌드 단계 — 핫스왑 단위(cdylib)를 빌드하고 산출물
 * 경로를 돌려준다. cargo 가 알려주는 경로를 신뢰하되 디스크 재확인은 fail-closed
 * 로 남긴다(fresh 메시지가 이미 지워진 파일을 가리키는 불일치를 조용히 통과시키지
 * 않는다 — wasm 헬퍼의 did-not-produce 계약과 같은 자리다).
 */
export async function buildDylibCore(resolved: ResolvedDevDylib): Promise<string> {
  const manifestPath = resolved.manifestPath;
  const metadata = readCargoMetadata(manifestPath);
  const cargoPackage = selectHostPackage(metadata, manifestPath, resolved.rustPackage);
  // -p 는 요청 시에만 — rustPackage 미지정 단일 패키지 매니페스트에서는 cargo
  // 기본 멤버 선택이 정확히 그 패키지다(복수 패키지는 selectHostPackage 가 이미
  // 거절한다). 불필요한 플래그는 cargo 출력 규약만 넓힌다.
  const args = [
    'build',
    '--manifest-path',
    manifestPath,
    ...(resolved.rustPackage ? ['--package', resolved.rustPackage] : []),
    '--lib',
    '--message-format=json',
  ];
  let stdout: string;
  try {
    stdout = await spawnCapturingStdout(
      args,
      dirname(manifestPath),
      `dylib core build (${cargoPackage.name})`,
    );
  } catch (error) {
    throw new Error(
      `Rust dylib build failed for ${cargoPackage.name} (${manifestPath}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const artifact = pickCdylibArtifact(stdout);
  if (artifact === undefined) {
    throw new Error(
      `dylib core build produced no cdylib artifact for package ${cargoPackage.name}. ` +
        `The rust package must declare crate-type "cdylib" — add ` +
        `crate-type = ["rlib", "cdylib"] to ${manifestPath}`,
    );
  }
  if (!existsSync(artifact)) {
    throw new Error(
      `dylib build did not produce ${artifact} — cargo reported the cdylib artifact ` +
        `but it is absent on disk`,
    );
  }
  return artifact;
}

/** 게이트 통과 발행의 프로세스 내 시퀀스 — tmp 파일명 고유성 보강용(pid 와 함께). */
let publishSequence = 0;

/**
 * 게이트 통과 산출물이 닿는 라이브 경로 — 산출물과 같은 디렉터리에서 파일 stem 뒤에
 * `-hot-live` 를 붙이고 확장자는 산출물과 동일하게 유지한다(pickCdylibArtifact 가
 * 이미 호스트 확장자를 선호해 골랐으므로 산출물 확장자가 곧 호스트 확장자다).
 * 이름 계약: 이 경로는 **패리티 게이트를 통과한 빌드의 원자적 발행**으로만 쓰인다.
 * cargo 타깃 경로는 빌드 스크래치일 뿐이고, 감시자가 폴링하는 대상은 언제나
 * 이쪽이다 — 게이트 판정 전에 어떤 빌드도 이 경로에 닿을 수 없다(fail-closed).
 */
export function liveArtifactPath(artifactPath: string): string {
  const extension = DYLIB_EXTENSIONS.find((candidate) => artifactPath.endsWith(candidate));
  if (extension === undefined) {
    throw new Error(
      `cannot derive the gated live artifact path — ${artifactPath} does not end with ` +
        `a dylib extension (${DYLIB_EXTENSIONS.join(', ')}); the cdylib artifact reported ` +
        `by cargo must be one of them`,
    );
  }
  const stem = basename(artifactPath).slice(0, -extension.length);
  return join(dirname(artifactPath), `${stem}-hot-live${extension}`);
}

/**
 * 게이트 통과 빌드를 라이브 경로로 원자적 발행한다 — 같은 디렉터리의 숨은 tmp 파일에
 * 복사한 뒤 rename 으로 갈아끼운다. 같은 파일시스템 안의 rename 은 원자적이므로
 * 폴링 감시자(hot_core_watch)가 반쯤 쓰인 파일을 읽을 일이 없다. 라이브 경로에 이전
 * 발행물이 있으면 그 자리에서 덮어쓴다(교체도 원자적). 실패 시 tmp 잔여물을 조용히
 * 두지 않는다 — 치운 뒤 원인과 결과(라이브 미갱신, 기존 코어 유지)를 함께 던진다.
 */
export function publishGatedArtifact(artifactPath: string, livePath: string): string {
  const tmpPath = join(
    dirname(livePath),
    `.${basename(livePath)}-tmp-${process.pid}-${publishSequence++}`,
  );
  try {
    copyFileSync(artifactPath, tmpPath);
    renameSync(tmpPath, livePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let cleanup = 'the temp file was cleaned up';
    try {
      rmSync(tmpPath, { force: true });
    } catch (cleanupError) {
      cleanup =
        `cleaning up the temp file ${tmpPath} also failed: ` +
        `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
    }
    throw new Error(
      `failed to publish the gated live artifact ${livePath} — the live path was not ` +
        `updated and the host keeps the previously published core: ${message} (${cleanup})`,
      { cause: error },
    );
  }
  return livePath;
}

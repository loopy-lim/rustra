// Android 핫 코어 스왑 유닛 전달 스크립트.
//
// 호스트에서 빌드한 cdylib(<stem>.so)를 앱의 핫 디렉터(<filesDir>/rustra/hot)로
// 전달한다. 코어 감시 계약은 "디렉터 안의 *-hot-live.so"다 — 이 스크립트는
// 항상 tmp 파일로 기록한 뒤 run-as mv(동일 디렉터 rename(2))로 원자 교체한다.
//
// 제자리 덮어쓰기 금지(실측, docs/plans/2026-09-09-native-hot-core-design.md):
// 프로세스가 dlopen 중인 파일을 같은 경로로 덮어쓰면 Android 에서 SIGSEGV 가
// 난다(수정된 파일 페이지 재로딩). tmp+rename 은 기존 inode 를 보존하므로 안전하다.
//
// 전달 경로 선택 근거:
// - /data/local/tmp 경유는 SELinux 거부 — 앱 도메인(untrusted_app)은
//   shell_data_file 라벨을 읽지 못해 run-as cp 가 avc denied 로 실패한다.
// - `adb shell run-as <pkg> sh -c 'cat > path'` 따옴표 기법은 adbd 가 인용을
//   분해하는 버전/기기가 있어 원격 셸 해석이 분가(redirect 가 엉뚱한 셸에서
//   실행)된다 — 실측으로 확인한 취약 포인트다.
// - 그래서 셸 메타문자가 하나도 없는 `run-as <pkg> dd of=<절대경로>` 에 stdin
//   을 파이프한다(dd 는 EOF 까지 stdin 을 기록). 절대 경로를 쓰므로 run-as
//   cwd 모호성도 제거된다. 바이트 수는 `wc -c <파일>` 로 재검증한다.
//
// 사용법:
//   bun scripts/hot-core-push-android.mjs <cdylib.so 경로> [옵션]
// 옵션:
//   --serial <serial>  adb 직렬 (env ADB_SERIAL, 기본 emulator-5554)
//   --package <pkg>    앱 package (자동 감지: app.json → android/app/build.gradle,
//                      실패 시 env RUSTRA_ANDROID_PACKAGE, 최후 기본값)
//   --name <name>      기기 측 live 파일명 (기본 <입력 stem>-hot-live.so)
//   --adb <path>       adb 바이너리 (env ADB, 기본 adb)

import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = resolve(SCRIPT_DIR, '..');
export const DEFAULT_SERIAL = 'emulator-5554';
export const TMP_LIVE_NAME = 'live-tmp.so';
// 최후 폴백 — 감지가 모두 실패해도 smoke 흐름이 막히지 않도록 예제의 실제 package.
export const DEFAULT_ANDROID_PACKAGE = 'com.altshifted.reactnativecalculator';

/** 기기 측 핫 디렉터 절대 경로 — primary user(0) 기준 filesDir 계약 경로. */
export function hotDirAbsolute(pkg) {
  return `/data/user/0/${pkg}/files/rustra/hot`;
}

export function readFlag(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

/** adb shell 원격 명령 — 메타문자 없는 단순 인자만 쓴다(인용 금지 계약).
 * 기기/adb 가 멈춰 서면 스크립트가 무한 대기하지 않게 기본 타임아웃을 둔다. */
export function runAdb(adb, serial, remoteCommand, timeoutMs = 30_000) {
  const result = Bun.spawnSync({
    cmd: [adb, '-s', serial, 'shell', remoteCommand],
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** run-as/sh 출력의 \r 제거 + trim — adb shell 을 거치면 CRLF 가 섞인다. */
export function cleanShellOutput(value) {
  return value.replaceAll('\r', '').trim();
}

/** app.json(expo.android.package) → build.gradle(applicationId) 순 감지.
 * Bun.file().text() 는 Promise 다 — 반드시 await 해야 한다(await 누락 시
 * JSON.parse(Promise) 가 항상 throw 로 잡혀 감지가 전부 dead code 가 된다). */
export async function detectAndroidPackage(appRoot = APP_ROOT) {
  try {
    const appJson = JSON.parse(await Bun.file(resolve(appRoot, 'app.json')).text());
    const detected = appJson?.expo?.android?.package;
    if (typeof detected === 'string' && detected.length > 0) {
      return { package: detected, source: 'app.json' };
    }
  } catch {
    // app.json 이 없거나 깨진 경우 gradle 로 폴백한다.
  }
  try {
    const gradle = await Bun.file(resolve(appRoot, 'android/app/build.gradle')).text();
    const match = /applicationId\s*=\s*['"]([^'"]+)['"]/.exec(gradle);
    if (match) return { package: match[1], source: 'android/app/build.gradle' };
  } catch {
    // build.gradle 이 없으면 호출부 폴백(기본값)으로 넘어간다.
  }
  return { package: DEFAULT_ANDROID_PACKAGE, source: 'default' };
}

function failWith(message, detail) {
  const suffix = detail ? `\n${detail}` : '';
  throw new Error(`${message}${suffix}`);
}

export async function main(argv = Bun.argv.slice(2)) {
  const cdylibArg = argv.find((value) => !value.startsWith('--'));
  if (!cdylibArg) {
    failWith(
      'usage: bun scripts/hot-core-push-android.mjs <cdylib.so path> [--serial s] [--package p] [--name n]',
    );
  }
  const cdylibPath = resolve(process.cwd(), cdylibArg);
  const adb = readFlag(argv, '--adb', process.env.ADB || 'adb');
  const serial = readFlag(argv, '--serial', process.env.ADB_SERIAL || DEFAULT_SERIAL);
  const explicitPackage = readFlag(argv, '--package', process.env.RUSTRA_ANDROID_PACKAGE);

  if (!/\.so$/i.test(cdylibPath)) {
    failWith(
      `swap unit must be an ELF shared object (.so): ${cdylibPath}`,
      'hint: cargo ndk -t arm64-v8a build --release -p rustra-hot-core-variant --features behavior',
    );
  }
  const cdylibStat = await stat(cdylibPath).catch(() => undefined);
  if (!cdylibStat?.isFile()) {
    failWith(
      `cdylib not found: ${cdylibPath}`,
      'hint: cargo ndk -t arm64-v8a build --release -p rustra-hot-core-variant --features behavior',
    );
  }
  const localBytes = await readFile(cdylibPath);
  const defaultLiveName = `${basename(cdylibPath).replace(/\.so$/i, '')}-hot-live.so`;

  // get-state 는 원격 셸이 아니라 호스트 adb 명령이다.
  const deviceState = Bun.spawnSync({
    cmd: [adb, '-s', serial, 'get-state'],
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 15_000,
  });
  if (deviceState.exitCode !== 0 || cleanShellOutput(deviceState.stdout.toString()) !== 'device') {
    failWith(
      `adb device "${serial}" is not ready`,
      `hint: adb devices 로 직렬을 확인하거나 --serial / ADB_SERIAL 로 지정하세요.\n${[
        deviceState.stdout.toString(),
        deviceState.stderr.toString(),
      ]
        .map(cleanShellOutput)
        .filter(Boolean)
        .join('\n')}`,
    );
  }

  const detected = explicitPackage
    ? { package: explicitPackage, source: 'flag/env' }
    : await detectAndroidPackage();
  const pkg = detected.package;
  const hotDir = hotDirAbsolute(pkg);
  const tmpPath = `${hotDir}/${TMP_LIVE_NAME}`;
  const finalPath = `${hotDir}/${defaultLiveName}`;

  const pmPath = runAdb(adb, serial, `pm path ${pkg}`);
  if (pmPath.exitCode !== 0 || cleanShellOutput(pmPath.stdout).length === 0) {
    failWith(
      `package "${pkg}" (${detected.source}) is not installed on ${serial}`,
      'hint: 먼저 핫 분기 앱을 설치하세요 — cd android && ./gradlew :app:assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk',
    );
  }

  // run-as 가능 여부를 먼저 확인한다. release(비디버깅) 빌드는 run-as 가 거부된다.
  const runAsProbe = runAdb(adb, serial, `run-as ${pkg} id`);
  if (runAsProbe.exitCode !== 0) {
    failWith(
      `run-as "${pkg}" failed — the installed app must be a debuggable build`,
      `hint: gradle assembleDebug 로 설치한 뒤 다시 시도하세요.\n${cleanShellOutput(
        runAsProbe.stderr || runAsProbe.stdout,
      )}`,
    );
  }

  const mkdir = runAdb(adb, serial, `run-as ${pkg} mkdir -p ${hotDir}`);
  if (mkdir.exitCode !== 0) {
    failWith(
      `failed to create ${hotDir} for ${pkg}`,
      cleanShellOutput(mkdir.stderr || mkdir.stdout),
    );
  }

  // 1) dd of=<절대경로> 로 tmp 파일 기록 — 셸 메타문자 0 개, stdin 파이프만 쓴다.
  //    adb 연결이 멈춰 서면 무한 파이프 대기가 되지 않게 타임아웃을 건다.
  const removeTmp = () => {
    // 실패 경로의 tmp 잔여물 정리 — 다음 실행의 dd 가 덮어쓰지만 남겨두지 않는다.
    runAdb(adb, serial, `run-as ${pkg} rm -f ${tmpPath}`);
  };
  const write = Bun.spawn({
    cmd: [adb, '-s', serial, 'shell', `run-as ${pkg} dd of=${tmpPath}`],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
  });
  try {
    write.stdin.write(localBytes);
    write.stdin.end();
  } catch (error) {
    write.kill();
    failWith(
      `failed to stream ${basename(cdylibPath)} through adb stdin`,
      error instanceof Error ? error.message : String(error),
    );
  }
  const writeExit = await write.exited;
  const [writeErr, writeOut] = await Promise.all([
    Bun.readableStreamToText(write.stderr),
    Bun.readableStreamToText(write.stdout),
  ]);
  if (writeExit !== 0) {
    removeTmp();
    failWith(
      `stdin pipe (dd) to ${tmpPath} failed (adb exit ${writeExit})`,
      cleanShellOutput(`${writeErr}\n${writeOut}`) ||
        'hint: 기기 연결이 불안정하다 — adb devices 상태를 확인하세요.',
    );
  }

  // 2) 바이트 수 검증 — 파이프 절단은 조용한 스왑 실패로 이어지므로 loud 하게.
  //    dd stderr 에도 레코드 카운트가 찍히지만 파일을 다시 음어 독립 검증한다.
  const wc = runAdb(adb, serial, `run-as ${pkg} wc -c ${tmpPath}`);
  const remoteSize = Number(cleanShellOutput(wc.stdout).split(/\s+/)[0]);
  if (wc.exitCode !== 0 || !Number.isFinite(remoteSize)) {
    removeTmp();
    failWith(`failed to stat ${tmpPath} on device`, cleanShellOutput(wc.stderr || wc.stdout));
  }
  if (remoteSize !== localBytes.length) {
    removeTmp();
    failWith(
      `truncated transfer: local=${localBytes.length} bytes, remote=${remoteSize} bytes`,
      'hint: adb 연결이 불안정하다 — 스크립트를 다시 실행하세요.',
    );
  }

  // 3) run-as mv = 동일 디렉터 rename(2) — 감시 중인 코어에 원자적으로 노출.
  const mv = runAdb(adb, serial, `run-as ${pkg} mv ${tmpPath} ${finalPath}`);
  if (mv.exitCode !== 0) {
    removeTmp();
    failWith(
      `atomic mv ${tmpPath} -> ${finalPath} failed`,
      cleanShellOutput(mv.stderr || mv.stdout),
    );
  }

  console.log(
    `hot-core pushed: ${basename(cdylibPath)} (${localBytes.length} bytes) -> ${pkg}:${finalPath} on ${serial}`,
  );
  console.log(
    `watch for the swap in logcat: adb -s ${serial} logcat -v time | grep '[RustraHotCore]'`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

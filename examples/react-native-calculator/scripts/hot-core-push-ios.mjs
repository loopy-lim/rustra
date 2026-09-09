// iOS 시뮬레이터 핫 코어 스왑 유닛 전달 스크립트.
//
// 호스트에서 빌드한 cdylib(<stem>.dylib)를 앱 샌드박스의 핫 디렉터
// (<data container>/Documents/rustra/hot)로 전달한다. iOS 어댑터는 설치 시
// env RUSTRA_HOT_CORE_DIR(디렉터)을 읽고 그 안의 `*-hot-live.*` 를 폴링해
// dlopen 스왑한다 — 이 스크립트는 항상 tmp 파일로 기록한 뒤 동일 디렉터
// rename 으로 원자 교체한다(push-android 와 대칭 계약).
//
// 제자리 덮어쓰기 금지(실측): iOS 에서 프로세스가 dlopen 중인 파일을 같은
// 경로로 덮어쓰면 SIGKILL 이 떨어진다. tmp+rename 은 기존 inode 를 보존하므로
// 안전하다. 시뮬레이터 앱 컨테이너는 호스트 FS 라 직접 기록이 가능하다(실기기는
// 스코프 외 — 그 경우 별도 전송 경로가 필요하다).
//
// 컨테이너 경로는 `xcrun simctl get_app_container <udid> <bundle-id> data` 로
// 매 실행마다 다시 조회한다 — 재설치 시 컨테이너 경로가 바뀔 수 있고, 런치 시
// SIMCTL_CHILD_RUSTRA_HOT_CORE_DIR 로 앱에 넘겨준 경로와 이 스크립트가 계산하는
// 경로가 어긋나면 스왑이 영원히 관측되지 않는다.
//
// 사용법:
//   bun scripts/hot-core-push-ios.mjs <cdylib.dylib 경로> [옵션]
// 옵션:
//   --udid <udid>       시뮬레이터 UDID (env RUSTRA_SIM_UDID, 기본 booted)
//   --bundle-id <id>    앱 bundle id (자동 감지: app.json → expo.ios.bundleIdentifier,
//                       실패 시 env RUSTRA_IOS_BUNDLE_ID, 최후 기본값)
//   --name <name>       기기 측 live 파일명 (기본 <입력 stem>-hot-live.dylib)

import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = resolve(SCRIPT_DIR, '..');
export const DEFAULT_UDID = 'booted';
export const TMP_LIVE_NAME = 'live-tmp.dylib';
// 최후 폴백 — 감지가 모두 실패해도 smoke 흐름이 막히지 않도록 예제의 실제 bundle id.
export const DEFAULT_IOS_BUNDLE_ID = 'com.alt-shifted.react-native-calculator';

export function readFlag(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

/** simctl/xcodebuild 출력의 \r 제거 + trim — 스모크가 재사용한다. */
export function cleanSimctlOutput(value) {
  return value.replaceAll('\r', '').trim();
}

function failWith(message, detail) {
  const suffix = detail ? `\n${detail}` : '';
  throw new Error(`${message}${suffix}`);
}

/** app.json(expo.ios.bundleIdentifier) 감지 — push-android 의 package 감지와 대칭.
 *  Bun.file().text() 는 Promise 라 반드시 await 해야 한다(감지가 조용히 기본값으로
 *  떨어지는 사고를 막는다). */
export async function detectIosBundleId(appRoot = APP_ROOT) {
  try {
    const appJson = JSON.parse(await Bun.file(resolve(appRoot, 'app.json')).text());
    const detected = appJson?.expo?.ios?.bundleIdentifier;
    if (typeof detected === 'string' && detected.length > 0) {
      return { bundleId: detected, source: 'app.json' };
    }
  } catch {
    // app.json 이 없거나 깨진 경우 호출부 폴백(기본값)으로 넘어간다.
  }
  return { bundleId: DEFAULT_IOS_BUNDLE_ID, source: 'default' };
}

function runSimctl(args) {
  const result = Bun.spawnSync({
    cmd: ['xcrun', 'simctl', ...args],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/**
 * "booted" 별칭 또는 UDID 를 실제 부팅된 UDID 로 해석한다. `simctl list devices`
 * 출력에서 상태가 Booted 인 기기를 찾는다 — get_app_container 에 죽은 UDID 를
 * 넘기면 에러 메시지가 불친절해서 여기서 loud 하게 실패한다.
 */
export function resolveBootedUdid(udidInput) {
  const list = runSimctl(['list', 'devices']);
  if (list.exitCode !== 0) {
    failWith('xcrun simctl list devices failed', list.stderr.trim() || list.stdout.trim());
  }
  const lines = list.stdout.split('\n');
  const booted = [];
  for (const line of lines) {
    const match = /\(([0-9A-Fa-f-]{36})\).*\(Booted\)/.exec(line);
    if (match) booted.push(match[1]);
  }
  if (udidInput && udidInput !== DEFAULT_UDID) {
    const normalized = udidInput.trim();
    if (!booted.includes(normalized)) {
      failWith(
        `simulator "${normalized}" is not booted`,
        `hint: xcrun simctl boot ${normalized} 후 bootstatus 로 부팅을 기다리거나, 부팅된 기기 UDID 를 --udid 로 지정하세요.\nbooted: ${booted.join(', ') || '(none)'}`,
      );
    }
    return normalized;
  }
  if (booted.length === 0) {
    failWith(
      'no booted iOS simulator found',
      'hint: xcrun simctl boot "iPhone 17" 으로 시뮬레이터를 먼저 부팅하세요.',
    );
  }
  return booted[0];
}

/** 설치된 앱의 data 컨테이너 절대 경로 조회 — 미설치 시 loud 실패. */
export function dataContainer(udid, bundleId) {
  const result = runSimctl(['get_app_container', udid, bundleId, 'data']);
  const path = result.stdout.trim();
  if (result.exitCode !== 0 || path.length === 0) {
    failWith(
      `app "${bundleId}" is not installed on ${udid}`,
      `hint: 먼저 핫 분기 앱을 설치하세요 — bun run verify:native:ios && xcrun simctl install <udid> ios/build/rustra-derived-data/Build/Products/Debug-iphonesimulator/reactnativecalculator.app\n${
        result.stderr.trim() || result.stdout.trim()
      }`,
    );
  }
  return path;
}

export async function main(argv = Bun.argv.slice(2)) {
  const cdylibArg = argv.find((value) => !value.startsWith('--'));
  if (!cdylibArg) {
    failWith(
      'usage: bun scripts/hot-core-push-ios.mjs <cdylib.dylib path> [--udid udid] [--bundle-id id] [--name name]',
    );
  }
  const cdylibPath = resolve(process.cwd(), cdylibArg);
  const udidInput = readFlag(argv, '--udid', process.env.RUSTRA_SIM_UDID || DEFAULT_UDID);
  const explicitBundleId = readFlag(argv, '--bundle-id', process.env.RUSTRA_IOS_BUNDLE_ID);

  if (!/\.dylib$/i.test(cdylibPath)) {
    failWith(
      `swap unit must be a Mach-O dylib (.dylib): ${cdylibPath}`,
      'hint: cargo build --release --target aarch64-apple-ios-sim -p rustra-hot-core-variant --features behavior',
    );
  }
  const cdylibStat = await stat(cdylibPath).catch(() => undefined);
  if (!cdylibStat?.isFile()) {
    failWith(
      `cdylib not found: ${cdylibPath}`,
      'hint: cargo build --release --target aarch64-apple-ios-sim -p rustra-hot-core-variant --features behavior',
    );
  }
  const localBytes = await readFile(cdylibPath);
  const defaultLiveName = `${basename(cdylibPath).replace(/\.dylib$/i, '')}-hot-live.dylib`;
  const liveName = readFlag(argv, '--name', defaultLiveName);

  const udid = resolveBootedUdid(udidInput);
  const detected = explicitBundleId
    ? { bundleId: explicitBundleId, source: 'flag/env' }
    : await detectIosBundleId();
  const bundleId = detected.bundleId;
  const hotDir = join(dataContainer(udid, bundleId), 'Documents', 'rustra', 'hot');
  const tmpPath = join(hotDir, TMP_LIVE_NAME);
  const finalPath = join(hotDir, liveName);

  await mkdir(hotDir, { recursive: true });
  // 이전 실행의 stale tmp 가 있으면 rename 이 덮어쓰지 못하고 실패할 수 있으므로
  // 기록 전에 확실히 치운다.
  await rm(tmpPath, { force: true });

  // 1) tmp 파일 기록 — 시뮬레이터 컨테이너는 호스트 FS 라 직접 쓰기가 가능하다.
  await Bun.write(tmpPath, localBytes);
  const writtenStat = await stat(tmpPath).catch(() => undefined);
  if (!writtenStat || writtenStat.size !== localBytes.length) {
    await rm(tmpPath, { force: true });
    failWith(
      `truncated transfer: local=${localBytes.length} bytes, remote=${writtenStat?.size ?? 'missing'}`,
      'hint: 디스크 여유 공간과 컨테이너 경로 권한을 확인하세요.',
    );
  }

  // 2) 동일 디렉터 rename(2) — 폴링 중인 코어에 원자적으로 노출. 제자리
  //    덮어쓰기와 달리 기존 inode 가 보존돼 dlopen 중인 프로세스가 죽지 않는다.
  await rename(tmpPath, finalPath);

  console.log(
    `hot-core pushed: ${basename(cdylibPath)} (${localBytes.length} bytes) -> ${bundleId}:${finalPath} on ${udid}`,
  );
  console.log(
    `watch for the swap in the log stream: xcrun simctl spawn ${udid} log stream --style compact --predicate 'eventMessage CONTAINS "[RustraHotCore]"'`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

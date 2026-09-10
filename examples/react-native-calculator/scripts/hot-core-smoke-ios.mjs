// iOS 시뮬레이터 핫 코어 스왑 스모크(bun scripts/hot-core-smoke-ios.mjs).
//
// 전체 흐름(Android 판 hot-core-smoke-android.mjs 와 대칭):
//   (a) cargo 로 스왑 유닛 cdylib 빌드 — aarch64-apple-ios-sim 대상
//       rustra-hot-core-variant 를 plain(기본, addNumbers = a+b)과 behavior
//       변형(--features behavior, addNumbers = a+b+100)으로 각각 빌드해 staging
//       사본을 남긴다. 같은 출력 경로를 덮어쓰므로 매 단계 후 반드시 사본을
//       떠둔다(마지막 빌드가 이전 산출물을 가린다).
//   (b) xcodebuild(verify:native:ios 와 동일 인자)로 핫 분기 앱을 빌드·설치.
//   (c) EXPO_PUBLIC_RUSTRA_DEMO=hot-core 로 서빙 중인 Metro 에서 앱 부팅 →
//       [RustraHotCore] READY value=5 토큰 대기 → behavior cdylib 를
//       hot-core-push-ios.mjs 로 원자 전달 → **재로드 없이** 같은 로그
//       스트림에서 addNumbers 5→105 전환을 관측하면 통과.
//
// iOS 전달 계약 — Android 와 다른 점 두 가지:
//   - 핫 디렉터는 filesDir 가 아니라 앱 data 컨테이너의 Documents/rustra/hot.
//     어댑터는 JSI 설치 시 env RUSTRA_HOT_CORE_DIR(디렉터)을 읽으므로, 런치 전에
//     컨테이너를 조회해 SIMCTL_CHILD_ 접두사로 경로를 주입한다(simctl 이 자식
//     프로세스 환경을 앱에 전파 — 실측 확인). 디렉터가 비어 있으면 정적 코어로
//     부팅된다(stale live 파일이 있으면 부팅 직후 스왑이 일어나 baseline 이
//     무효화되므로 런치 전에 rm -f 로 확실히 치운다).
//   - 시뮬레이터 컨테이너는 호스트 FS 라 직접 기록이 가능하지만, 제자리
//     덮어쓰기는 iOS 에서 SIGKILL — 전달은 항상 tmp 기록 후 동일 디렉터
//     rename(push 스크립트가 강제).
//
// 로그 관측 계약(HotCoreApp): [RustraHotCore] READY value=<v> /
// addNumbers=<value> hash=<8자> / FAILED message=<...>
//
// 사용법:
//   bun scripts/hot-core-smoke-ios.mjs [옵션]
// 옵션:
//   --udid <u>            시뮬레이터 UDID (env RUSTRA_SIM_UDID, 기본: 부팅된 기기,
//                         없으면 iPhone 17 기본 UDID 를 부팅)
//   --bundle-id <id>      앱 bundle id (기본은 app.json 자동 감지)
//   --skip-cargo          (a) cdylib 빌드 스킵 — 기존 staging 산출물 사용
//   --skip-xcodebuild     (b) 앱 빌드 스킵 — 기존 설치 사용
//   --ready-timeout-ms    부팅 토큰 대기 (기본 240000 — 첫 Metro 번들은 느리다)
//   --swap-timeout-ms     스왑 관측 대기 (기본 90000)

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanSimctlOutput,
  detectIosBundleId,
  TMP_LIVE_NAME,
  DEFAULT_UDID,
  readFlag,
} from './hot-core-push-ios.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_ROOT = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(EXAMPLE_ROOT, '..', '..');
const LOG_PREFIX = '[RustraHotCore]';
const BASELINE_VALUE = 5; // addNumbers(2,3) — 정적 코어(plain) 기준값
const SWAPPED_VALUE = 105; // behavior 변형 스왑 후 — 2+3+100
const METRO_URL = process.env.RUSTRA_METRO_URL || 'http://127.0.0.1:8081';
const APP_RELATIVE_PATH =
  'ios/build/rustra-derived-data/Build/Products/Debug-iphonesimulator/reactnativecalculator.app';

function fail(message, detail) {
  const suffix = detail ? `\n${detail}` : '';
  throw new Error(`${message}${suffix}`);
}

function run(command, args, options = {}) {
  const label = `${command} ${args.join(' ')}`;
  const result = Bun.spawnSync({
    cmd: [command, ...args],
    cwd: options.cwd,
    env: options.env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: options.timeoutMs,
  });
  // stdoutOnly — 경로처럼 stdout 이 계약인 명령에서 stderr 잡음(경고 등)이
  // 출력을 오염시키지 않게 분리한다. 기본은 진단 편의를 위해 둘을 합친다.
  const output = options.stdoutOnly
    ? cleanSimctlOutput(result.stdout.toString())
    : [cleanSimctlOutput(result.stdout.toString()), cleanSimctlOutput(result.stderr.toString())]
        .filter(Boolean)
        .join('\n');
  if (options.stream && output.length > 0) console.log(output);
  if (result.exitCode !== 0 && !options.allowFailure) {
    fail(`command failed (${result.exitCode}): ${label}`, output);
  }
  return { output, exitCode: result.exitCode };
}

function parseArgs(argv) {
  return {
    udidInput: readFlag(argv, '--udid', process.env.RUSTRA_SIM_UDID || DEFAULT_UDID),
    bundleIdOverride: readFlag(argv, '--bundle-id', process.env.RUSTRA_IOS_BUNDLE_ID),
    skipCargo: argv.includes('--skip-cargo'),
    skipXcodebuild: argv.includes('--skip-xcodebuild'),
    readyTimeoutMs: Number(readFlag(argv, '--ready-timeout-ms', '240000')),
    swapTimeoutMs: Number(readFlag(argv, '--swap-timeout-ms', '90000')),
  };
}

// cargo 는 plain 빌드와 behavior 빌드가 같은 출력 경로(librustra_hot_core_variant.dylib)를
// 덮어쓴다 — 매 빌드 직후 staging 사본을 만들어 두 변형을 동시에 보관한다.
const CARGO_TARGET_OUT = resolve(REPO_ROOT, 'target', 'aarch64-apple-ios-sim', 'release');
const RAW_DYLIB = resolve(CARGO_TARGET_OUT, 'librustra_hot_core_variant.dylib');
const STAGING_ROOT = resolve(CARGO_TARGET_OUT, 'hot-core-staging');
const PLAIN_DYLIB = resolve(STAGING_ROOT, 'plain', 'librustra_hot_core_variant.dylib');
const BEHAVIOR_DYLIB = resolve(STAGING_ROOT, 'behavior', 'librustra_hot_core_variant.dylib');

function buildCdylibs() {
  // (a-1) 정적 코어 — 기본 feature(addNumbers = a+b). behavior 변형과 스키마가
  // 동일해 계약 해시가 같다(시나리오 1 전제). parity 게이트가 없으므로 이 전제는
  // READY value=5 관측 + 105 전환으로 스모크가 직접 증명한다.
  console.log('  building plain rustra-hot-core-variant cdylib (aarch64-apple-ios-sim)…');
  run(
    'cargo',
    ['build', '--release', '--target', 'aarch64-apple-ios-sim', '-p', 'rustra-hot-core-variant'],
    {
      cwd: REPO_ROOT,
      timeoutMs: 600_000,
      stream: true,
    },
  );
  run('mkdir', ['-p', resolve(STAGING_ROOT, 'plain')]);
  run('cp', [RAW_DYLIB, PLAIN_DYLIB]);
  // (a-2) 관측 가능한 스왑 유닛 — addNumbers 본문만 +100(시그니처 불변 로직 변경).
  // 같은 출력 경로를 덮어쓰므로 위 plain 사본이 있어야 순서가 유의미하다.
  console.log('  building behavior rustra-hot-core-variant cdylib (--features behavior)…');
  run(
    'cargo',
    [
      'build',
      '--release',
      '--target',
      'aarch64-apple-ios-sim',
      '-p',
      'rustra-hot-core-variant',
      '--features',
      'behavior',
    ],
    { cwd: REPO_ROOT, timeoutMs: 600_000, stream: true },
  );
  run('mkdir', ['-p', resolve(STAGING_ROOT, 'behavior')]);
  run('cp', [RAW_DYLIB, BEHAVIOR_DYLIB]);
  for (const artifact of [PLAIN_DYLIB, BEHAVIOR_DYLIB]) {
    if (!existsSync(artifact)) fail(`expected cdylib missing after build: ${artifact}`);
  }
}

/** 부팅된 기기가 전혀 없을 때 부팅할 기본 기기 — "available" 목록의 첫 iPhone.
 *  특정 기기의 UDID 를 하드코딩하지 않는다(다른 머신에 없는 UDID 는 boot 실패).
 *  env RUSTRA_SIM_FALLBACK_DEVICE 로 이름(부분 일치)을 지정할 수 있다. */
function pickDefaultDeviceUdid() {
  const available = run('xcrun', ['simctl', 'list', 'devices', 'available'], {
    timeoutMs: 30_000,
  });
  const nameFilter = process.env.RUSTRA_SIM_FALLBACK_DEVICE;
  for (const line of available.output.split('\n')) {
    const match = /^\s*(.+?)\s*\(([0-9A-Fa-f-]{36})\)/.exec(line);
    if (!match) continue;
    if (nameFilter ? line.includes(nameFilter) : /iPhone/i.test(match[1])) {
      return { name: match[1].trim(), udid: match[2] };
    }
  }
  return null;
}

/** 부팅된 시뮬레이터 UDID 해석 — 없으면 기본 기기(available 첫 iPhone)를 부팅하고 대기. */
function ensureBootedDevice(udidInput) {
  const list = run('xcrun', ['simctl', 'list', 'devices'], { timeoutMs: 30_000 });
  const booted = [];
  for (const line of list.output.split('\n')) {
    const match = /\(([0-9A-Fa-f-]{36})\).*\(Booted\)/.exec(line);
    if (match) booted.push(match[1]);
  }
  let udid;
  if (udidInput && udidInput !== DEFAULT_UDID) {
    udid = udidInput.trim();
  } else if (booted.length > 0) {
    return booted[0];
  } else {
    const fallback = pickDefaultDeviceUdid();
    if (!fallback) {
      fail(
        'no booted simulator and no available iPhone to boot',
        'hint: Xcode → Settings → Components 에서 시뮬레이터 런타임을 설치하거나 --udid 로 지정하세요.',
      );
    }
    console.log(`  no booted simulator — defaulting to ${fallback.name}`);
    udid = fallback.udid;
  }
  if (!booted.includes(udid)) {
    console.log(`  booting simulator ${udid}…`);
    run('xcrun', ['simctl', 'boot', udid], { timeoutMs: 60_000 });
  }
  // bootstatus -b 는 부팅이 끝날 때까지(필요하면 부팅까지) 호스트에서 대기한다.
  run('xcrun', ['simctl', 'bootstatus', udid, '-b'], { timeoutMs: 300_000 });
  return udid;
}

function buildAndInstallApp({ udid, bundleId }) {
  // (b) 핫 분기 앱 빌드 — verify:native:ios 와 동일 인자. pod 의
  // prepare_command(build-rust-ios.sh)가 검증한 러스트 정적 아카이브를
  // -force_load 한다. 산출물(.app)은 커밋 금지 빌드 산출물이다.
  const appPath = resolve(EXAMPLE_ROOT, APP_RELATIVE_PATH);
  if (!existsSync(resolve(EXAMPLE_ROOT, 'ios', 'Pods'))) {
    fail(
      'ios/Pods is missing — pod install has not run for this workspace',
      'hint: examples/react-native-calculator 에서 bun run ios 로 pod install 을 먼저 실행하세요.',
    );
  }
  run(
    'xcodebuild',
    [
      '-workspace',
      'ios/reactnativecalculator.xcworkspace',
      '-scheme',
      'reactnativecalculator',
      '-configuration',
      'Debug',
      '-sdk',
      'iphonesimulator',
      '-destination',
      'generic/platform=iOS Simulator',
      '-derivedDataPath',
      'ios/build/rustra-derived-data',
      'CODE_SIGNING_ALLOWED=NO',
      'build',
    ],
    { cwd: EXAMPLE_ROOT, timeoutMs: 1_500_000, stream: true },
  );
  if (!existsSync(appPath)) fail(`debug .app missing after xcodebuild: ${appPath}`);
  // 실행 중인 앱 위로의 재설치는 가끔 실패한다(Android 설치 폴백과 동일한 수선
  // 패턴) — 종료 후 재시도, 그래도 실패하면 제거 후 신규 설치. terminate 는 앱이
  // 실행 중이 아닐 때도 실패하므로 정상 상황으로 취급한다.
  run('xcrun', ['simctl', 'terminate', udid, bundleId], { timeoutMs: 60_000, allowFailure: true });
  try {
    run('xcrun', ['simctl', 'install', udid, appPath], { timeoutMs: 300_000, stream: true });
  } catch {
    console.log(`  install failed — falling back to uninstall + fresh install of ${bundleId}`);
    run('xcrun', ['simctl', 'uninstall', udid, bundleId], { timeoutMs: 120_000 });
    run('xcrun', ['simctl', 'install', udid, appPath], { timeoutMs: 300_000, stream: true });
  }
}

async function checkMetro() {
  let body = '';
  try {
    const response = await fetch(`${METRO_URL}/status`, { signal: AbortSignal.timeout(5_000) });
    body = cleanSimctlOutput(await response.text());
  } catch {
    fail(
      `Metro is not reachable at ${METRO_URL}`,
      'hint: 별도 터미널에서 bun run demo:hot-core 를 먼저 실행하세요(EXPO_PUBLIC_RUSTRA_DEMO=hot-core).',
    );
  }
  if (body !== 'packager-status:running') {
    fail(
      `Metro status is unexpected at ${METRO_URL}: ${body}`,
      'hint: bun run demo:hot-core 로 핫 분기 번들을 서빙하세요.',
    );
  }
}

// 단일 소비자 디스패치 — 하나의 스트림에 for-await 소비자를 2개 붙이면 청크가
// 경쟁 분배돼 대기자에게 라인이 아예 전달되지 않는다(Android 스모크 실측과 동일).
// 스트림 리더는 startLogStream 하나만 두고 라인을 현재 대기자에게 갈아끼운다.
let logLineSink = null;

function startLogStream(udid) {
  const child = spawn(
    'xcrun',
    [
      'simctl',
      'spawn',
      udid,
      'log',
      'stream',
      '--style',
      'compact',
      '--level',
      'debug',
      '--predicate',
      `eventMessage CONTAINS "${LOG_PREFIX}"`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let closeCallback = null;
  void (async () => {
    const decoder = new TextDecoder();
    let lineBuffer = '';
    try {
      for await (const chunk of child.stdout) {
        lineBuffer += decoder.decode(chunk, { stream: true });
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.includes(LOG_PREFIX)) logLineSink?.(line);
        }
      }
    } catch {
      // 스트림 오류는 close 통지로 처리한다.
    }
    closeCallback?.();
  })();
  return {
    kill: () => child.kill(),
    onClose: (callback) => {
      closeCallback = callback;
    },
    setLineSink: (sink) => {
      logLineSink = sink;
    },
  };
}

function waitReadyToken(logStream, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logStream.setLineSink(null);
      rejectPromise(
        new Error(
          `${LOG_PREFIX} READY token not seen within ${timeoutMs}ms — ` +
            '앱이 hot-core 분기(EXPO_PUBLIC_RUSTRA_DEMO=hot-core)로 번들링됐는지 확인하세요.',
        ),
      );
    }, timeoutMs);
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logStream.setLineSink(null);
      error ? rejectPromise(error) : resolvePromise(value);
    };
    logStream.onClose(() => settle(new Error('log stream ended before READY token')));
    logStream.setLineSink((line) => {
      if (/FAILED message=/.test(line)) {
        settle(new Error(`app reported failure: ${line.trim()}`));
        return;
      }
      const ready = line.match(/READY value=(-?\d+)/);
      if (ready) {
        // 원문 라인(로그 타임스탬프 포함)을 그대로 남긴다 — 통과 판정의 증적.
        console.log(`  observed: ${line.trim()}`);
        settle(undefined, Number(ready[1]));
      }
    });
  });
}

function waitSwapToken(logStream, swappedValue, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const seen = new Set();
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logStream.setLineSink(null);
      rejectPromise(
        new Error(
          `addNumbers=${swappedValue} not observed within ${timeoutMs}ms — ` +
            '코어 폴링 스왑이 없었거나 전달 파일명이 *-hot-live.dylib 계약과 어긋난다.',
        ),
      );
    }, timeoutMs);
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logStream.setLineSink(null);
      error ? rejectPromise(error) : resolvePromise(value);
    };
    logStream.onClose(() => settle(new Error('log stream ended before the swap was observed')));
    logStream.setLineSink((line) => {
      if (/FAILED message=/.test(line)) {
        settle(new Error(`app reported failure: ${line.trim()}`));
        return;
      }
      const value = line.match(/addNumbers=(-?\d+)/);
      if (value) {
        seen.add(Number(value[1]));
        if (Number(value[1]) === swappedValue) {
          // 원문 라인(로그 타임스탬프 포함)을 그대로 남긴다 — push→관측 구간의
          // 스왑 레이턴시 증적이 된다.
          console.log(`  observed: ${line.trim()}`);
          settle(
            undefined,
            [...seen].sort((left, right) => left - right),
          );
        }
      }
    });
  });
}

export async function main(argv = Bun.argv.slice(2)) {
  const options = parseArgs(argv);
  const detected = options.bundleIdOverride
    ? { bundleId: options.bundleIdOverride, source: 'flag/env' }
    : await detectIosBundleId();
  const bundleId = detected.bundleId;

  const udid = ensureBootedDevice(options.udidInput);
  console.log(`  using simulator ${udid}`);

  if (options.skipCargo) {
    console.log('[1/5] skipping cdylib build (using existing staged artifacts)');
    if (!existsSync(BEHAVIOR_DYLIB)) {
      fail(
        `behavior cdylib missing: ${BEHAVIOR_DYLIB}`,
        'hint: --skip-cargo 없이 다시 실행하세요.',
      );
    }
  } else {
    console.log('[1/5] building swap-unit cdylibs (cargo, aarch64-apple-ios-sim, release)…');
    buildCdylibs();
  }

  if (options.skipXcodebuild) {
    console.log('[2/5] skipping xcodebuild (assumes the app is already installed)');
  } else {
    console.log(
      '[2/5] building + installing the hot-core app (xcodebuild, Debug-iphonesimulator)…',
    );
    buildAndInstallApp({ udid, bundleId });
  }

  console.log('[3/5] checking Metro, clearing stale live artifacts, launching the app…');
  await checkMetro();

  // 런치 전 컨테이너를 확보해 env 경로와 push 경로가 같은 문자열이 되게 한다 —
  // 재설치 시 컨테이너 경로가 바뀌면 앱이 보는 디렉터와 push 대상이 어긋난다.
  // stdoutOnly — 경로 계약은 stdout 이다. stderr 잡음이 섞이면 push 스크립트가
  // 계산한 컨테이너와 조용히 어긋나 스왑이 영원히 관측되지 않는다.
  const container = run('xcrun', ['simctl', 'get_app_container', udid, bundleId, 'data'], {
    timeoutMs: 60_000,
    stdoutOnly: true,
  }).output.trim();
  if (container.length === 0) {
    fail(
      `app "${bundleId}" (${detected.source}) is not installed on ${udid}`,
      'hint: --skip-xcodebuild 없이 다시 실행해 앱을 빌드·설치하세요.',
    );
  }
  const hotDir = resolve(container, 'Documents', 'rustra', 'hot');
  run('mkdir', ['-p', hotDir]);
  // stale live 아티팩트를 치운다 — 남아 있으면 부팅 직후 스왑이 일어나
  // baseline(5) 관측이 무효화된다. 비어 있으면 정적 코어로 부팅된다.
  if (existsSync(hotDir)) {
    for (const name of readdirSync(hotDir)) {
      if (name.endsWith('-hot-live.dylib') || name === TMP_LIVE_NAME) {
        run('rm', ['-f', resolve(hotDir, name)]);
      }
    }
  }

  const logStream = startLogStream(udid);
  try {
    // 스트림이 붙은 뒤 런치해야 첫 READY 를 놓치지 않는다(reload-stress 패턴).
    await Bun.sleep(500);
    const launch = Bun.spawnSync({
      cmd: ['xcrun', 'simctl', 'launch', '--terminate-running-process', udid, bundleId],
      env: { ...process.env, SIMCTL_CHILD_RUSTRA_HOT_CORE_DIR: hotDir },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    });
    if (launch.exitCode !== 0) {
      fail(
        `simctl launch failed for ${bundleId}`,
        cleanSimctlOutput(launch.stderr.toString()) || cleanSimctlOutput(launch.stdout.toString()),
      );
    }

    console.log(`[4/5] waiting for ${LOG_PREFIX} READY value=${BASELINE_VALUE}…`);
    const baseline = await waitReadyToken(logStream, options.readyTimeoutMs);
    if (baseline !== BASELINE_VALUE) {
      fail(
        `baseline addNumbers=${baseline}, expected ${BASELINE_VALUE}`,
        'hint: stale live 아티팩트가 남아 있거나 정적 코어가 plain 이 아니다.',
      );
    }

    console.log(
      `[5/5] pushing behavior cdylib (tmp+rename) and waiting for addNumbers=${SWAPPED_VALUE}…`,
    );
    // 관측 싱크를 push **이전에** 붙인다 — 스왑은 push 뒤 수백 ms 만에 일어나고
    // 첫 105 로그가 대기자 등록을 앞설 수 있다(Android 실측과 동일).
    const swapObserved = waitSwapToken(logStream, SWAPPED_VALUE, options.swapTimeoutMs);
    // push 가 먼저 실패해 await 에 도달하지 못하면 이 프로미스는 나중에
    // stream-close/타임아웃으로 거부된다 — 미처리 거부 이중 장애를 막는 no-op
    // catch 다(실제 오류 전파는 await 지점에서 그대로 일어난다).
    swapObserved.catch(() => {});
    const pushStartedAt = Date.now();
    run(
      'bun',
      [
        resolve(SCRIPT_DIR, 'hot-core-push-ios.mjs'),
        BEHAVIOR_DYLIB,
        '--udid',
        udid,
        '--bundle-id',
        bundleId,
      ],
      { timeoutMs: 120_000, stream: true },
    );

    const observed = await swapObserved;
    const swapLatencyMs = Date.now() - pushStartedAt;
    console.log(
      `RN hot-core smoke passed: addNumbers ${BASELINE_VALUE} -> ${SWAPPED_VALUE} without a JS reload (observed=${observed.join(' -> ')}, swap latency=${swapLatencyMs}ms)`,
    );
  } finally {
    logStream.kill();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

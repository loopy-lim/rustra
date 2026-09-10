// Android 핫 코어 스왑 스모크(bun scripts/hot-core-smoke-android.mjs).
//
// 전체 흐름:
//   (a) cargo ndk 로 스왑 유닛 cdylib 빌드 — plain(rustra-calculator-example,
//       계약 해시 동일성 전제 유지)과 behavior 변형(rustra-hot-core-variant
//       --features behavior, addNumbers = a+b+100) 둘 다.
//   (b) gradle assembleDebug 로 핫 분기 앱을 빌드·설치.
//   (c) EXPO_PUBLIC_RUSTRA_DEMO=hot-core 로 서빙 중인 Metro 에서 앱 부팅 →
//       [RustraHotCore] READY value=5 토큰 대기 → behavior cdylib 를
//       hot-core-push-android.mjs 로 원자 전달 → **재로드 없이** 같은 로그
//       스트림에서 addNumbers 5→105 전환을 관측하면 통과.
//
// 로그 관측 계약(HotCoreApp): [RustraHotCore] READY value=<v> /
// addNumbers=<value> hash=<8자> / FAILED message=<...>
//
// 전달 계약 주의 — 제자리 덮어쓰기는 SIGSEGV: 스왑 유닛은 반드시 tmp 기록 후
// rename 으로 교체된다(push 스크립트가 강제). /data/local/tmp 직접 read 는
// SELinux(untrusted_app ↔ shell_data_file) 거부라 stdin 파이프를 쓴다.
//
// 사용법:
//   bun scripts/hot-core-smoke-android.mjs [옵션]
// 옵션:
//   --serial <s>          adb 직렬 (env ADB_SERIAL, 기본 emulator-5554)
//   --package <pkg>       앱 package (기본은 app.json 자동 감지)
//   --skip-cargo          (a) cdylib 빌드 스킵 — 기존 산출물 사용
//   --skip-gradle         (b) 앱 빌드·설치 스킵 — 기존 설치 사용
//   --ready-timeout-ms    부팅 토큰 대기 (기본 240000 — 첫 Metro 번들은 느리다)
//   --swap-timeout-ms     스왑 관측 대기 (기본 90000)
//   --adb <path>          adb 바이너리 (env ADB, 기본 adb)

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanShellOutput,
  detectAndroidPackage,
  DEFAULT_SERIAL,
  hotDirAbsolute,
  TMP_LIVE_NAME,
  readFlag,
} from './hot-core-push-android.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_ROOT = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(EXAMPLE_ROOT, '..', '..');
const LOG_PREFIX = '[RustraHotCore]';
const BASELINE_VALUE = 5; // addNumbers(2,3) — 정적 코어(plain) 기준값
const SWAPPED_VALUE = 105; // behavior 변형 스왑 후 — 2+3+100
const METRO_URL = process.env.RUSTRA_METRO_URL || 'http://127.0.0.1:8081';

function fail(message, detail) {
  const suffix = detail ? `\n${detail}` : '';
  throw new Error(`${message}${suffix}`);
}

function run(command, args, options = {}) {
  const label = `${command} ${args.join(' ')}`;
  const result = Bun.spawnSync({
    cmd: [command, ...args],
    cwd: options.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: options.timeoutMs,
  });
  const output = [
    cleanShellOutput(result.stdout.toString()),
    cleanShellOutput(result.stderr.toString()),
  ]
    .filter(Boolean)
    .join('\n');
  if (options.stream && output.length > 0) console.log(output);
  if (result.exitCode !== 0) fail(`command failed (${result.exitCode}): ${label}`, output);
  return { output, exitCode: result.exitCode };
}

function parseArgs(argv) {
  return {
    serial: readFlag(argv, '--serial', process.env.ADB_SERIAL || DEFAULT_SERIAL),
    pkgOverride: readFlag(argv, '--package', process.env.RUSTRA_ANDROID_PACKAGE),
    skipCargo: argv.includes('--skip-cargo'),
    skipGradle: argv.includes('--skip-gradle'),
    readyTimeoutMs: Number(readFlag(argv, '--ready-timeout-ms', '240000')),
    swapTimeoutMs: Number(readFlag(argv, '--swap-timeout-ms', '90000')),
    adb: readFlag(argv, '--adb', process.env.ADB || 'adb'),
  };
}

// cargo-ndk 는 안드로이드 ABI 명 대신 rust 트리플 명으로 target 디렉터를 만든다.
const CARGO_TARGET_OUT = resolve(REPO_ROOT, 'target', 'aarch64-linux-android', 'release');
const PLAIN_SO = resolve(CARGO_TARGET_OUT, 'librustra_calculator_example.so');
const BEHAVIOR_SO = resolve(CARGO_TARGET_OUT, 'librustra_hot_core_variant.so');

function buildCdylibs() {
  if (!process.env.ANDROID_NDK_HOME && !process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) {
    fail(
      'ANDROID_NDK_HOME/ANDROID_HOME is not set',
      'hint: export ANDROID_HOME=<sdk 경로> — cargo ndk 와 gradle 이 모두 필요로 한다.',
    );
  }
  // (a-1) 미션 지정 스왑 유닛 — plain cdylib. behavior 변형과 스키마가 동일해야
  // 계약 해시가 같다(시나리오 1 전제). 수동 전달에는 parity 게이트가 없으므로
  // 이 전제는 READY value=5 관측 + 105 전환으로 스모크가 직접 증명한다.
  console.log('  building plain rustra-calculator-example cdylib…');
  run(
    'cargo',
    ['ndk', '-t', 'arm64-v8a', 'build', '--release', '-p', 'rustra-calculator-example'],
    { cwd: REPO_ROOT, timeoutMs: 600_000, stream: true },
  );
  // (a-2) 관측 가능한 스왑 유닛 — addNumbers 본문만 +100(시그니처 불변 로직 변경).
  console.log('  building behavior rustra-hot-core-variant cdylib…');
  run(
    'cargo',
    [
      'ndk',
      '-t',
      'arm64-v8a',
      'build',
      '--release',
      '-p',
      'rustra-hot-core-variant',
      '--features',
      'behavior',
    ],
    { cwd: REPO_ROOT, timeoutMs: 600_000, stream: true },
  );
  for (const artifact of [PLAIN_SO, BEHAVIOR_SO]) {
    if (!existsSync(artifact)) fail(`expected cdylib missing after build: ${artifact}`);
  }
}

function buildAndInstallApp({ adb, serial, pkg }) {
  // (b) 핫 분기 앱 빌드 — 생성된 Kotlin 모듈이 install 시 nativeConfigureHotCore
  // (filesDir/rustra/hot)를 호출한다. universal debug APK는 4 ABI 전부 담아
  // 130M+ 라 작은 /data 파티션 설치가 실패할 수 있어, 기본은 에뮬레이터 ABI
  // (arm64-v8a)만 빌드한다 — RN 표준 gradle 속성(RUSTRA_ARCHS로 덮어쓸 수 있음).
  const archs = process.env.RUSTRA_ARCHS ?? 'arm64-v8a';
  const gradlew = resolve(EXAMPLE_ROOT, 'android', 'gradlew');
  run('sh', [gradlew, ':app:assembleDebug', '--no-daemon', `-PreactNativeArchitectures=${archs}`], {
    cwd: resolve(EXAMPLE_ROOT, 'android'),
    timeoutMs: 1_500_000,
    stream: true,
  });
  const apk = resolve(EXAMPLE_ROOT, 'android/app/build/outputs/apk/debug/app-debug.apk');
  if (!existsSync(apk)) fail(`debug APK missing after assembleDebug: ${apk}`);
  // install -r(업데이트)는 이전 설치분과 새 APK 를 잠깐 함께 담아야 해서 작은
  // /data 파티션에서 INSUFFICIENT_STORAGE 로 실패할 수 있다 — 이 스모크는 설치
  // 상태를 유지할 필요가 없으므로 실패 시 제거 후 신규 설치로 폴백한다. 또한
  // gradle 빌드 직후의 전조 상태에선 재시도로 풀리는 순간 실패가 관측됐다(실측:
  // 동일 APK 가 스크립트 경로에선 3연패, 수동 재시도는 성공) — 백오프 재시도를
  // 선행한다.
  const installOnce = (extraArgs) =>
    run(adb, ['-s', serial, 'install', ...extraArgs, apk], {
      timeoutMs: 300_000,
      stream: true,
    });
  let installed = false;
  for (let attempt = 1; attempt <= 3 && !installed; attempt += 1) {
    try {
      installOnce(['-r']);
      installed = true;
    } catch {
      if (attempt === 3) {
        // 파괴적 폴백(uninstall = 앱 데이터 소멸)은 main 이 해석한 pkg 를
        // 그대로 쓴다 — 감지 폴백 기본값이 다른 앱을 가리키는 기기에서 엉뚱한
        // 앱을 지우는 사고를 막는다.
        console.log(
          `  install -r retries exhausted — falling back to uninstall + fresh install of ${pkg}`,
        );
        run(adb, ['-s', serial, 'uninstall', pkg], { timeoutMs: 120_000 });
        installOnce([]);
        installed = true;
      } else {
        console.log(`  install attempt ${attempt} failed — retrying in 15s…`);
        Bun.sleepSync(15_000);
      }
    }
  }
}

async function checkMetro() {
  let body = '';
  try {
    const response = await fetch(`${METRO_URL}/status`, { signal: AbortSignal.timeout(5_000) });
    body = cleanShellOutput(await response.text());
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
// 경쟁 분배돼 대기자에게 라인이 아예 전달되지 않는다(실측: READY 후 105 관측
// 누락). 스트림 리더는 startLogcat 하나만 두고 라인을 현재 대기자에게
// 갈아끼운다.
let logcatLineSink = null;

function startLogcat(adb, serial) {
  const child = spawn(adb, ['-s', serial, 'logcat', '-v', 'time'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
          if (line.includes(LOG_PREFIX)) logcatLineSink?.(line);
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
      logcatLineSink = sink;
    },
  };
}

function waitReadyToken(logcat, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logcat.setLineSink(null);
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
      logcat.setLineSink(null);
      error ? rejectPromise(error) : resolvePromise(value);
    };
    logcat.onClose(() => settle(new Error('logcat stream ended before READY token')));
    logcat.setLineSink((line) => {
      if (/FAILED message=/.test(line)) {
        settle(new Error(`app reported failure: ${line.trim()}`));
        return;
      }
      const ready = line.match(/READY value=(-?\d+)/);
      if (ready) settle(undefined, Number(ready[1]));
    });
  });
}

function waitSwapToken(logcat, swappedValue, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const seen = new Set();
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logcat.setLineSink(null);
      rejectPromise(
        new Error(
          `addNumbers=${swappedValue} not observed within ${timeoutMs}ms — ` +
            '코어 폴링 스왑이 없었거나 전달 파일명이 *-hot-live.so 계약과 어긋난다.',
        ),
      );
    }, timeoutMs);
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logcat.setLineSink(null);
      error ? rejectPromise(error) : resolvePromise(value);
    };
    logcat.onClose(() => settle(new Error('logcat stream ended before the swap was observed')));
    logcat.setLineSink((line) => {
      if (/FAILED message=/.test(line)) {
        settle(new Error(`app reported failure: ${line.trim()}`));
        return;
      }
      const value = line.match(/addNumbers=(-?\d+)/);
      if (value) {
        seen.add(Number(value[1]));
        if (Number(value[1]) === swappedValue) {
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
  const { adb, serial } = options;
  const detected = options.pkgOverride
    ? { package: options.pkgOverride, source: 'flag/env' }
    : await detectAndroidPackage();
  const pkg = detected.package;

  // get-state 는 원격 셸이 아니라 호스트 adb 명령이다.
  const deviceState = Bun.spawnSync({
    cmd: [adb, '-s', serial, 'get-state'],
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 15_000,
  });
  if (deviceState.exitCode !== 0 || cleanShellOutput(deviceState.stdout.toString()) !== 'device') {
    fail(`adb device "${serial}" is not ready`, 'hint: adb devices 로 직렬을 확인하세요.');
  }

  if (options.skipCargo) {
    console.log('[1/5] skipping cdylib build (using existing artifacts)');
    if (!existsSync(BEHAVIOR_SO)) {
      fail(`behavior cdylib missing: ${BEHAVIOR_SO}`, 'hint: --skip-cargo 없이 다시 실행하세요.');
    }
  } else {
    console.log('[1/5] building swap-unit cdylibs (cargo ndk, arm64-v8a, release)…');
    buildCdylibs();
  }

  if (options.skipGradle) {
    console.log('[2/5] skipping gradle build (assumes the app is already installed)');
  } else {
    console.log('[2/5] building + installing the hot-core app (gradle assembleDebug)…');
    buildAndInstallApp({ adb, serial, pkg });
  }

  console.log('[3/5] checking Metro, clearing stale live artifacts, launching the app…');
  await checkMetro();
  // reverse 터널 포트는 METRO_URL 에서 읽는다 — 하드코딩하면 RUSTRA_METRO_URL
  // 로 포트를 바꾼 환경에서 checkMetro 는 통과하고 앱만 8081 로 향한다.
  const metroPort = new URL(METRO_URL).port || '8081';
  run(adb, ['-s', serial, 'reverse', `tcp:${metroPort}`, `tcp:${metroPort}`], {
    timeoutMs: 30_000,
  });
  // 시작 전 stale live 아티팩트를 치운다 — 남아 있으면 부팅 직후 스왑이 일어나
  // baseline(5) 관측이 무효화된다. sh 인용이 adbd 에 분해되는 문제를 피하려
  // 호스트에서 목록을 읽어 개별 rm 으로 지운다(셸 메타문자 0 개 계약).
  const hotDir = hotDirAbsolute(pkg);
  const listing = Bun.spawnSync({
    cmd: [adb, '-s', serial, 'shell', `run-as ${pkg} ls -a ${hotDir}`],
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  });
  const staleNames = cleanShellOutput(listing.stdout.toString())
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => name.endsWith('-hot-live.so') || name === TMP_LIVE_NAME);
  for (const name of staleNames) {
    run(adb, ['-s', serial, 'shell', `run-as ${pkg} rm -f ${hotDir}/${name}`], {
      timeoutMs: 30_000,
    });
  }

  const logcat = startLogcat(adb, serial);
  try {
    run(adb, ['-s', serial, 'shell', 'am', 'force-stop', pkg], { timeoutMs: 30_000 });
    run(adb, ['-s', serial, 'shell', 'am', 'start', '-n', `${pkg}/.MainActivity`], {
      timeoutMs: 30_000,
    });

    console.log(`[4/5] waiting for ${LOG_PREFIX} READY value=${BASELINE_VALUE}…`);
    const baseline = await waitReadyToken(logcat, options.readyTimeoutMs);
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
    // 첫 105 로그가 대기자 등록을 앞설 수 있다(실측).
    const swapObserved = waitSwapToken(logcat, SWAPPED_VALUE, options.swapTimeoutMs);
    // push 가 먼저 실패해 await 에 도달하지 못하면 이 프로미스는 나중에
    // stream-close/타임아웃으로 거부된다 — 미처리 거부로 프로세스가 죽는
    // 이중 장애를 막기 위해 no-op catch 를 미리 붙인다(실제 오류 전파는
    // await 지점에서 그대로 일어난다).
    swapObserved.catch(() => {});
    run(
      'bun',
      [
        resolve(SCRIPT_DIR, 'hot-core-push-android.mjs'),
        BEHAVIOR_SO,
        '--serial',
        serial,
        '--package',
        pkg,
      ],
      { timeoutMs: 120_000, stream: true },
    );

    const observed = await swapObserved;
    console.log(
      `RN hot-core smoke passed: addNumbers ${BASELINE_VALUE} -> ${SWAPPED_VALUE} without a JS reload (observed=${observed.join(' -> ')})`,
    );
  } finally {
    logcat.kill();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

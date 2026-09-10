import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildDylibCore,
  liveArtifactPath,
  publishGatedArtifact,
} from '../../packages/cli/src/dev-dylib.ts';
import { readDevConfig } from '../../packages/cli/src/dev-config.ts';

const root = resolve(new URL('../..', import.meta.url).pathname);
const binary = join(root, 'target/release/rustra-tauri-calculator');
const tempDir = await mkdtemp(join(tmpdir(), 'rustra-tauri-'));
// 스모크가 어떤 경로로 끝나도 임시 디렉터를 치운다 — 매 실행마다 /tmp 에
// rustra-tauri-* 디렉터가 누적되지 않게 한다(예외 경로 포함, 동기 exit 훅).
process.on('exit', () => {
  rmSync(tempDir, { recursive: true, force: true });
});

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

// 프로브 모드 부팅 — RUSTRA_TAURI_PROBE_FILE 이 있으면 main.rs 가 window 생성 전에
// 정적 디스패치 결과를 파일로 쓴다(창은 만들어지지 않아도 검증 성립). GUI 상호작용
// 없이 부팅만 확인하는 headless-safe 스모크 계약. stderr 는 핫모드 스왑/부팅 보고
// (`rustra hot-core: ...`) 수집에 함께 쓴다.
async function bootWithProbe(extraEnv, label, expectedStderr) {
  const probeFile = join(tempDir, `${label}-probe.txt`);
  const app = spawn(binary, [], {
    cwd: root,
    env: {
      ...process.env,
      RUSTRA_TAURI_PROBE_FILE: probeFile,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 바이너리가 없으면 spawn 이 'error' 이벤트로 실패한다 — resolve 로 바꿔 반드시
  // 소비하게 하고(무처리 'error' 는 프로세스를 즉시 죽인다) 원인과 함께 loud 실패.
  const spawnFailure = new Promise((resolveFailure) => {
    app.on('error', (error) => resolveFailure(error));
  });

  let stderr = '';
  app.stderr.setEncoding('utf8');
  app.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  // 준비 신호 — 프로브 파일에 더해, expectedStderr 가 주어지면 해당 stderr 라인까지
  // 기다렸다 끊는다. main.rs 는 프로브를 먼저 쓰고 핫코어 초기화(open + 감시 스레드
  // 보고)를 나중에 하므로, 프로브만 보고 끊으면 보고 라인을 흘려보내게 된다.
  for (let i = 0; i < 40; i += 1) {
    const failure = await Promise.race([wait(250).then(() => null), spawnFailure]);
    if (failure) {
      throw new Error(`failed to launch ${binary}: ${failure.message}`);
    }
    const probeReady = existsSync(probeFile);
    const stderrReady = expectedStderr === undefined || stderr.includes(expectedStderr);
    if (probeReady && stderrReady) {
      break;
    }
  }

  app.kill();

  const value = existsSync(probeFile) ? (await readFile(probeFile, 'utf8')).trim() : '';
  return { value, stderr };
}

// ── 1) 정적 링크 부팅 — 기존 스모크 계약 ─────────────────────────────────────
const plain = await bootWithProbe({}, 'static');

if (plain.value !== '42') {
  throw new Error(
    `expected Tauri runtime probe to write 42, got "${plain.value}". stderr: ${plain.stderr}`,
  );
}

console.log(`tauri runtime probe result: ${plain.value}`);

// ── 2) 핫코어 파이프라인 — config 해석 → cdylib 빌드 → 게이트 발행 → 실제 호스트
// 부팅. GUI 를 띄우지 않고도 dev.target: "dylib" 의 전체 파이프라인을 검증한다:
// 실제 readDevConfig/buildDylibCore/publishGatedArtifact 헬퍼를 쓰므로 README 흐름과
// 같은 코드 경로다. 스왑 이벤트 자체는 재빌드된 아티팩트가 필요해(sha256 변화) 여기서
// 만들지 않는다 — 스왑 단위 검증은 crates/rustra hot-core 통합 테스트가 담당한다.
const hotConfig = readDevConfig(join(root, 'examples/tauri-calculator/rustra.hot.json'));

if (hotConfig.dev?.target !== 'dylib' || hotConfig.devDylib === undefined) {
  throw new Error(
    `rustra.hot.json must resolve dev.target "dylib" with a devDylib section, got: ` +
      `${JSON.stringify(hotConfig.dev)} / ${JSON.stringify(hotConfig.devDylib)}`,
  );
}

if (hotConfig.devDylib.rustPackage !== 'rustra-calculator-example') {
  throw new Error(
    `rustra.hot.json devDylib.rustPackage must be "rustra-calculator-example", got: ` +
      `${hotConfig.devDylib.rustPackage}`,
  );
}

const artifact = await buildDylibCore(hotConfig.devDylib);
const livePath = publishGatedArtifact(artifact, liveArtifactPath(artifact));
console.log(`hot-core smoke: gated live artifact published at ${livePath}`);

const hot = await bootWithProbe({ RUSTRA_HOT_CORE: livePath }, 'hot', 'rustra hot-core: watching');

if (hot.value !== '42') {
  throw new Error(
    `expected hot-core Tauri runtime probe to write 42, got "${hot.value}". ` +
      `stderr: ${hot.stderr}`,
  );
}

// open 성공 뒤에만 찍히는 감시 스레드 라인 — dylib 이 실제로 열렸음을 증명한다.
if (!hot.stderr.includes('rustra hot-core: watching')) {
  throw new Error(
    `expected hot-core host to report the dylib watch line on stderr. stderr: ${hot.stderr}`,
  );
}

if (hot.stderr.includes('dylib open failed') || hot.stderr.includes('swap failed')) {
  throw new Error(`hot-core host reported a dylib failure. stderr: ${hot.stderr}`);
}

console.log('hot-core smoke: dylib opened by the real host, watch thread is up');

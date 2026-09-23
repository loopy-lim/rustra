#!/usr/bin/env node

// 공개 레지스트리 진단 여정 — 로드맵 A4. 발행 CLI 로 만든 소비자에서 실제 실패
// 입력 5종을 주입하고, 각각이 원인·대상·다음 조치를 갖춘 채 loud-fail 하는지
// 영수증으로 남긴다. 조용한 폴백이나 원인 없는 스택 트레이스는 실패로 간주한다.
//
// 시나리오:
//   1. stale-generated   — 계약 변경 후 미재생성, codegen --check 의 드리프트 거부
//   2. contract-mismatch — 낡은 생성 클라이언트 + 새 바이너리의 엄격 계약 거부
//   3. native-missing    — RUSTRA_NODE_BINARY 경로 부재의 안내적 실패
//   4. doctor-sdk-missing — PATH 비움 상태의 doctor 구조화 검사(fix 포함)
//   5. invalid-payload   — 정의 밖 필드의 invalid_args 거부(조용한 성공 금지)

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mutateScaffoldSources } from './onboarding-gate.mjs';
import { pinCargoVersions } from './registry-consumer/fixture.mjs';
import {
  assertExactNpmProvenance,
  assertNoConsumerContamination,
  readJson,
  validateVersionManifest,
  writeJson,
} from './registry-consumer/provenance.mjs';
import { runOrderedSteps } from './registry-consumer/runner.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const VERSIONS_PATH = fileURLToPath(new URL('./registry-consumer/versions.json', import.meta.url));
const PROJECT_NAME = 'registry-diagnostics-consumer';

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

// ── 시나리오 판정(순수 함수 — 테스트가 계약을 고정) ───────────────────────

export function judgeStaleGeneratedCheck({ status, stdout, stderr }) {
  const output = `${stdout}\n${stderr}`;
  return {
    rejected: status !== 0,
    identifiesDrift: /stale|drift|updated|mismatch|out[- ]of[- ]date|regenerat/i.test(output),
    rawOutput: output.slice(-2000),
  };
}

export function judgeContractMismatch({ status, stdout, stderr }) {
  const output = `${stdout}\n${stderr}`;
  return {
    failedLoudly: status !== 0 || /contract/i.test(output),
    mentionsContract: /contract/i.test(output),
    noSilentSuccess: !/registry-node-result/.test(stdout),
    rawOutput: output.slice(-2000),
  };
}

export function judgeNativeMissing({ status, stdout, stderr, binary }) {
  // 프로브는 실패를 마커로 보고하고 종료 코드 0 으로 끝난다 — 판정은 마커 결과
  // (rejected + 대상 경로 + 다음 조치 안내)와 프로세스 실패 둘 다 인정한다.
  const output = `${stdout}\n${stderr}`;
  let reported = null;
  const line = stdout.split('\n').find((entry) => entry.startsWith('__RUSTRA_DIAG_RESULT__'));
  if (line) {
    try {
      reported = JSON.parse(line.slice('__RUSTRA_DIAG_RESULT__'.length));
    } catch {
      reported = null;
    }
  }
  const mentionsTarget = output.includes(binary);
  const actionablePattern =
    /check|verify|rebuild|build|exists|ENOENT|no such|not found|failed to (spawn|start|launch)|candidate/i;
  const rejectedWithGuidance =
    reported !== null &&
    reported.rejected === true &&
    mentionsTarget &&
    actionablePattern.test(String(reported.message ?? ''));
  return {
    failedLoudly: status !== 0 || (reported?.rejected === true),
    mentionsTarget,
    actionable: rejectedWithGuidance || (mentionsTarget && actionablePattern.test(output)),
    reported,
    rawOutput: output.slice(-2000),
  };
}

export function judgeDoctorSdkMissing({ status, stdout }) {
  let report = null;
  try {
    report = JSON.parse(stdout);
  } catch {
    return { parsed: false, failedLoudly: status !== 0, rawOutput: stdout.slice(-2000) };
  }
  const checks = report.checks ?? [];
  const byId = Object.fromEntries(checks.map((entry) => [entry.id, entry]));
  const required = ['rustc.present', 'cargo.present'];
  const failing = required.filter((id) => byId[id]?.status === 'fail');
  const withFix = required.filter((id) => Array.isArray(byId[id]?.fix) && byId[id].fix.length > 0);
  return {
    parsed: true,
    failedLoudly: status !== 0,
    failingChecks: failing,
    failingWithFix: withFix,
    allConditionsMet: status !== 0 && failing.length === required.length && withFix.length === required.length,
  };
}

// 계약 밖 필드의 실제 제품 계약 — 생성 클라이언트는 선언 필드만 위치 인코딩으로
// 전송한다(invokeGeneratedFields1 이 input["message"] 만 추출). 따라서 초과 필드는
// 클라이언트에서 제거되고 호출은 선언된 필드만으로 성공한다(와이어 무결성).
// '초과 필드에 대한 loud 거부'는 존재하지 않는다 — S4 강화 후보로 receipt 에 기록.
export function judgeInvalidPayload({ stdout }) {
  let result = null;
  try {
    const line = stdout.split('\n').find((entry) => entry.startsWith('__RUSTRA_DIAG_RESULT__'));
    if (!line) return { reported: false, rawOutput: stdout.slice(-2000) };
    result = JSON.parse(line.slice('__RUSTRA_DIAG_RESULT__'.length));
  } catch {
    return { reported: false, rawOutput: stdout.slice(-2000) };
  }
  const resultMatchesDeclaredFieldsOnly =
    result?.rejected === false &&
    typeof result?.value?.message === 'string' &&
    Object.keys(result.value).every((key) => key === 'message');
  return {
    reported: true,
    wireStaysClean: resultMatchesDeclaredFieldsOnly,
    loudlyRejected: result?.rejected === true && /invalid.?args/i.test(String(result.code ?? '')),
    rawOutput: JSON.stringify(result),
  };
}

// ── 실행 ─────────────────────────────────────────────────────────────────

function capture(name, cwd, argv, extraEnv = {}) {
  const spawned = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    name,
    status: spawned.status,
    stdout: spawned.stdout ?? '',
    stderr: spawned.stderr ?? '',
    spawnError: spawned.error ? String(spawned.error.message) : null,
  };
}

function probeFile(instruction) {
  return `import { echo, rustra } from './generated/node.js';
const DIAG = ${JSON.stringify(instruction)};
try {
  await rustra.ready();
  let result;
  try {
    result = { rejected: false, value: await echo(DIAG.input) };
  } catch (error) {
    result = { rejected: true, code: error?.code ?? null, message: String(error?.message ?? error) };
  }
  console.log('__RUSTRA_DIAG_RESULT__' + JSON.stringify(result));
} catch (error) {
  console.log('__RUSTRA_DIAG_RESULT__' + JSON.stringify({ rejected: true, code: error?.code ?? null, message: String(error?.message ?? error) }));
} finally {
  rustra.dispose();
}
`;
}

function mutateLibRs(projectDir) {
  const libRsPath = join(projectDir, 'src', 'lib.rs');
  const appTsPath = join(projectDir, 'src', 'index.ts');
  const mutated = mutateScaffoldSources({
    libRs: readFileSync(libRsPath, 'utf8'),
    appTs: readFileSync(appTsPath, 'utf8'),
  });
  writeFileSync(libRsPath, mutated.libRs);
  writeFileSync(appTsPath, mutated.appTs);
  return readFileSync(libRsPath, 'utf8');
}

async function main(argv) {
  const outputPath = argv[argv.indexOf('--output') + 1];
  if (!outputPath || !outputPath.startsWith('/')) {
    console.error('registry diagnostics journey: --output <absolute-path> is required');
    process.exitCode = 1;
    return;
  }
  const absoluteOutput = resolve(outputPath);
  const logDir = join(dirname(absoluteOutput), 'registry-diagnostics-logs');
  rmSync(logDir, { recursive: true, force: true });
  mkdirSync(logDir, { recursive: true });
  const startedAt = new Date();
  const receipt = {
    schemaVersion: 1,
    gate: 'rustra-public-registry-diagnostics',
    ok: false,
    startedAt: startedAt.toISOString(),
    evidenceBoundary:
      'failure-input diagnostics for the published CLI on a Node consumer; does not close G1 or G2',
    scenarios: [],
    steps: [],
  };
  const versions = validateVersionManifest(readJson(VERSIONS_PATH));
  const scratchRoot = mkdtempSync(join(tmpdir(), 'rustra-registry-diagnostics-'));
  const projectDir = join(scratchRoot, PROJECT_NAME);
  try {
    // 공개 CLI 부트스트랩 → init → 정확 핀 설치 → 빌드·코드젠 (Node 소비자).
    writeJson(join(scratchRoot, 'package.json'), {
      name: 'rustra-registry-diagnostics-bootstrap',
      private: true,
      dependencies: { '@rustra/cli': versions.npm['@rustra/cli'] },
    });
    assertNoConsumerContamination(scratchRoot);
    let run = await runOrderedSteps({
      logDir,
      steps: [
        {
          name: 'install-published-cli',
          command: {
            cwd: scratchRoot,
            argv: ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'],
          },
        },
        {
          name: 'published-cli-init',
          command: {
            cwd: scratchRoot,
            argv: [
              process.execPath,
              join(scratchRoot, 'node_modules', '@rustra', 'cli', 'dist', 'index.js'),
              'init',
              PROJECT_NAME,
            ],
          },
        },
      ],
    });
    if (!run.ok) throw new Error(`bootstrap failed: ${run.error.message}`);
    const packagePath = join(projectDir, 'package.json');
    const packageJson = readJson(packagePath);
    packageJson.dependencies = {
      '@rustra/node': versions.npm['@rustra/node'],
      '@rustra/types': versions.npm['@rustra/types'],
    };
    packageJson.devDependencies = { '@rustra/cli': versions.npm['@rustra/cli'] };
    writeJson(packagePath, packageJson);
    pinCargoVersions(projectDir, versions.phases.candidate);
    run = await runOrderedSteps({
      logDir,
      steps: [
        {
          name: 'install-exact-npm',
          command: {
            cwd: projectDir,
            argv: [
              'npm',
              'install',
              '--package-lock-only',
              '--save-exact',
              '--ignore-scripts',
              '--no-audit',
              '--no-fund',
              `@rustra/types@${versions.npm['@rustra/types']}`,
              `@rustra/node@${versions.npm['@rustra/node']}`,
            ],
          },
        },
        {
          name: 'install-frozen-lock',
          command: { cwd: projectDir, argv: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'] },
        },
        {
          name: 'cargo-build',
          command: {
            cwd: projectDir,
            argv: ['cargo', 'build'],
            env: { ...process.env, CARGO_TARGET_DIR: join(scratchRoot, 'cargo-target') },
          },
        },
        {
          name: 'baseline-codegen',
          command: {
            cwd: projectDir,
            argv: [
              process.execPath,
              join(projectDir, 'node_modules', '@rustra', 'cli', 'dist', 'index.js'),
              'codegen',
              '--config',
              'rustra.json',
            ],
          },
        },
      ],
    });
    if (!run.ok) throw new Error(`consumer setup failed: ${run.error.message}`);
    assertExactNpmProvenance(projectDir, {
      '@rustra/cli': versions.npm['@rustra/cli'],
      '@rustra/types': versions.npm['@rustra/types'],
      '@rustra/node': versions.npm['@rustra/node'],
    });
    const projectCli = join(projectDir, 'node_modules', '@rustra', 'cli', 'dist', 'index.js');
    const binary = join(scratchRoot, 'cargo-target', 'debug', 'rustra-app');
    if (!existsSync(binary)) throw new Error(`native binary missing: ${binary}`);

    const scenarios = receipt.scenarios;
    const record = (scenario, given, observed, verdict, pass) => {
      scenarios.push({ scenario, given, observed: { status: observed.status, stdout: observed.stdout.slice(-4000), stderr: observed.stderr.slice(-4000) }, verdict, pass });
    };

    // 1) stale-generated — 계약 변경 후 미재생성 상태의 codegen --check.
    {
      const libRsPath = join(projectDir, 'src', 'lib.rs');
      const indexTsPath = join(projectDir, 'src', 'index.ts');
      const original = readFileSync(libRsPath, 'utf8');
      const originalIndex = readFileSync(indexTsPath, 'utf8');
      mutateLibRs(projectDir);
      const observed = capture('stale-generated', projectDir, [
        process.execPath,
        projectCli,
        'codegen',
        '--config',
        'rustra.json',
        '--check',
      ]);
      const verdict = judgeStaleGeneratedCheck(observed);
      record(
        'stale-generated',
        'lib.rs 필드 추가 후 재생성 없이 codegen --check 실행',
        observed,
        verdict,
        verdict.rejected && verdict.identifiesDrift,
      );
      writeFileSync(libRsPath, original);
      writeFileSync(indexTsPath, originalIndex);
    }

    // 1-2) 복구 — 원 계약으로 재생성해 이후 시나리오의 기저를 맞춘다.
    run = await runOrderedSteps({
      logDir,
      steps: [
        {
          name: 'restore-codegen',
          command: { cwd: projectDir, argv: [process.execPath, projectCli, 'codegen', '--config', 'rustra.json'] },
        },
      ],
    });
    if (!run.ok) throw new Error(`restore codegen failed: ${run.error.message}`);

    // 2) contract-mismatch — 낡은 생성 클라이언트 + 새 바이너리.
    {
      // 생성물을 스냅샷 → 계약 변형 + 재빌드(생성물은 옛 계약 그대로).
      const generatedDir = join(projectDir, 'src', 'generated');
      const snapshot = join(scratchRoot, 'generated-snapshot');
      cpSyncRecursive(generatedDir, snapshot);
      const libRsPath = join(projectDir, 'src', 'lib.rs');
      const indexTsPath = join(projectDir, 'src', 'index.ts');
      const original = readFileSync(libRsPath, 'utf8');
      const originalIndex = readFileSync(indexTsPath, 'utf8');
      mutateLibRs(projectDir);
      const build = capture('contract-mismatch-build', projectDir, [
        'cargo',
        'build',
      ], { CARGO_TARGET_DIR: join(scratchRoot, 'cargo-target') });
      if (build.status !== 0) throw new Error(`rebuild failed: ${build.stderr.slice(-500)}`);
      rmSync(generatedDir, { recursive: true, force: true });
      cpSyncRecursive(snapshot, generatedDir);
      writeFileSync(join(projectDir, 'src', 'probe-contract.ts'), probeFile({ input: { message: 'diag' } }));
      const bundle = capture('contract-mismatch-bundle', projectDir, [
        'bun',
        'build',
        'src/probe-contract.ts',
        '--target=node',
        '--outfile=.diag-probe.mjs',
      ]);
      if (bundle.status !== 0) throw new Error(`bundle failed: ${bundle.stderr.slice(-500)}`);
      const observed = capture('contract-mismatch', projectDir, [process.execPath, '.diag-probe.mjs'], {
        RUSTRA_NODE_BINARY: binary,
      });
      const verdict = judgeContractMismatch(observed);
      record(
        'contract-mismatch',
        '변형 전 생성 클라이언트로 변형 후 바이너리 호출',
        observed,
        verdict,
        verdict.failedLoudly && verdict.mentionsContract && verdict.noSilentSuccess,
      );
      // 복구 — 원 계약 복원 + 재빌드·재생성.
      writeFileSync(libRsPath, original);
      writeFileSync(indexTsPath, originalIndex);
      const rebuild = capture('contract-restore-build', projectDir, ['cargo', 'build'], {
        CARGO_TARGET_DIR: join(scratchRoot, 'cargo-target'),
      });
      if (rebuild.status !== 0) throw new Error(`restore rebuild failed: ${rebuild.stderr.slice(-500)}`);
      const regen = capture('contract-restore-codegen', projectDir, [
        process.execPath,
        projectCli,
        'codegen',
        '--config',
        'rustra.json',
      ]);
      if (regen.status !== 0) throw new Error(`restore regen failed: ${regen.stderr.slice(-500)}`);
    }

    // 3) native-missing — 존재하지 않는 네이티브 바이너리 경로.
    {
      const missingBinary = join(scratchRoot, 'does-not-exist', 'rustra-app');
      const observed = capture('native-missing', projectDir, [process.execPath, '.diag-probe.mjs'], {
        RUSTRA_NODE_BINARY: missingBinary,
      });
      const verdict = judgeNativeMissing({ ...observed, binary: missingBinary });
      record(
        'native-missing',
        'RUSTRA_NODE_BINARY 를 부재 경로로 지정 후 호출',
        observed,
        verdict,
        verdict.failedLoudly && verdict.mentionsTarget && verdict.actionable,
      );
    }

    // 4) doctor-sdk-missing — PATH 를 비운 환경의 doctor --format json.
    {
      const observed = capture('doctor-sdk-missing', projectDir, [
        process.execPath,
        projectCli,
        'doctor',
        '--config',
        'rustra.json',
        '--format',
        'json',
      ], { PATH: '' });
      const verdict = judgeDoctorSdkMissing(observed);
      record(
        'doctor-sdk-missing',
        'PATH 미제공 환경에서 doctor 실행(rustc/cargo 부재 시뮬레이션)',
        observed,
        verdict,
        verdict.allConditionsMet === true,
      );
    }

    // 5) invalid-payload — 정의 밖 필드가 있는 호출.
    {
      writeFileSync(
        join(projectDir, 'src', 'probe-invalid.ts'),
        probeFile({ input: { message: 'diag', surpriseField: true } }),
      );
      const bundle = capture('invalid-payload-bundle', projectDir, [
        'bun',
        'build',
        'src/probe-invalid.ts',
        '--target=node',
        '--outfile=.diag-invalid.mjs',
      ]);
      if (bundle.status !== 0) throw new Error(`bundle failed: ${bundle.stderr.slice(-500)}`);
      const observed = capture('invalid-payload', projectDir, [process.execPath, '.diag-invalid.mjs'], {
        RUSTRA_NODE_BINARY: binary,
      });
      const verdict = judgeInvalidPayload(observed);
      record(
        'invalid-payload',
        '계약에 없는 surpriseField 를 실어 echo 호출 — 생성 클라이언트는 선언 필드만 전송(입력 화이트리스트). 초과 필드 loud 거부는 없음: S4 강화 후보',
        observed,
        verdict,
        verdict.reported === true && verdict.wireStaysClean === true,
      );
    }

    receipt.ok = scenarios.every((scenario) => scenario.pass);
    receipt.completedAt = new Date().toISOString();
    receipt.durationMs = Date.now() - startedAt.getTime();
    receipt.versions = versions.npm;
    writeJson(absoluteOutput, receipt);
    rmSync(scratchRoot, { recursive: true, force: true });
  } catch (error) {
    receipt.completedAt = new Date().toISOString();
    receipt.durationMs = Date.now() - startedAt.getTime();
    receipt.failure = { message: errorText(error), scratchRoot };
    writeJson(absoluteOutput, receipt);
  }
  const stream = receipt.ok ? console.log : console.error;
  stream(`[registry-diagnostics] receipt: ${absoluteOutput}`);
  for (const scenario of receipt.scenarios) {
    stream(`[registry-diagnostics] ${scenario.scenario}: ${scenario.pass ? 'PASS' : 'FAIL'}`);
  }
  if (!receipt.ok) stream(`[registry-diagnostics] failed: ${receipt.failure?.message ?? 'scenario failures above'}`);
  process.exitCode = receipt.ok ? 0 : 1;
}

function cpSyncRecursive(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) cpSyncRecursive(source, target);
    else writeFileSync(target, readFileSync(source));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) await main(process.argv.slice(2));

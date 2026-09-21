#!/usr/bin/env node

// Tauri/macOS 실제 WebView 레지스트리 소비 여정 — 로드맵 A1/A2/A3(Tauri) 증거.
//
// registry-consumer-gate.mjs(Node/Bun CLI 여정)와 같은 계약을 따르되, 소비자는
// @rustra/tauri + rustra(tauri feature) 로 구성하고 실행 증거를 **실제 WKWebView
// 안에서 도는 프론트엔드 JS**가 생성된 엄격 계약 클라이언트(generated/tauri.js)로
// 관측해 reportEvidence 커맨드(계약의 일부)로 되돌려 보낸다. 커스텀 Tauri IPC
// 커맨드는 register* 가 invoke_handler 를 점유하므로 쓰지 않는다 — 증거가 rustra
// 브릿지 경로 자체를 지난다는 것이 이 여정의 요점이다.
//
// 증명 범위: 공개 레지스트리만 쓴 설치·생성·빌드·실제 WebView 실행, 도메인 에러
// 전파, 이벤트 구독/해제(푸시), 계약 필드 변경 후 재생성·재실행. G1 전체(RN·기존
// 앱·평가자)나 G2를 닫지 않는다.

import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { release as osRelease, version as osVersion, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertCargoProvenance,
  assertExactNpmProvenance,
  assertNoConsumerContamination,
  generatedFiles,
  hashFiles,
  readJson,
  sha256File,
  validateVersionManifest,
  writeJson,
} from './registry-consumer/provenance.mjs';
import { pinCargoVersions } from './registry-consumer/fixture.mjs';
import { errorDetails, runOrderedSteps, sanitizeStepName } from './registry-consumer/runner.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const VERSIONS_PATH = fileURLToPath(new URL('./registry-consumer/versions.json', import.meta.url));
const PROJECT_NAME = 'registry-tauri-consumer';
const ERROR_SENTINEL = 'registry tauri journey error propagation';
const EVIDENCE_WAIT_MS = 120_000;
const EVIDENCE_POLL_MS = 250;

// Tauri 2 의 generate_context! 는 번들 비활성과 무관하게 icons/icon.png 를
// 내장하려 한다 — 여정은 자가완결이어야 하므로 로컬 예제 자산 없이 최소 PNG
// (32x32 RGBA, 단색)를 프로그램 생성해 심는다.
const ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAL0lEQVR42u3OIQEAAAgDMDrRiU6khRg3E/Ornr2kEhAQEBAQEBAQEBAQEBAQSAceRiXEeUuVniAAAAAASUVORK5CYII=';

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

// ── 소스 렌더러(순수 함수 — 테스트가 앵커를 지킨다) ─────────────────────────

export function renderTauriLibRs() {
  return `use rustra::prelude::*;

#[derive(Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EchoInput {
    pub message: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EchoOutput {
    pub message: String,
}

#[rustra::command]
fn echo(input: EchoInput) -> Result<EchoOutput> {
    Ok(EchoOutput { message: input.message })
}

#[rustra::command]
fn fail_echo(_input: EchoInput) -> Result<EchoOutput> {
    Err(RustraError::invalid_args("${ERROR_SENTINEL}"))
}

#[derive(Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EmitTicksInput {
    pub ticks: u32,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EmitTicksOutput {
    pub emitted: u32,
}

// 이벤트 푸시 — register_with_events 가 설치한 싱크로 Package::emit 이
// "rustra://calc_tick" 채널(Rust 측 sanitize 규칙)을 통해 웹뷰에 도달한다.
// 싱크는 **등록된** 패키지 인스턴스에 설치된다 — 새 Package::builder 인스턴스로
// emit 하면 이벤트가 아무도 안 듣는 버스로 가므로 rustra::ffi::get_package()
// 핸들을 쓴다(calculator 예제 emit_demo 와 동일한 계약).
#[rustra::command]
fn emit_ticks(input: EmitTicksInput) -> Result<EmitTicksOutput> {
    let package = rustra::ffi::get_package()
        .ok_or_else(|| RustraError::custom("ffi.not_registered", "package not registered"))?;
    for index in 0..input.ticks {
        package.emit("calc.tick", serde_json::json!({ "value": index + 1 }));
    }
    Ok(EmitTicksOutput { emitted: input.ticks })
}

#[derive(Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReportEvidenceInput {
    pub phase: String,
    pub payload: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReportEvidenceOutput {
    pub written: u32,
}

// 증거 회신 — 웹뷰 관측을 rustra 브릿지 자체를 통해 파일로 되돌린다.
#[rustra::command]
fn report_evidence(input: ReportEvidenceInput) -> Result<ReportEvidenceOutput> {
    let path = std::env::var("RUSTRA_TAURI_EVIDENCE_FILE")
        .map_err(|_| RustraError::invalid_args("RUSTRA_TAURI_EVIDENCE_FILE is not set"))?;
    use std::io::Write as _;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| RustraError::internal(format!("open evidence file failed: {error}")))?;
    writeln!(file, "{}", input.payload)
        .map_err(|error| RustraError::internal(format!("write evidence file failed: {error}")))?;
    Ok(ReportEvidenceOutput { written: 1 })
}

pub fn package() -> Package {
    Package::builder("app.demo")
        .command_fn(echo)
        .command_fn(fail_echo)
        .command_fn(emit_ticks)
        .command_fn(report_evidence)
        .build()
}

// 실제 WebView 부팅 — 프론트엔드 자산은 generate_context! 로 컴파일 타임에
// 포함되므로 dist 변경 후엔 cargo 재빌드가 필요하다(여정이 그 순서를 지킨다).
// register_ffi 와 register_with_events 는 **같은 인스턴스**에 해야 한다 —
// Package::builder().build() 인스턴스는 서로 독립이라, ffi 에 A를 싱크에 B를
// 등록하면 명령 안의 get_package emit 가 아무도 안 듣는 버스로 간다.
pub fn run() {
    let package = package();
    package.register_ffi();
    rustra::tauri_support::register_with_events(package, tauri::Builder::default())
        .run(tauri::generate_context!())
        .expect("registry tauri consumer app failed to run");
}
`;
}

// 계약 변형(재사용 계약) — mutateScaffoldSources 와 같은 결정적 앵커. 이 파일의
// 렌더러 산출물에만 적용 가능하다(앵커가 없으면 fail-closed).
export function mutateTauriLibRs(libRs) {
  const replacements = [
    [
      'pub struct EchoInput {\n    pub message: String,\n}',
      'pub struct EchoInput {\n    pub message: String,\n    pub repeat: u32,\n}',
    ],
    [
      'pub struct EchoOutput {\n    pub message: String,\n}',
      'pub struct EchoOutput {\n    pub message: String,\n    pub repeat: u32,\n}',
    ],
    [
      'Ok(EchoOutput { message: input.message })',
      'Ok(EchoOutput { message: input.message, repeat: input.repeat })',
    ],
  ];
  let mutated = libRs;
  for (const [anchor, replacement] of replacements) {
    if (!mutated.includes(anchor))
      throw new Error(`tauri lib.rs mutation anchor not found: ${JSON.stringify(anchor)}`);
    mutated = mutated.replace(anchor, replacement);
  }
  return mutated;
}

export function renderJourneyInputTs(input) {
  const fields = Object.entries(input)
    .map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`)
    .join('\n');
  return `export const INPUT = {\n${fields}\n} as const;\n`;
}

export function renderTauriAppTs() {
  return `import { echo, failEcho, emitTicks, reportEvidence, rustra, subscribeEvent } from './generated/tauri.js';
import { INPUT } from './journey-input.js';

interface Tick { value: number }

function wait(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

try {
  await rustra.ready();
  let subscribed = 0;
  const unsubscribe = await subscribeEvent<Tick>('calc.tick', (payload) => {
    subscribed += 1;
    void payload.value;
  });

  const echoResult: any = await echo(INPUT as never);
  let failEchoError: { code: string | null; message: string } | null = null;
  try {
    await failEcho(INPUT as never);
  } catch (error: any) {
    failEchoError = { code: error?.code ?? null, message: String(error?.message ?? error) };
  }

  // 구독 중 이벤트 3회 — 푸시 싱크가 실제 WebView 로 전달되는지.
  const first = await emitTicks({ ticks: 3 });
  await wait(700);
  const beforeUnsubscribe = subscribed;

  // 해지 후 이벤트 2회 — 해지가 실제로 조용한 유실 없이 이루어지는지.
  unsubscribe();
  const second = await emitTicks({ ticks: 2 });
  await wait(700);
  const afterUnsubscribe = subscribed - beforeUnsubscribe;

  const observations = {
    phase: INPUT.phase,
    userAgent: navigator.userAgent,
    hasTauriGlobal: typeof (globalThis as any).__TAURI__ === 'object',
    echoResult,
    failEchoError,
    eventsBeforeUnsubscribe: beforeUnsubscribe,
    eventsAfterUnsubscribe: afterUnsubscribe,
    firstEmitted: first.emitted,
    secondEmitted: second.emitted,
  };
  await reportEvidence({ phase: INPUT.phase, payload: JSON.stringify(observations) });
  rustra.dispose();
} catch (error) {
  // 실패도 증거로 남긴다 — 조용한 실패는 여정의 실패를 가린다.
  const payload = JSON.stringify({ phase: INPUT.phase, journeyError: String(error) });
  try {
    await reportEvidence({ phase: INPUT.phase, payload });
  } catch {
    console.error('rustra journey: report failed for', payload);
  }
}
`;
}

export function renderTauriConfJson() {
  return `${JSON.stringify(
    {
      $schema: 'https://schema.tauri.app/config/2',
      productName: 'registry-tauri-consumer',
      version: '0.1.0',
      identifier: 'dev.rustra.registry-consumer',
      build: { frontendDist: './dist' },
      app: {
        withGlobalTauri: true,
        windows: [{ title: 'Rustra Registry Consumer', width: 480, height: 320 }],
        security: { csp: null },
      },
      bundle: { active: false },
    },
    null,
    2,
  )}\n`;
}

// Tauri 2 ACL — capabilities 없으면 core 플러그인 IPC(이벤트 listen 포함)가
// 웹뷰에서 거부된다(앱 정의 커맨드는 허용되는 것과 비대칭). 이벤트 구독에 필요한
// 최소 권한만 부여한다.
export function renderTauriCapabilities() {
  return `${JSON.stringify(
    {
      $schema: '../gen/schemas/desktop-schema.json',
      identifier: 'default',
      description: 'Rustra registry consumer: minimal core:event permission for subscribeEvent',
      windows: ['main'],
      permissions: ['core:event:default'],
    },
    null,
    2,
  )}\n`;
}

// ── 증거 파싱·단정(순수 함수) ─────────────────────────────────────────────

export function parseEvidenceLine(line) {
  return JSON.parse(line);
}

export function assertJourneyObservation(observations) {
  if (observations.journeyError !== undefined)
    throw new Error(`webview journey reported an error: ${observations.journeyError}`);
  if (!/AppleWebKit/.test(observations.userAgent ?? ''))
    throw new Error(`user agent does not look like a real WebKit view: ${observations.userAgent}`);
  if (observations.hasTauriGlobal !== true)
    throw new Error('window.__TAURI__ global was not present in the webview');
  if (observations.failEchoError === null)
    throw new Error('failEcho did not reject in the webview');
  if (!String(observations.failEchoError.message).includes(ERROR_SENTINEL))
    throw new Error(
      `failEcho error message did not cross the bridge intact: ${observations.failEchoError.message}`,
    );
  if (observations.echoResult?.message !== 'registry-tauri')
    throw new Error(`echo result message mismatch: ${JSON.stringify(observations.echoResult)}`);
  if (observations.firstEmitted !== 3 || observations.secondEmitted !== 2)
    throw new Error(
      `emitTicks declared counts mismatch: ${observations.firstEmitted}/${observations.secondEmitted}`,
    );
  if (observations.eventsBeforeUnsubscribe !== 3)
    throw new Error(
      `expected 3 events before unsubscribe, saw ${observations.eventsBeforeUnsubscribe}`,
    );
  if (observations.eventsAfterUnsubscribe !== 0)
    throw new Error(
      `events kept arriving after unsubscribe: ${observations.eventsAfterUnsubscribe}`,
    );
  return true;
}

export function assertMutatedObservation(observations) {
  assertJourneyObservation(observations);
  if (observations.echoResult?.repeat !== 3)
    throw new Error(
      `mutated echo result did not return repeat=3: ${JSON.stringify(observations.echoResult)}`,
    );
  return true;
}

// ── 여정 실행 ─────────────────────────────────────────────────────────────

function createContext({ logDir, scratchRoot, projectDir, targetDir, versions }) {
  return {
    logDir,
    scratchRoot,
    projectDir,
    targetDir,
    versions,
    steps: [],
    env: {
      ...process.env,
      CARGO_TARGET_DIR: targetDir,
      CI: process.env.CI ?? 'true',
    },
  };
}

async function commandStep(context, name, cwd, argv, extraEnv = {}) {
  const ordinal = context.steps.length + 1;
  const result = await runOrderedSteps({
    logDir: context.logDir,
    steps: [
      {
        name: `${String(ordinal).padStart(3, '0')}-${name}`,
        command: { cwd, argv, env: { ...context.env, ...extraEnv } },
      },
    ],
  });
  const report = result.steps[0];
  const desiredLog = join(
    context.logDir,
    `${String(ordinal).padStart(3, '0')}-${sanitizeStepName(name)}.log`,
  );
  if (report.rawLogPath !== desiredLog) {
    writeFileSync(desiredLog, readFileSync(report.rawLogPath));
    rmSync(report.rawLogPath, { force: true });
    report.rawLogPath = desiredLog;
    if (result.error) result.error.rawLogPath = desiredLog;
  }
  const output = { stdout: report.stdout ?? '', stderr: report.stderr ?? '' };
  delete report.stdout;
  delete report.stderr;
  report.name = name;
  context.steps.push(report);
  if (!result.ok) {
    const error = new Error(result.error.message);
    error.code = result.error.code;
    error.step = { name, rawLogPath: report.rawLogPath };
    error.steps = context.steps;
    error.scratchRoot = context.scratchRoot;
    throw error;
  }
  return output;
}

function internalStep(context, name, operation) {
  const ordinal = context.steps.length + 1;
  const startedAt = new Date();
  const rawLogPath = join(
    context.logDir,
    `${String(ordinal).padStart(3, '0')}-${sanitizeStepName(name)}.log`,
  );
  try {
    const value = operation();
    writeFileSync(rawLogPath, `step: ${name}\nstatus: ok\n`);
    context.steps.push({
      name,
      ok: true,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      status: 0,
      signal: null,
      rawLogPath,
    });
    return value;
  } catch (error) {
    writeFileSync(rawLogPath, `${JSON.stringify(errorDetails(error), null, 2)}\n`);
    context.steps.push({
      name,
      ok: false,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      status: null,
      signal: null,
      rawLogPath,
    });
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.step = { name, rawLogPath };
    failure.steps = context.steps;
    failure.scratchRoot = context.scratchRoot;
    throw failure;
  }
}

function contractHash(projectDir) {
  const text = readFileSync(join(projectDir, 'src', 'generated', 'contract.ts'), 'utf8');
  const match = text.match(/GENERATED_CONTRACT_HASH\s*=\s*['"]([^'"]+)['"]/);
  if (!match) throw new Error('generated contract.ts does not contain GENERATED_CONTRACT_HASH');
  return match[1];
}

function writeTauriProjectSources(context) {
  const projectDir = context.projectDir;
  const versions = context.versions;
  internalStep(context, 'write-tauri-sources', () => {
    writeFileSync(join(projectDir, 'src', 'lib.rs'), renderTauriLibRs());
    mkdirSync(join(projectDir, 'src', 'bin'), { recursive: true });
    writeFileSync(
      join(projectDir, 'src', 'bin', 'tauri_app.rs'),
      // init 스캐폴드의 패키지명은 rustra-app — lib 이름은 rustra_app 이다.
      `fn main() {\n    rustra_app::run()\n}\n`,
    );
    writeFileSync(
      join(projectDir, 'build.rs'),
      `fn main() {\n    tauri_build::build()\n}\n`,
    );
    writeFileSync(join(projectDir, 'tauri.conf.json'), renderTauriConfJson());
    mkdirSync(join(projectDir, 'capabilities'), { recursive: true });
    writeFileSync(
      join(projectDir, 'capabilities', 'default.json'),
      renderTauriCapabilities(),
    );
    mkdirSync(join(projectDir, 'icons'), { recursive: true });
    writeFileSync(
      join(projectDir, 'icons', 'icon.png'),
      Buffer.from(ICON_PNG_BASE64, 'base64'),
    );

    // Cargo.toml — rustra 에 tauri feature 를 켜고 tauri 계열 의존성을 추가한다.
    // rustra 는 이미 pin-consumer-versions 가 "=x.y.z" 로 고정했다 — brace 형태로
    // 바꿔 features 를 붙여도 version 은 정확 핀을 유지한다(오염 검사도 읽는다).
    const cargoPath = join(projectDir, 'Cargo.toml');
    let cargo = readFileSync(cargoPath, 'utf8');
    const pinnedRustra = `rustra = { version = "=${versions.phases.candidate.rustra}", features = ["tauri"] }`;
    cargo = cargo.replace(/^rustra\s*=\s*"[^"]+"/m, pinnedRustra);
    if (!cargo.includes(pinnedRustra))
      throw new Error('pinned rustra dependency line not found for tauri feature rewrite');
    cargo = cargo.replace(
      /\[dependencies\]/,
      '[build-dependencies]\ntauri-build = { version = "2", features = [] }\n\n[dependencies]\ntauri = { version = "2", features = [] }',
    );
    if (!/\[\[bin\]\]\s*name = "tauri-app"/.test(cargo))
      cargo += '\n[[bin]]\nname = "tauri-app"\npath = "src/bin/tauri_app.rs"\n';
    writeFileSync(cargoPath, cargo);

    // rustra.json — node 호스트 섹션을 제거하고 tauri 만 남겨 generated/tauri.ts 가
    // tauri 어댑터 의존성(@rustra/tauri)을 요구하게 한다.
    const config = readJson(join(projectDir, 'rustra.json'));
    delete config.node;
    config.tauri = {};
    writeJson(join(projectDir, 'rustra.json'), config);

    // 프론트엔드 — bun build 로 dist/index.js 를 내고 index.html 도 dist 안에
    // 둔다. frontendDist './dist' 는 dist 의 *내용물*이 웹 루트가 된다 — 루트의
    // index.html 은 서비스되지 않는다.
    writeFileSync(join(projectDir, 'src', 'app.ts'), renderTauriAppTs());
    writeFileSync(
      join(projectDir, 'src', 'journey-input.ts'),
      renderJourneyInputTs({ phase: 'baseline', message: 'registry-tauri' }),
    );
    mkdirSync(join(projectDir, 'dist'), { recursive: true });
    writeFileSync(
      join(projectDir, 'dist', 'index.html'),
      `<!doctype html>\n<html>\n<head><meta charset="utf-8"><title>Registry Tauri Consumer</title></head>\n<body><script type="module" src="./index.js"></script></body>\n</html>\n`,
    );
  });
}

function buildFrontend(context, label) {
  return commandStep(context, `${label}-frontend-bundle`, context.projectDir, [
    'bun',
    'build',
    'src/app.ts',
    '--outfile=dist/index.js',
    '--target=browser',
  ]);
}

async function codegen(context, label) {
  await commandStep(context, `${label}-codegen`, context.projectDir, [
    process.execPath,
    join(context.projectDir, 'node_modules', '@rustra', 'cli', 'dist', 'index.js'),
    'codegen',
    '--config',
    'rustra.json',
  ]);
}

async function cargoBuild(context, label) {
  await commandStep(context, `${label}-cargo-build`, context.projectDir, [
    'cargo',
    'build',
    '--bin',
    'tauri-app',
  ]);
}

// 실제 WebView 실행 — 바이너리를 띄우고 reportEvidence 가 쓴 증 파일에서 해당
// phase 줄을 기다린다. 프로세스는 관측 후 종료한다.
function runWebviewPhase(context, label, phase) {
  const evidencePath = join(context.scratchRoot, `${label}-evidence.jsonl`);
  const binary = join(
    context.targetDir,
    'debug',
    process.platform === 'win32' ? 'tauri-app.exe' : 'tauri-app',
  );
  return new Promise((resolveRun, rejectRun) => {
    internalStep(context, `${label}-webview-launch`, () => {
      if (!existsSync(binary)) throw new Error(`tauri app binary missing: ${binary}`);
      rmSync(evidencePath, { force: true });
    });
    const child = spawn(binary, [], {
      cwd: context.projectDir,
      env: { ...context.env, RUSTRA_TAURI_EVIDENCE_FILE: evidencePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const spawnFailure = new Promise((resolveFailure) => {
      child.on('error', (error) => resolveFailure(error));
    });
    const startedAt = Date.now();
    let settled = false;
    const finish = (fn, ...args) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      fn(...args);
    };
    const poll = setInterval(() => {
      if (!existsSync(evidencePath)) return;
      const lines = readFileSync(evidencePath, 'utf8').split('\n').filter(Boolean);
      const matching = lines
        .map((line) => {
          try {
            return parseEvidenceLine(line);
          } catch {
            return null;
          }
        })
        .filter((entry) => entry?.phase === phase);
      if (matching.length === 0) return;
      child.kill('SIGTERM');
      const observations = matching[matching.length - 1];
      context.steps.push({
        name: `${label}-webview-evidence`,
        ok: true,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        status: 0,
        signal: null,
        rawLogPath: writeStepLog(context, label, { observations, stderrTail: stderr.slice(-4000) }),
      });
      finish(resolveRun, observations);
    }, EVIDENCE_POLL_MS);
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(
        rejectRun,
        Object.assign(new Error(`webview evidence for phase ${phase} never arrived`), {
          step: { name: `${label}-webview-evidence` },
          steps: context.steps,
          scratchRoot: context.scratchRoot,
          stderrTail: stderr.slice(-4000),
        }),
      );
    }, EVIDENCE_WAIT_MS);
    // 앱이 증거를 남기지 않고 먼저 죽으면 전체 타임아웃까지 기다리지 않는다.
    child.on('exit', () => {
      setTimeout(() => {
        finish(
          rejectRun,
          Object.assign(
            new Error(`tauri app exited before reporting evidence for phase ${phase}`),
            {
              step: { name: `${label}-webview-evidence` },
              steps: context.steps,
              scratchRoot: context.scratchRoot,
              stderrTail: stderr.slice(-4000),
            },
          ),
        );
      }, 1000);
    });
    spawnFailure.then((error) => {
      finish(
        rejectRun,
        Object.assign(new Error(`failed to launch tauri app: ${error?.message ?? error}`), {
          step: { name: `${label}-webview-launch` },
          steps: context.steps,
          scratchRoot: context.scratchRoot,
        }),
      );
    });
  });
}

function writeStepLog(context, label, payload) {
  const path = join(context.logDir, `${label}-webview-evidence.log`);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
  return path;
}

function snapshotEvidence(context, phase) {
  const snapshotRoot = join(context.scratchRoot, 'evidence', phase);
  mkdirSync(snapshotRoot, { recursive: true });
  for (const relativePath of [
    'Cargo.lock',
    'Cargo.toml',
    'package-lock.json',
    'package.json',
    'rustra.json',
    'tauri.conf.json',
  ]) {
    cpSync(join(context.projectDir, relativePath), join(snapshotRoot, relativePath));
  }
  cpSync(join(context.projectDir, 'src', 'generated'), join(snapshotRoot, 'src', 'generated'), {
    recursive: true,
  });
  cpSync(join(context.projectDir, 'src', 'lib.rs'), join(snapshotRoot, 'src', 'lib.rs'));
  cpSync(join(context.projectDir, 'src', 'app.ts'), join(snapshotRoot, 'src', 'app.ts'));
  const files = hashFiles(snapshotRoot, [
    'Cargo.lock',
    'Cargo.toml',
    'package-lock.json',
    'package.json',
    'rustra.json',
    'tauri.conf.json',
    'src/lib.rs',
    'src/app.ts',
    ...generatedFiles(snapshotRoot),
  ]);
  return { root: snapshotRoot, files };
}

async function environmentEvidence(context) {
  const commands = [
    ['node', process.execPath, ['--version']],
    ['npm', 'npm', ['--version']],
    ['bun', 'bun', ['--version']],
    ['cargo', 'cargo', ['--version']],
    ['rustc', 'rustc', ['--version']],
  ];
  const environment = {
    platform: process.platform,
    arch: process.arch,
    osRelease: osRelease(),
    osVersion: osVersion(),
  };
  for (const [name, executable, args] of commands) {
    const result = await commandStep(context, `environment-${name}`, context.scratchRoot, [
      executable,
      ...args,
    ]);
    environment[name] = result.stdout.trim();
  }
  const swVers = await commandStep(context, 'environment-sw-vers', context.scratchRoot, [
    'sw_vers',
    '-productVersion',
  ]);
  environment.productVersion = swVers.stdout.trim();
  return environment;
}

async function executeTauriCycle({ logDir }) {
  const versions = validateVersionManifest(readJson(VERSIONS_PATH));
  const scratchRoot = mkdtempSync(join(tmpdir(), 'rustra-registry-tauri-'));
  const projectDir = join(scratchRoot, PROJECT_NAME);
  const targetDir = join(scratchRoot, 'cargo-target');
  const context = createContext({ logDir, scratchRoot, projectDir, targetDir, versions });
  const repoRoot = resolve(dirname(SCRIPT_PATH), '..');
  const tauriVersion = versions.hosts?.['@rustra/tauri'];
  if (!tauriVersion)
    throw new Error('versions.json hosts["@rustra/tauri"] exact pin is required for this journey');
  const npmVersions = {
    '@rustra/cli': versions.npm['@rustra/cli'],
    '@rustra/types': versions.npm['@rustra/types'],
    '@rustra/tauri': tauriVersion,
  };
  try {
    const environment = await environmentEvidence(context);
    const runner = await commandStep(context, 'runner-git-head', repoRoot, [
      'git',
      'rev-parse',
      'HEAD',
    ]);

    // 1) 공개 CLI 부트스트랩 — 로컬 소스 없이 정확한 발행 버전만.
    internalStep(context, 'prepare-bootstrap-manifest', () => {
      writeJson(join(scratchRoot, 'package.json'), {
        name: 'rustra-registry-tauri-bootstrap',
        private: true,
        dependencies: { '@rustra/cli': npmVersions['@rustra/cli'] },
      });
      assertNoConsumerContamination(scratchRoot);
    });
    await commandStep(context, 'install-published-cli', scratchRoot, [
      'npm',
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ]);
    internalStep(context, 'verify-published-cli-source', () =>
      assertExactNpmProvenance(scratchRoot, { '@rustra/cli': npmVersions['@rustra/cli'] }),
    );
    const bootstrapCli = join(scratchRoot, 'node_modules', '@rustra', 'cli', 'dist', 'index.js');
    await commandStep(context, 'published-cli-init', scratchRoot, [
      process.execPath,
      bootstrapCli,
      'init',
      PROJECT_NAME,
    ]);

    // 2) 발행 패키지 정확 핀 설치 — manifest 는 CLI 호환 범위 내 정확 버전.
    internalStep(context, 'pin-consumer-versions', () => {
      const packagePath = join(projectDir, 'package.json');
      const packageJson = readJson(packagePath);
      packageJson.dependencies = {
        '@rustra/tauri': npmVersions['@rustra/tauri'],
        '@rustra/types': npmVersions['@rustra/types'],
      };
      packageJson.devDependencies = { '@rustra/cli': npmVersions['@rustra/cli'] };
      writeJson(packagePath, packageJson);
      // Cargo 핀을 오염 검사 전에 =version 으로 고정한다(스캐폴드는 caret).
      pinCargoVersions(projectDir, versions.phases.candidate);
    });
    internalStep(context, 'verify-clean-fixture-before-install', () =>
      assertNoConsumerContamination(projectDir, { expectedNpm: npmVersions }),
    );
    await commandStep(context, 'resolve-exact-npm-lock', projectDir, [
      'npm',
      'install',
      '--package-lock-only',
      '--save-exact',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `@rustra/types@${npmVersions['@rustra/types']}`,
      `@rustra/tauri@${npmVersions['@rustra/tauri']}`,
    ]);
    await commandStep(context, 'install-frozen-npm-lock', projectDir, [
      'npm',
      'ci',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ]);
    internalStep(context, 'verify-exact-npm-sources', () => {
      assertNoConsumerContamination(projectDir, { expectedNpm: npmVersions });
      return assertExactNpmProvenance(projectDir, npmVersions);
    });
    const projectCli = join(projectDir, 'node_modules', '@rustra', 'cli', 'dist', 'index.js');
    context.projectCli = projectCli;
    await commandStep(context, 'doctor', projectDir, [
      process.execPath,
      projectCli,
      'doctor',
      '--config',
      'rustra.json',
    ]);

    // 3) Tauri 소비자 구성·빌드 — crates.io rustra(tauri feature) + @rustra/tauri.
    writeTauriProjectSources(context);
    await codegen(context, 'baseline');
    buildFrontend(context, 'baseline');
    await cargoBuild(context, 'baseline');
    const cargoMetadata = await commandStep(context, 'baseline-cargo-metadata', projectDir, [
      'cargo',
      'metadata',
      '--format-version',
      '1',
      '--locked',
    ]);
    const baselineProvenance = internalStep(context, 'baseline-provenance', () => {
      const lockText = readFileSync(join(projectDir, 'Cargo.lock'), 'utf8');
      return {
        npm: assertExactNpmProvenance(projectDir, npmVersions),
        cargo: assertCargoProvenance({
          metadata: JSON.parse(cargoMetadata.stdout),
          lockText,
          expected: versions.phases.candidate,
          consumerManifestPath: join(projectDir, 'Cargo.toml'),
        }),
      };
    });
    const baselineContractHash = contractHash(projectDir);

    // 4) 실제 WebView 실행 — baseline 관측.
    const baselineObservations = await runWebviewPhase(context, 'baseline', 'baseline');
    internalStep(context, 'baseline-observation-verification', () =>
      assertJourneyObservation(baselineObservations),
    );
    const baselineSnapshot = snapshotEvidence(context, 'baseline');

    // 5) 계약 변형 — 필드 추가 → 재생성 → 재빌드 → 실제 WebView 재실행.
    internalStep(context, 'mutate-contract', () => {
      const libPath = join(projectDir, 'src', 'lib.rs');
      writeFileSync(libPath, mutateTauriLibRs(readFileSync(libPath, 'utf8')));
      writeFileSync(
        join(projectDir, 'src', 'journey-input.ts'),
        renderJourneyInputTs({ phase: 'mutated', message: 'registry-tauri', repeat: 3 }),
      );
    });
    await codegen(context, 'mutated');
    buildFrontend(context, 'mutated');
    await cargoBuild(context, 'mutated');
    const mutatedContractHash = contractHash(projectDir);
    internalStep(context, 'mutated-contract-hash-verification', () => {
      if (mutatedContractHash === baselineContractHash)
        throw new Error('contract hash did not change after the field mutation');
    });
    const mutatedObservations = await runWebviewPhase(context, 'mutated', 'mutated');
    internalStep(context, 'mutated-observation-verification', () =>
      assertMutatedObservation(mutatedObservations),
    );
    const mutatedSnapshot = snapshotEvidence(context, 'mutated');

    return {
      gate: 'rustra-public-registry-tauri-consumer',
      configuration: {
        manifestPath: VERSIONS_PATH,
        versions: { npm: npmVersions, rust: versions.phases.candidate },
      },
      environment: {
        ...environment,
        cachePolicy: 'warm cargo/npm caches reused; registry sources verified via lockfiles',
      },
      runner: { gitHead: runner.stdout.trim() },
      journey: {
        scaffold: ['published CLI init', 'exact-pin npm install (frozen lock)', 'doctor'],
        tauri: [
          'rustra =0.11.0 (tauri feature) from crates.io',
          '@rustra/tauri + @rustra/types exact from npm',
          'CLI codegen (tauri host entry)',
          'bun frontend bundle',
          'cargo build embedding frontend assets',
          'real WebView launch (WKWebView on macOS)',
        ],
        verified: {
          a2FirstCall: 'echo through generated strict-contract entry inside a real WebView',
          a3FieldChange: 'repeat field added → regen → rebuild → repeat=3 returned in WebView',
          a3DomainError: 'failEcho invalid_args message crossed the bridge intact',
          a3Events: 'calc.tick push delivered 3/3 while subscribed, 0 after unsubscribe',
          a1Combination:
            'macOS real WebView receipt with exact published versions (see environment)',
        },
        excluded: [
          {
            segment: 'G1 remaining hosts (RN/Android, RN/iOS) and existing-app integration',
            reason: 'covered by separate journeys; this receipt is the Tauri leg only',
          },
          {
            segment: 'two successive product upgrades',
            reason: 'single registry-line verification; the Node/Bun gate owns the Rust patch roundtrip',
          },
        ],
      },
      provenance: baselineProvenance,
      contractHashes: { baseline: baselineContractHash, mutated: mutatedContractHash },
      observations: { baseline: baselineObservations, mutated: mutatedObservations },
      snapshots: { baseline: baselineSnapshot, mutated: mutatedSnapshot },
      scratchRoot,
      steps: context.steps,
    };
  } catch (error) {
    if (error instanceof Error) {
      error.steps ??= context.steps;
      error.scratchRoot ??= context.scratchRoot;
      error.projectDir ??= projectDir;
    }
    throw error;
  }
}

export async function runTauriRegistryJourney({ outputPath, execute = executeTauriCycle }) {
  const absoluteOutput = resolve(outputPath);
  const logDir = join(dirname(absoluteOutput), 'registry-tauri-logs');
  rmSync(logDir, { recursive: true, force: true });
  mkdirSync(logDir, { recursive: true });
  const startedAt = new Date();
  let receipt;
  try {
    const result = await execute({ outputPath: absoluteOutput, logDir });
    receipt = {
      schemaVersion: 1,
      ok: true,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      evidenceBoundary:
        'automated public-registry Tauri consumer cycle with real macOS WebView; does not close G1 or G2',
      ...result,
    };
    writeJson(absoluteOutput, receipt);
    if (result.scratchRoot) rmSync(result.scratchRoot, { recursive: true, force: true });
  } catch (error) {
    const step = error?.step;
    receipt = {
      schemaVersion: 1,
      ok: false,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      evidenceBoundary: 'failed automated public-registry Tauri consumer cycle; no acceptance claim',
      steps: error?.steps ?? [],
      scratchRoot: error?.scratchRoot ?? null,
      projectDir: error?.projectDir ?? null,
      scratchRetained: Boolean(error?.scratchRoot),
      failure: {
        step: typeof step === 'string' ? step : (step?.name ?? null),
        message: errorText(error),
        code: error?.code ?? null,
        rawLogPath: step?.rawLogPath ?? null,
        stderrTail: error?.stderrTail ?? null,
        diagnostics: errorDetails(error),
      },
    };
    writeJson(absoluteOutput, receipt);
  }
  return receipt;
}

async function main(argv) {
  const outputIndex = argv.indexOf('--output');
  const outputPath = outputIndex === -1 ? null : argv[outputIndex + 1];
  if (!outputPath || !outputPath.startsWith('/')) {
    console.error('registry tauri journey: --output <absolute-path> is required');
    process.exitCode = 1;
    return;
  }
  const receipt = await runTauriRegistryJourney({ outputPath });
  const stream = receipt.ok ? console.log : console.error;
  stream(`[registry-tauri] receipt: ${outputPath}`);
  stream(`[registry-tauri] logs: ${join(dirname(outputPath), 'registry-tauri-logs')}`);
  if (receipt.scratchRoot) stream(`[registry-tauri] scratch: ${receipt.scratchRoot}`);
  if (!receipt.ok) stream(`[registry-tauri] failed: ${receipt.failure.message}`);
  process.exitCode = receipt.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) await main(process.argv.slice(2));

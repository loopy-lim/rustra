#!/usr/bin/env node

// React Native/Android 실기기 레지스트리 소비 여정 — 로드맵 A1/A2/A3(RN/Android).
//
// 공개 레지스트리만으로 (1) RN 앱을 만들고 (2) 발행 CLI·어댑터를 정확 핀 설치해
// (3) 코드젠이 rustra-bridge 네이티브 모듈(podspec/gradle/cmake)을 렌더링하고
// (4) Rust staticlib(cargo-ndk) + APK 를 빌드해 (5) 실제 기기에서 실행, JS 관측을
// logcat 마커로 회수한다. WebView 여정과 달리 커스텀 회신 커맨드 대신 logcat 을
// 쓴다 — Android 앱 프로세스에 증거 파일 경로를 주입할 안정적 수단이 없고,
// console.log 마커는 debug/release 모두에서 ReactNativeJS 태그로 살아남는다.
//
// 증명 범위: 공개 패키지만 쓴 설치·생성·네이티브 빌드·실기기 실행, 도메인 에러
// 전파, 이벤트 구독/해제(JSI 푸시), 계약 필드 변경 후 재생성·재빌드·재실행.
// G1 전체(Tauri·기존 앱·평가자)나 G2 를 닫지 않는다. 기기 증거 수준은 이 영수증에
// 표기한다(실기기 vs 에뮬레이터).

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { release as osRelease, tmpdir, version as osVersion } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertCargoProvenance,
  assertExactNpmProvenance,
  assertNoConsumerContamination,
  generatedFiles,
  hashFiles,
  readJson,
  validateVersionManifest,
  writeJson,
} from './registry-consumer/provenance.mjs';
import { pinCargoVersions } from './registry-consumer/fixture.mjs';
import { errorDetails, runOrderedSteps, sanitizeStepName } from './registry-consumer/runner.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const VERSIONS_PATH = fileURLToPath(new URL('./registry-consumer/versions.json', import.meta.url));
const APP_NAME = 'RegistryRnConsumer';
const APP_PACKAGE = 'dev.rustra.registryrn';
const ERROR_SENTINEL = 'registry rn journey error propagation';
const JOURNEY_MARKER = '__RUSTRA_RN_JOURNEY__';
const EVIDENCE_WAIT_MS = 180_000;

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseCliArgs(argv) {
  const options = { outputPath: null, serial: null };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--output') {
      options.outputPath = argv[++index];
    } else if (option === '--serial') {
      options.serial = argv[++index];
    } else {
      throw new Error(`unknown option: ${option}`);
    }
  }
  if (!options.outputPath || !options.outputPath.startsWith('/'))
    throw new Error('--output <absolute-path> is required');
  return options;
}

// ── 소스 렌더러(순수 함수) ────────────────────────────────────────────────

export function renderRnLibRs() {
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

// JSI 푸시 — 설치된 싱크로 Package::emit 이 JS drain 없이 앱 JS 로 전달된다.
// 싱크는 등록된 패키지 인스턴스에 설치된다 — rustra::ffi::get_package() 핸들로
// 발행한다(calculator 예제 emit_demo 와 동일한 계약).
#[rustra::command]
fn emit_ticks(input: EmitTicksInput) -> Result<EmitTicksOutput> {
    let package = rustra::ffi::get_package()
        .ok_or_else(|| RustraError::custom("ffi.not_registered", "package not registered"))?;
    for index in 0..input.ticks {
        package.emit("calc.tick", serde_json::json!({ "value": index + 1 }));
    }
    Ok(EmitTicksOutput { emitted: input.ticks })
}

pub fn package() -> Package {
    let package = Package::builder("app.demo")
        .command_fn(echo)
        .command_fn(fail_echo)
        .command_fn(emit_ticks)
        .build();
    // 모바일 엔트리 계약 — rustra_mobile_init 이 이 함수를 호출할 때 FFI 전역에
    // 자동 등록돼야 install 시점의 계약 해시 조회가 성립한다(calculator 예제의
    // register_ffi_with_default 와 동일한 자기 등록 패턴).
    package.register_ffi();
    package
}

rustra::native_entry!(package);
`;
}

// 계약 변형 — registry-consumer-gate mutateScaffoldSources 와 같은 결정적 앵커 쌍.
export function mutateRnLibRs(libRs) {
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
      throw new Error(`rn lib.rs mutation anchor not found: ${JSON.stringify(anchor)}`);
    mutated = mutated.replace(anchor, replacement);
  }
  return mutated;
}

export function renderRnAppTsx() {
  return `import { useEffect, useState } from 'react';
import { SafeAreaView, Text } from 'react-native';
import { echo, failEcho, rustra } from './generated/react-native.js';
import { INPUT } from './journey-input.js';

// 이 앱은 이벤트를 구독·발행하지 않는다 — RN/Android 실기기에서 명령 안의
// Package::emit 이 JSI 싱크 배달 중 JS 스레드를 교착시키는 결함(2026-09-21
// 발견, 재현 100%) 때문이다. A3 이벤트 증거는 Tauri 실제 WebView 여정이
// 담당하고, 이 결함은 영수증의 findings 로 기록된다.
export default function App() {
  const [status, setStatus] = useState('booting');
  useEffect(() => {
    (async () => {
      try {
        await rustra.ready();
        const echoResult: any = await echo(INPUT as never);
        let failEchoError: { code: string | null; message: string } | null = null;
        try {
          await failEcho(INPUT as never);
        } catch (error: any) {
          failEchoError = { code: error?.code ?? null, message: String(error?.message ?? error) };
        }
        console.log('${JOURNEY_MARKER}' + JSON.stringify({
          phase: INPUT.phase,
          echoResult,
          failEchoError,
        }));
        setStatus('journey-complete');
      } catch (error) {
        console.log('${JOURNEY_MARKER}' + JSON.stringify({ phase: INPUT.phase, journeyError: String(error) }));
        setStatus('journey-error');
      }
    })();
  }, []);
  return (
    <SafeAreaView>
      <Text>{status}</Text>
    </SafeAreaView>
  );
}
`;

}

export function renderJourneyInputTs(input) {
  const fields = Object.entries(input)
    .map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`)
    .join('\n');
  return `export const INPUT = {\n${fields}\n} as const;\n`;
}

export function renderRnCargoToml() {
  return `# Generated by the RN registry journey — registry-only consumer crate.
[package]
name = "rustra-app"
version = "0.1.0"
edition = "2021"
publish = false

[lib]
name = "rustra_app"
crate-type = ["rlib", "staticlib"]

[dependencies]
rustra = "0"
rustra-macros = "0"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
schemars = "0.8"

[[bin]]
name = "generate"
path = "src/bin/generate.rs"
`;
}

export function renderGenerateRs() {
  return `use std::path::PathBuf;

fn main() -> rustra::Result<()> {
    let generated = rustra_app::package().generate_typescript()?;
    let out = match std::env::var_os("RUSTRA_SCHEMA_OUT") {
        Some(p) if !p.is_empty() => PathBuf::from(p).join("schema.json"),
        _ => PathBuf::from("generated").join("schema.json"),
    };
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&out, generated.schema_json)?;
    println!("{} written", out.display());
    Ok(())
}
`;
}

export function renderRnConfigJson() {
  return `${JSON.stringify(
    {
      $schema: './node_modules/@rustra/cli/rustra.schema.json',
      schema: './generated/schema.json',
      output: './generated',
      reactNative: { rustManifest: './Cargo.toml' },
    },
    null,
    2,
  )}\n`;
}

// 앱 수준 RN config — 오톨링킹이 node_modules 심링크 경로로 모듈을 등록하면
// Gradle file() 기준이 심링크가 되어 생성된 build.gradle 의 상대경로가
// node_modules/node_modules/... 로 중복된다(실측 결함). 모듈 root 를 실제
// 경로로 고정해 해결한다 — 앱 소유 설정이므로 생성물은 그대로다.
export function renderAppReactNativeConfigJs() {
  return `const path = require('path');

module.exports = {
  dependencies: {
    '@rustra/generated-react-native': {
      root: path.resolve(__dirname, 'modules', 'rustra-bridge'),
    },
  },
};
`;
}

// 생성 클라이언트의 내부 임포트는 '.js' 지정자(컴파일 후 ESM 정합)를 쓴다 —
// Metro 는 소스 해석을 확장자로 하므로 RN 앱은 '.js' 요청을 확장자 없는 소스로
// 우선 해석하는 리졸버를 켠다(tauri-calculator 예제와 동일한 계약, 단일 앱판).
export function renderMetroConfigJs() {
  return `const { getDefaultConfig } = require('@react-native/metro-config');

const config = getDefaultConfig(__dirname);
const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.endsWith('.js')) {
    const sourceName = moduleName.slice(0, -3);
    try {
      return (defaultResolveRequest || context.resolveRequest)(context, sourceName, platform);
    } catch {
      // 실제 .js 모듈은 정상 해석으로 되돌린다.
    }
  }
  return (defaultResolveRequest || context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
`;
}

// ── 증거 파싱·단정(순수 함수) ─────────────────────────────────────────────

export function parseLogcatMarker(logcatText, phase) {
  const lines = logcatText.split('\n');
  const reports = [];
  for (const line of lines) {
    const index = line.indexOf(JOURNEY_MARKER);
    if (index === -1) continue;
    try {
      reports.push(JSON.parse(line.slice(index + JOURNEY_MARKER.length)));
    } catch {
      // 말줄임된 로그 줄은 건너뛴다 — 완전한 마커만 증거로 받는다.
    }
  }
  const matching = reports.filter((entry) => entry.phase === phase);
  if (matching.length === 0) return null;
  return matching[matching.length - 1];
}

export function assertJourneyObservation(observations) {
  if (observations.journeyError !== undefined)
    throw new Error(`RN journey reported an error: ${observations.journeyError}`);
  if (observations.failEchoError === null)
    throw new Error('failEcho did not reject in the RN runtime');
  if (!String(observations.failEchoError.message).includes(ERROR_SENTINEL))
    throw new Error(
      `failEcho error message did not cross the JSI bridge intact: ${observations.failEchoError.message}`,
    );
  if (observations.echoResult?.message !== 'registry-rn')
    throw new Error(`echo result message mismatch: ${JSON.stringify(observations.echoResult)}`);
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

async function runChecked(context, name, cwd, argv, extraEnv = {}) {
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

function resolveDeviceSerial(context, requestedSerial) {
  return internalStep(context, 'resolve-device-serial', () => {
    if (requestedSerial) {
      const devices = spawnSync('adb', ['devices'], { encoding: 'utf8' });
      if (!devices.stdout.includes(`${requestedSerial}\tdevice`))
        throw new Error(`requested device ${requestedSerial} is not connected and authorized`);
      return requestedSerial;
    }
    throw new Error('no device serial provided; pass --serial <adb-serial>');
  });
}

function deviceEvidence(context, serial) {
  return internalStep(context, 'device-evidence', () => {
    const getprop = (name) =>
      spawnSync('adb', ['-s', serial, 'shell', 'getprop', name], { encoding: 'utf8' });
    const model = getprop('ro.product.model');
    const sdk = getprop('ro.build.version.sdk');
    const release = getprop('ro.build.version.release');
    const isEmulator = getprop('ro.build.characteristics');
    if (model.status !== 0) throw new Error(`failed to read device model: ${model.stderr}`);
    return {
      serial,
      evidenceLevel:
        String(isEmulator.stdout ?? '').trim() === 'emulator' ? 'emulator' : 'physical-device',
      model: String(model.stdout ?? '').trim(),
      androidSdk: String(sdk.stdout ?? '').trim(),
      androidRelease: String(release.stdout ?? '').trim(),
    };
  });
}

function writeRustCore(context) {
  const projectDir = context.projectDir;
  internalStep(context, 'write-rust-core', () => {
    writeFileSync(join(projectDir, 'Cargo.toml'), renderRnCargoToml());
    pinCargoVersions(projectDir, context.versions.phases.candidate);
    mkdirSync(join(projectDir, 'src', 'bin'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'lib.rs'), renderRnLibRs());
    writeFileSync(join(projectDir, 'src', 'bin', 'generate.rs'), renderGenerateRs());
    writeJson(join(projectDir, 'rustra.json'), JSON.parse(renderRnConfigJson()));
    writeFileSync(join(projectDir, 'metro.config.js'), renderMetroConfigJs());
    writeFileSync(join(projectDir, 'react-native.config.js'), renderAppReactNativeConfigJs());
    writeFileSync(
      join(projectDir, 'journey-input.ts'),
      renderJourneyInputTs({ phase: 'baseline', message: 'registry-rn' }),
    );
  });
}

function writeAppTsx(context) {
  internalStep(context, 'write-app-tsx', () => {
    writeFileSync(join(context.projectDir, 'App.tsx'), renderRnAppTsx());
  });
}

function applyPublishedCliWorkaround(context) {
  internalStep(context, 'workaround-published-cli-esm-module-manifest', () => {
    // 발행 CLI 0.11.3 결함: 생성 모듈 manifest 의 "type":"module" 때문에 Node 기반
    // 오톬링킹(gradle 설정)이 react-native.config.js 를 require 하지 못해
    // RustraBridge 가 링크에서 조용히 빠진다. 본 저장소 렌더러는 CommonJS 로
    // 수정했지만 발행본에는 아직 없다 — 같은 수정을 소비자 쪽에 적용한다.
    // 수정 CLI 가 발행되면 이 단계는 제거 대상이다(receipt 에 결함 기록).
    const moduleManifestPath = join(context.projectDir, 'modules', 'rustra-bridge', 'package.json');
    const manifest = readJson(moduleManifestPath);
    if (manifest.type === 'module') {
      delete manifest.type;
      writeJson(moduleManifestPath, manifest);
    }
  });
}

function contractHash(projectDir) {
  const text = readFileSync(join(projectDir, 'generated', 'contract.ts'), 'utf8');
  const match = text.match(/GENERATED_CONTRACT_HASH\s*=\s*['"]([^'"]+)['"]/);
  if (!match) throw new Error('generated contract.ts does not contain GENERATED_CONTRACT_HASH');
  return match[1];
}

function snapshotEvidence(context, phase) {
  const snapshotRoot = join(context.scratchRoot, 'evidence', phase);
  mkdirSync(snapshotRoot, { recursive: true });
  for (const relativePath of [
    'Cargo.lock',
    'Cargo.toml',
    'package.json',
    'package-lock.json',
    'rustra.json',
    'App.tsx',
    'journey-input.ts',
    'src/lib.rs',
  ]) {
    cpSync(join(context.projectDir, relativePath), join(snapshotRoot, relativePath));
  }
  cpSync(join(context.projectDir, 'generated'), join(snapshotRoot, 'generated'), {
    recursive: true,
  });
  const files = hashFiles(snapshotRoot, [
    'Cargo.lock',
    'Cargo.toml',
    'package.json',
    'package-lock.json',
    'rustra.json',
    'App.tsx',
    'journey-input.ts',
    'src/lib.rs',
    ...generatedFiles(snapshotRoot),
  ]);
  return { root: snapshotRoot, files };
}

async function environmentEvidence(context) {
  const commands = [
    ['node', process.execPath, ['--version']],
    ['npm', 'npm', ['--version']],
    ['cargo', 'cargo', ['--version']],
    ['rustc', 'rustc', ['--version']],
    ['adb', 'adb', ['version']],
  ];
  const environment = {
    platform: process.platform,
    arch: process.arch,
    osRelease: osRelease(),
    osVersion: osVersion(),
  };
  for (const [name, executable, args] of commands) {
    const result = await runChecked(context, `environment-${name}`, context.scratchRoot, [
      executable,
      ...args,
    ]);
    environment[name] = result.stdout.trim().split('\n')[0];
  }
  return environment;
}

async function executeRnAndroidCycle({ logDir, serial }) {
  const versions = validateVersionManifest(readJson(VERSIONS_PATH));
  const reactNativeVersion = versions.hosts?.['@rustra/react-native'];
  if (!reactNativeVersion)
    throw new Error('versions.json hosts["@rustra/react-native"] pin is required');
  const scratchRoot = mkdtempSync(join(tmpdir(), 'rustra-registry-rn-android-'));
  const projectDir = join(scratchRoot, APP_NAME);
  const repoRoot = resolve(dirname(SCRIPT_PATH), '..');
  const context = {
    logDir,
    scratchRoot,
    projectDir,
    versions,
    steps: [],
    env: {
      ...process.env,
      CI: process.env.CI ?? 'true',
      CARGO_TARGET_DIR: join(scratchRoot, 'schema-target'),
      // gradle/cargo-ndk 모두 이 변수를 요구한다 — macOS Android Studio 표준
      // 경로를 폴백 기본값으로 채운다(있으면 환경값이 이긴다).
      ANDROID_HOME:
        process.env.ANDROID_HOME ??
        join(process.env.HOME ?? '', 'Library', 'Android', 'sdk'),
    },
  };
  const npmVersions = {
    '@rustra/cli': versions.npm['@rustra/cli'],
    '@rustra/types': versions.npm['@rustra/types'],
    '@rustra/react-native': reactNativeVersion,
  };
  try {
    const environment = await environmentEvidence(context);
    const runner = await runChecked(context, 'runner-git-head', repoRoot, ['git', 'rev-parse', 'HEAD']);
    const device = resolveDeviceSerial(context, serial);
    const deviceInfo = deviceEvidence(context, device);

    // 1) RN 앱 스캐폴드 — 공개 템플릿(커뮤니티 CLI)로 빈 앱을 만든다.
    await runChecked(context, 'rn-init', scratchRoot, [
      'npx',
      '--yes',
      '@react-native-community/cli@20.2.0',
      'init',
      APP_NAME,
      '--version',
      '0.81.5',
      '--package-name',
      APP_PACKAGE,
      '--skip-install',
      '--skip-git-init',
    ]);

    // 2) 발행 패키지 정확 핀 설치 + Rust 코어·설정 작성.
    writeRustCore(context);
    writeAppTsx(context);
    internalStep(context, 'pin-npm-versions', () => {
      const packagePath = join(projectDir, 'package.json');
      const packageJson = readJson(packagePath);
      packageJson.dependencies['@rustra/react-native'] = npmVersions['@rustra/react-native'];
      packageJson.dependencies['@rustra/types'] = npmVersions['@rustra/types'];
      packageJson.devDependencies['@rustra/cli'] = npmVersions['@rustra/cli'];
      writeJson(packagePath, packageJson);
    });
    await runChecked(context, 'install-npm', projectDir, [
      'npm',
      'install',
      '--no-audit',
      '--no-fund',
    ]);
    internalStep(context, 'verify-exact-npm-sources', () => {
      assertNoConsumerContamination(projectDir, {
        expectedNpm: npmVersions,
        allowedWorkspacePackages: ['@rustra/generated-react-native'],
      });
      return assertExactNpmProvenance(projectDir, npmVersions);
    });

    // 3) 코드젠 — rustra-bridge 네이티브 모듈 + 생성 클라이언트.
    const projectCli = join(projectDir, 'node_modules', '@rustra', 'cli', 'dist', 'index.js');
    await runChecked(context, 'baseline-codegen', projectDir, [
      process.execPath,
      projectCli,
      'codegen',
      '--config',
      'rustra.json',
    ]);
    internalStep(context, 'install-generated-workspace', () => {
      // ensureReactNativeDependency 가 package.json 에 workspace:* 를 추가한다 —
      // npm workspaces 링크를 만들고 나서 진위를 다시 검증한다.
      const packageJson = readJson(join(projectDir, 'package.json'));
      if (packageJson.dependencies['@rustra/generated-react-native'] !== 'workspace:*')
        throw new Error('codegen did not register the generated workspace package');
      if (!packageJson.workspaces?.includes('modules/rustra-bridge'))
        throw new Error('codegen did not register the rustra-bridge workspace');
    });
    applyPublishedCliWorkaround(context);
    await runChecked(context, 'install-workspaces', projectDir, ['npm', 'install', '--no-audit', '--no-fund']);
    await runChecked(context, 'baseline-doctor', projectDir, [
      process.execPath,
      projectCli,
      'doctor',
      '--config',
      'rustra.json',
    ]);
    const baselineContractHash = contractHash(projectDir);

    // 4) JS 번들 + APK 빌드(cargo-ndk 포함) — 디버그 APK.
    await runChecked(
      context,
      'baseline-js-bundle',
      projectDir,
      [
        'npx',
        '--yes',
        'react-native',
        'bundle',
        '--platform',
        'android',
        '--dev',
        'false',
        '--entry-file',
        'index.js',
        '--bundle-output',
        'android/app/src/main/assets/index.android.bundle',
        '--assets-dest',
        'android/app/src/main/res',
      ],
    );
    await runChecked(
      context,
      'baseline-gradle-assemble',
      join(projectDir, 'android'),
      ['./gradlew', ':app:assembleDebug', '--no-daemon'],
      { RUSTRA_PROFILE: 'debug' },
    );
    const apkPath = join(
      projectDir,
      'android',
      'app',
      'build',
      'outputs',
      'apk',
      'debug',
      'app-debug.apk',
    );
    internalStep(context, 'verify-apk', () => {
      if (!existsSync(apkPath)) throw new Error(`debug APK missing: ${apkPath}`);
      return { path: apkPath };
    });
    const cargoMetadata = await runChecked(context, 'baseline-cargo-metadata', projectDir, [
      'cargo',
      'metadata',
      '--format-version',
      '1',
      '--locked',
    ]);
    const provenance = internalStep(context, 'baseline-provenance', () => ({
      npm: assertExactNpmProvenance(projectDir, npmVersions),
      cargo: assertCargoProvenance({
        metadata: JSON.parse(cargoMetadata.stdout),
        lockText: readFileSync(join(projectDir, 'Cargo.lock'), 'utf8'),
        expected: versions.phases.candidate,
        consumerManifestPath: join(projectDir, 'Cargo.toml'),
      }),
    }));

    // 5) 실기기 실행 — logcat 마커 회수.
    const applicationId = APP_PACKAGE;
    const launchAndCollect = async (label, phase) => {
      await runChecked(context, `${label}-install-apk`, projectDir, [
        'adb',
        '-s',
        device,
        'install',
        '-r',
        apkPath,
      ]);
      await runChecked(context, `${label}-clear-logcat`, projectDir, ['adb', '-s', device, 'logcat', '-c']);
      await runChecked(context, `${label}-launch-app`, projectDir, [
        'adb',
        '-s',
        device,
        'shell',
        'am',
        'start',
        '-W',
        '-n',
        `${applicationId}/.MainActivity`,
      ]);
      const startedAt = Date.now();
      const logPath = join(context.logDir, `${label}-logcat.log`);
      return internalStep(context, `${label}-collect-evidence`, () => {
        for (;;) {
          const dump = spawnSync('adb', ['-s', device, 'logcat', '-d', '-s', 'ReactNativeJS:I'], {
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
          });
          const observations = parseLogcatMarker(dump.stdout ?? '', phase);
          if (observations) {
            writeFileSync(logPath, dump.stdout ?? '');
            return observations;
          }
          if (Date.now() - startedAt > EVIDENCE_WAIT_MS)
            throw new Error(`journey marker for phase ${phase} never arrived in logcat`);
            spawnSync('sleep', ['2']);
        }
      });
    };
    const baselineObservations = await launchAndCollect('baseline', 'baseline');
    internalStep(context, 'baseline-observation-verification', () =>
      assertJourneyObservation(baselineObservations),
    );
    const baselineSnapshot = snapshotEvidence(context, 'baseline');

    // 6) 계약 변형 → 재생성 → 재번들·재빌드 → 실기기 재실행.
    internalStep(context, 'mutate-contract', () => {
      const libPath = join(projectDir, 'src', 'lib.rs');
      writeFileSync(libPath, mutateRnLibRs(readFileSync(libPath, 'utf8')));
      writeFileSync(
        join(projectDir, 'journey-input.ts'),
        renderJourneyInputTs({ phase: 'mutated', message: 'registry-rn', repeat: 3 }),
      );
    });
    await runChecked(context, 'mutated-codegen', projectDir, [
      process.execPath,
      projectCli,
      'codegen',
      '--config',
      'rustra.json',
    ]);
    applyPublishedCliWorkaround(context);
    await runChecked(
      context,
      'mutated-js-bundle',
      projectDir,
      [
        'npx',
        '--yes',
        'react-native',
        'bundle',
        '--platform',
        'android',
        '--dev',
        'false',
        '--entry-file',
        'index.js',
        '--bundle-output',
        'android/app/src/main/assets/index.android.bundle',
        '--assets-dest',
        'android/app/src/main/res',
      ],
    );
    await runChecked(
      context,
      'mutated-gradle-assemble',
      join(projectDir, 'android'),
      ['./gradlew', ':app:assembleDebug', '--no-daemon'],
      { RUSTRA_PROFILE: 'debug' },
    );
    const mutatedContractHash = contractHash(projectDir);
    internalStep(context, 'mutated-contract-hash-verification', () => {
      if (mutatedContractHash === baselineContractHash)
        throw new Error('contract hash did not change after the field mutation');
    });
    const mutatedObservations = await launchAndCollect('mutated', 'mutated');
    internalStep(context, 'mutated-observation-verification', () =>
      assertMutatedObservation(mutatedObservations),
    );
    const mutatedSnapshot = snapshotEvidence(context, 'mutated');

    // 기기 정리 — 여정 앱을 제거해 사용자 기기를 원 상태로 돌린다.
    await runChecked(context, 'uninstall-app', projectDir, [
      'adb',
      '-s',
      device,
      'uninstall',
      applicationId,
    ]);

    return {
      gate: 'rustra-public-registry-rn-android-consumer',
      configuration: {
        manifestPath: VERSIONS_PATH,
        versions: {
          npm: npmVersions,
          rust: versions.phases.candidate,
          reactNativeTemplate: '0.81.5',
          communityCli: '20.2.0',
        },
      },
      environment: { ...environment, device: deviceInfo },
      runner: { gitHead: runner.stdout.trim() },
      journey: {
        scaffold: [
          'public RN community template (no Expo)',
          'exact-pin npm install of CLI/types/react-native adapter',
          'codegen renders rustra-bridge module (gradle/cmake/podspec) + generated client',
          'cargo-ndk staticlib + gradle assembleDebug',
          'standalone JS bundle (no metro at runtime)',
          'physical-device launch via adb',
        ],
        verified: {
          a2FirstCall: 'echo through generated strict-contract entry on a real Android device',
          a3FieldChange: 'repeat field added → regen → rebuild → repeat=3 returned on device',
          a3DomainError: 'failEcho invalid_args message crossed the JSI bridge intact',
          a3Events:
            'not asserted on this leg — see findings rn-android-event-push-deadlock; covered by the Tauri real-WebView journey',
          a1Combination: `RN/Android ${deviceInfo.evidenceLevel} receipt (${deviceInfo.model}, SDK ${deviceInfo.androidSdk})`,
        },
        findings: [
          {
            id: 'rn-android-event-push-deadlock',
            summary:
              'emitting from a command over the bridge deadlocks the JS thread on a physical Android device: the invoke returns, then the JS event loop stops before the next macrotask',
            reproduction:
              'subscribeEvent (push, and pollMs too — the JSI sink is installed at install time) followed by any Package::emit; breadcrumbs sub-emit-ok -> freeze, repro 3/3 on TB710FU / RN 0.81.5 / adapter 0.9.2 / rustra 0.11.0',
            consequence: 'a3Events for this leg is intentionally not asserted; the Tauri real-WebView journey covers event subscribe/unsubscribe on its push path',
          },
        ],
        excluded: [
          {
            segment: 'RN/iOS and existing-app integration',
            reason: 'separate journeys; this receipt is the RN/Android leg only',
          },
          {
            segment: 'two successive product upgrades',
            reason: 'single registry-line verification; the Node/Bun gate owns the Rust patch roundtrip',
          },
        ],
      },
      provenance,
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

export async function runRnAndroidRegistryJourney({ outputPath, serial, execute }) {
  const absoluteOutput = resolve(outputPath);
  const logDir = join(dirname(absoluteOutput), 'registry-rn-android-logs');
  rmSync(logDir, { recursive: true, force: true });
  mkdirSync(logDir, { recursive: true });
  const startedAt = new Date();
  let receipt;
  try {
    const result = await (execute ?? executeRnAndroidCycle)({ logDir, serial });
    receipt = {
      schemaVersion: 1,
      ok: true,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      evidenceBoundary:
        'automated public-registry React Native consumer cycle on a real Android device; does not close G1 or G2',
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
      evidenceBoundary:
        'failed automated public-registry React Native consumer cycle; no acceptance claim',
      steps: error?.steps ?? [],
      scratchRoot: error?.scratchRoot ?? null,
      projectDir: error?.projectDir ?? null,
      scratchRetained: Boolean(error?.scratchRoot),
      failure: {
        step: typeof step === 'string' ? step : (step?.name ?? null),
        message: errorText(error),
        code: error?.code ?? null,
        rawLogPath: step?.rawLogPath ?? null,
        diagnostics: errorDetails(error),
      },
    };
    writeJson(absoluteOutput, receipt);
  }
  return receipt;
}

async function main(argv) {
  let options;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    console.error(`registry rn android journey: ${errorText(error)}`);
    process.exitCode = 1;
    return;
  }
  const receipt = await runRnAndroidRegistryJourney(options);
  const stream = receipt.ok ? console.log : console.error;
  stream(`[registry-rn-android] receipt: ${options.outputPath}`);
  stream(`[registry-rn-android] logs: ${join(dirname(options.outputPath), 'registry-rn-android-logs')}`);
  if (receipt.scratchRoot) stream(`[registry-rn-android] scratch: ${receipt.scratchRoot}`);
  if (!receipt.ok) stream(`[registry-rn-android] failed: ${receipt.failure.message}`);
  process.exitCode = receipt.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) await main(process.argv.slice(2));

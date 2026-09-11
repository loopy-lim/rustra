import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnInherit } from './process.js';
import { readConfigSync } from './config.js';
import { resolveCodegenTarget } from './host-entries.js';
import { runGenerate } from './cli-generate.js';
import { parseCodegenArgs, type CliOutputFormat } from './cli-options.js';
import { explainCodegenSurfaces, formatExplainText } from './codegen-explain.js';
import { formatCodegenJson, formatExplainJson } from './cli-json-format.js';
import {
  UNIFFI_GENERATED_RS,
  checkUniffiGeneratedRs,
  resolveUniffiSrcOut,
  runUniffiBindings,
} from './cli-uniffi.js';

function status(format: CliOutputFormat | undefined, message: string): void {
  (format === 'json' ? console.error : console.log)(message);
}

function wrapError(message: string, error: unknown): Error {
  return new Error(`${message}: ${error instanceof Error ? error.message : String(error)}`, {
    cause: error,
  });
}

/** runGenerate 진행 표기의 drift 신호 — "(updated)" 접미어가 하나라도 있으면 갱신. */
const hasUpdatedMarker = (files: string[]): boolean =>
  files.some((file) => file.endsWith('(updated)'));

/**
 * 스테일 런타임 바이너리 힌트(감사 #3) — codegen 은 TS/C++ 만 다시 렌더하고 실제
 * invoke 를 서브하는 런타임 바이너리는 재빌드하지 않는다. drift((updated) 표기)가
 * 있으면 기존 생성물이 갱신된 것이므로 cargo build 전까지 invoke 가 contract.mismatch
 * 로 죽을 수 있다(@rustra/types 의 RustraCommandError 코드 — 네이티브 contract hash
 * ≠ 기대 hash). JSON 계약에는 손대지 않는다(텍스트 모드 전용).
 */
export function staleBinaryHint(files: string[]): string | null {
  if (!hasUpdatedMarker(files)) return null;
  return (
    '[rustra] Note: generated code changed — rebuild the runtime binary before invoking ' +
    '(cargo build), or invokes may fail with contract.mismatch.'
  );
}

/** 표면 지도 출력 — config 해석만으로 facts를 만든다(파일 시스템 쓰기 없음). */
function printExplain(
  config: ReturnType<typeof readConfigSync>,
  format: CliOutputFormat | undefined,
): void {
  const hostEntries = [
    config.node ? 'node.ts' : null,
    config.bun ? 'bun.ts' : null,
    config.tauri ? 'tauri.ts' : null,
    config.reactNative ? 'react-native.ts' : null,
  ].filter((entry): entry is string => entry !== null);
  const rows = explainCodegenSurfaces({
    hasCpp: Boolean(config.cppOutput || config.reactNative),
    hasReactNative: Boolean(config.reactNative),
    positional: Boolean(config.positional),
    hostEntries,
  });
  // doctor/codegen/diff 가 공유하는 schemaVersion:1 관례(cli-json-format.ts) —
  // 구형 `{command:'codegen', explain}` 임의 shape 는 소비자 0건을 확인하고
  // 통일했다. rows 는 ExplainRow 를 그대로 실린다(텍스트 렌더러와 같은 판별).
  if (format === 'json') console.log(formatExplainJson({ explain: rows }));
  else console.log(formatExplainText(rows));
}

export async function runCodegen(args: string[]): Promise<void> {
  const options = parseCodegenArgs(args);
  if (options.help) return;
  const startedAt = Date.now();
  const configPath = resolve(options.configPath!);
  const config = readConfigSync(configPath);
  // --explain 은 순수 조회 — cargo/TS 렌더러를 실행하지 않고 표면 지도만 출력한다.
  if (options.explain) {
    printExplain(config, options.format);
    return;
  }
  const target = resolveCodegenTarget(configPath, config);
  const manifestPath = resolve(dirname(configPath), config.output, '.rustra-generated.json');
  if (options.check && !existsSync(manifestPath))
    throw new Error(`Generated check requires ${manifestPath}; run rustra codegen first`);
  // uniffi 섹션 존재 자체가 기능 스위치다 — 없으면 아래 흐름은 이전과 바이트 동일
  // (env 추가 스폰 없음). 경로 해상도는 schema/output 과 같은 config 파일 위치
  // 기준 상대경로 관례를 따른다.
  const uniffi = config.uniffi;
  const uniffiSrcOut = uniffi ? resolveUniffiSrcOut(dirname(configPath), uniffi) : null;
  const uniffiBindingOut = uniffi ? resolve(dirname(configPath), uniffi.output) : null;
  status(
    options.format,
    `[rustra] Rust schema: cargo run --manifest-path ${target.manifestPath} --package ${target.packageName} --bin ${target.binaryName}`,
  );
  const checkRoot = options.check
    ? await mkdtemp(resolve(tmpdir(), 'rustra-codegen-check-'))
    : null;
  try {
    // Rust bin 의 스키마 발행 위치를 config.schema 가 선언한 디렉터리로 고정한다.
    // bin 의 기본값("generated/schema.json")은 **스폰 CWD 상대**라, config 디렉터리에서
    // 스폰되는 이 흐름에서는 config.schema 바깥에 사본을 만든다 — dev 패리티 게이트가
    // 읽는 config.schemaPath 는 갱신되지 않아 게이트가 stale 비교로 무력화된다
    // (tauri-calculator rustra.hot.json 레이아웃, 2026-09-10 실측). check 모드는
    // 기존대로 임시 디렉터리로 우회한다.
    const schemaOutDir = checkRoot ?? dirname(resolve(dirname(configPath), config.schema));
    try {
      await spawnInherit(
        'cargo',
        [
          'run',
          '--manifest-path',
          target.manifestPath,
          '--package',
          target.packageName,
          '--bin',
          target.binaryName,
        ],
        target.cwd,
        {
          env: {
            RUSTRA_SCHEMA_OUT: schemaOutDir,
            // uniffi 섹션이 있을 때만 프로브에 mirror 소스 출력 위치를 고정한다.
            // write 모드는 커밋 위치(uniffi.srcOut, 기본 "src")로, check 모드는
            // 임시 렌더 디렉터리로 우회시켜 커밋 파일을 더럽히지 않는다 — 스키마
            // 출력의 check/write 분기(schemaOutDir)와 같은 모양이다.
            ...(uniffiSrcOut
              ? {
                  RUSTRA_UNIFFI_OUT: checkRoot ? resolve(checkRoot, 'uniffi-src') : uniffiSrcOut,
                }
              : {}),
          },
          progressLabel: `Rust schema generation (${target.packageName}/${target.binaryName})`,
          progressStream: options.format === 'json' ? 'stderr' : 'stdout',
          childOutput: options.format === 'json' ? 'stderr' : 'inherit',
        },
      );
    } catch (error) {
      throw wrapError(
        `Rust schema generation failed for ${target.packageName}/${target.binaryName} (${target.manifestPath})`,
        error,
      );
    }
    if (uniffi && !options.check && uniffiBindingOut) {
      // uniffi-bindings 단계(쓰기 모드 한정) — cdylib 빌드 → bindgen → 산출물
      // 검증. check 모드에서는 의도적으로 건너뛴다: cargo build/bindgen 은 수 분
      // 급 고비용이고, CI 전수 게이트(scripts/check-codegen-fresh.mjs)가 매 실행
      // 돌리는 --check 에 넣으면 게이트가 좌초한다. check 모드의 uniffi 신선도는
      // 아래 uniffi_generated.rs 바이트 비교(저비용)가 대변한다 — 이 비대칭이
      // 계약이다.
      await runUniffiBindings(
        {
          manifestPath: target.manifestPath,
          packageName: target.packageName,
          cwd: target.cwd,
        },
        uniffi,
        uniffiBindingOut,
        {
          // 스키마 프로브와 같은 판별 — JSON stdout 은 기계 계약이라 오염 금지.
          progressStream: options.format === 'json' ? 'stderr' : 'stdout',
          childOutput: options.format === 'json' ? 'stderr' : 'inherit',
        },
        (command) => status(options.format, `[rustra] uniffi-bindings: ${command}`),
      );
    }
    if (checkRoot) {
      const temporarySchema = resolve(checkRoot, 'schema.json');
      if (!existsSync(temporarySchema))
        throw new Error(
          `Rust codegen did not produce ${temporarySchema}; the generator must honor RUSTRA_SCHEMA_OUT in check mode`,
        );
      status(options.format, `[rustra] TypeScript/C++: generate --config ${configPath} --check`);
      try {
        await runGenerate(
          [
            '--config',
            configPath,
            '--check',
            ...(options.format ? ['--format', options.format] : []),
          ],
          temporarySchema,
          { quiet: true },
        );
      } catch (error) {
        throw wrapError(
          `TypeScript/C++ generation check failed for ${configPath} (schema ${temporarySchema})`,
          error,
        );
      }
      if (uniffi && uniffiSrcOut) {
        // check 모드의 uniffi 신선도 — 프로브가 임시 디렉터리에 재현한
        // uniffi_generated.rs 를 커밋 파일과 바이트 비교한다(위의 비대칭 주석).
        // TS 매니페스트(.rustra-generated.json)에 편입하지 않은 이유: 매니페스트는
        // config.output 루트에 뿌리내리고 예상 밖 항목을 거절하는 TS 렌더러 산출물
        // 대장이라, Rust 프로브 산출물을 억지로 편입하면 렌더러 계약이 흔들린다.
        status(
          options.format,
          `[rustra] uniffi-bindings: check — ${UNIFFI_GENERATED_RS} byte comparison only (no cargo build / uniffi-bindgen)`,
        );
        await checkUniffiGeneratedRs(
          resolve(checkRoot, 'uniffi-src', UNIFFI_GENERATED_RS),
          resolve(uniffiSrcOut, UNIFFI_GENERATED_RS),
        );
      }
    }
  } finally {
    if (checkRoot) await rm(checkRoot, { recursive: true, force: true });
  }
  if (options.check) {
    // check 모드 — runGenerate(--check) 가 이미 불일치 시 throw 하므로 여기
    // 도달은 drift=false 다. 실제 드리프트 관측은 doctor 의
    // codegen.generated_freshness 검사가 담당한다.
    if (options.format === 'json') {
      console.log(
        formatCodegenJson({ written: [], drift: false, durationMs: Date.now() - startedAt }),
      );
    }
    return;
  }
  status(options.format, `[rustra] TypeScript/C++: generate --config ${configPath}`);
  try {
    const files = await runGenerate(
      ['--config', configPath, ...(options.format ? ['--format', options.format] : [])],
      undefined,
      { quiet: true },
    );
    if (options.format === 'json')
      console.log(
        formatCodegenJson({
          written: files,
          // "(updated)" 표기가 하나라도 있으면 기존 생성물이 갱신된 것 — CI가
          // "재생성해도 바뀌는가"를 파싱 없이 판정하는 drift 신호다.
          drift: hasUpdatedMarker(files),
          durationMs: Date.now() - startedAt,
        }),
      );
    // 텍스트 모드 전용 — generate 와 동일한 파일 목록·(unchanged)/(updated) 표기
    // (감사 A3). codegen 이 주력 경로인데 목록을 quiet 로 삼키면 drift 표기가 stale
    // 힌트에만 의존한다. 이어서 스테일 런타임 바이너리 힌트(감사 #3)를 붙인다.
    else {
      console.log(`Generated TypeScript files in ${resolve(dirname(configPath), config.output)}:`);
      for (const file of files) console.log(`  ${file}`);
      const hint = staleBinaryHint(files);
      if (hint) console.log(hint);
    }
  } catch (error) {
    throw wrapError(`TypeScript/C++ generation failed for ${configPath}`, error);
  }
}

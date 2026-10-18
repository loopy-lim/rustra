// scriptc FFI 코드젠의 골드 데이터 계약 — calculator 스키마 기준으로 생성되는
// ffi.json(ffi_format 7)의 함수 목록/파라미터 클래스/libraries 경계와 TS 선언
// 시그니처를 고정한다. scriptc 바이너리 없이 통과해야 한다(문자열 렌더만 검증).
//
// 조사 근거: docs/dev/plans/2026-10-03-scriptc-integration-notes.md +
// scriptc.dev/docs/ffi — mutable-bytes 는 format 6+, u64 는 format 7. 매니페스트는
// scriptc 직접 호출 세계가 공급 가능한 인자만 담는다(포인터 클래스 인자는 bigint
// 주소뿐 — caller 가 쓰기 가능한 주소를 얻는 프리미티브가 없어 out 포인터 심볼은
// 전부 제외). 콜백은 format 2+(외부 스레드는 format 5)라 제외한다. 실증: 예제
// 계산기 게이트(examples/calculator/scriptc/run.sh)가 같은 매니페스트로 응답 42.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import type { PackageSchema } from './schema.js';
import {
  SCRIPTC_DECLARATIONS_FILE,
  SCRIPTC_FFI_FORMAT,
  SCRIPTC_MANIFEST_FILE,
  SCRIPTC_SOURCE_FILE,
  generateScriptcArtifacts,
  generateScriptcFunctions,
  generateScriptcManifest,
  renderScriptcDeclarations,
  renderScriptcFfiJson,
  resolveScriptcArchivePath,
  scriptcExcludedSymbols,
  toScriptcTsType,
} from './cli-generate-scriptc.js';

/** 커밋된 calculator 스키마 — 코드젠 입력의 실물 근거. */
const CALCULATOR_SCHEMA_PATH = fileURLToPath(
  new URL('../../../examples/calculator/generated/schema.json', import.meta.url),
);

const CALCULATOR_PACKAGE = 'rustra-calculator-example';
const CALCULATOR_ARCHIVE = 'librustra_calculator_example.a';

const loadCalculatorSchema = (): PackageSchema =>
  JSON.parse(readFileSync(CALCULATOR_SCHEMA_PATH, 'utf8')) as PackageSchema;

test('ffi_format 7 gold — the envelope entry needs u64(7) and mutable-bytes(6+)', () => {
  assert.equal(SCRIPTC_FFI_FORMAT, 7);
  // 실증 매니페스트(예제 계산기)와 같은 포맷이어야 한다.
  const spike = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../examples/calculator/scriptc/ffi.json', import.meta.url)),
      'utf8',
    ),
  ) as { ffi_format: number };
  assert.equal(spike.ffi_format, SCRIPTC_FFI_FORMAT);
});

test('toScriptcTsType maps the manifest classes 1:1', () => {
  assert.equal(toScriptcTsType('string'), 'string');
  assert.equal(toScriptcTsType('mutable-bytes'), 'Uint8Array');
  assert.equal(toScriptcTsType('bool'), 'boolean');
  assert.equal(toScriptcTsType('u32'), 'number');
  assert.equal(toScriptcTsType('u64'), 'bigint');
  assert.equal(toScriptcTsType('void'), 'void');
});

test('resolveScriptcArchivePath follows the staticlib naming convention', () => {
  assert.equal(
    resolveScriptcArchivePath(join('examples', 'calculator', 'target'), CALCULATOR_PACKAGE),
    resolve('examples', 'calculator', 'target', 'release', CALCULATOR_ARCHIVE),
  );
  assert.equal(
    resolveScriptcArchivePath('/abs/target', CALCULATOR_PACKAGE, 'debug'),
    join('/abs/target', 'debug', CALCULATOR_ARCHIVE),
  );
});

test('ffi.json gold: ffi_format, function list, and library boundary', () => {
  const archive = resolveScriptcArchivePath('/tmp/target', CALCULATOR_PACKAGE);
  const manifest = generateScriptcManifest(archive);
  assert.equal(manifest.ffi_format, SCRIPTC_FFI_FORMAT);
  // libraries 는 staticlib 아카이브 단 한 건 — 시스템 라이브러리 경계는 비어 있다.
  assert.deepEqual(manifest.libraries, [archive]);
  assert.deepEqual(manifest.system_libraries, []);
  // 골드 함수 목록(순서 고정 — append-only 성장 계약). 맨 앞은 native_entry! 의
  // 균일 초기화 진입, 그 다음은 caller-buffer envelope 진입이다.
  assert.deepEqual(
    manifest.functions.map((entry) => entry.name),
    [
      'rustra_mobile_init',
      'rustra_ffi_invoke_json_into_len',
      'rustra_ffi_schema_generation',
      'rustra_ffi_get_max_payload',
      'rustra_ffi_set_max_payload',
      'rustra_ffi_invoke_cancel',
      'rustra_ffi_cancellation_status',
      'rustra_ffi_channel_create_bytes',
      'rustra_ffi_channel_release_scriptc',
      'rustra_ffi_channel_send_bytes',
      'rustra_ffi_invoke_json_async_channel',
      'rustra_ffi_event_sink_register_scriptc',
      'rustra_ffi_event_sink_release_scriptc',
    ],
  );
  // name 과 symbol 은 rustra 에서 동일하다.
  for (const entry of manifest.functions) assert.equal(entry.name, entry.symbol);
});

test('ffi.json gold: (ptr,len) pairs fold into single classes', () => {
  const byName = new Map(generateScriptcFunctions().map((entry) => [entry.name, entry]));
  const init = byName.get('rustra_mobile_init');
  const intoLen = byName.get('rustra_ffi_invoke_json_into_len');
  const setMax = byName.get('rustra_ffi_set_max_payload');
  const cancel = byName.get('rustra_ffi_invoke_cancel');
  const status = byName.get('rustra_ffi_cancellation_status');
  assert.ok(init && intoLen && setMax && cancel && status);
  // 초기화는 무인자 void — native_entry! 계약.
  assert.deepEqual(init.params, []);
  assert.equal(init.returns, 'void');
  // (payload, payload_len) 은 string 한 항목, (buf, capacity) 는 mutable-bytes 한
  // 항목(format 6+)으로 접히고, 길이는 out 포인터 없이 u64 반환(format 7)으로 온다.
  assert.deepEqual(intoLen.params, ['string', 'mutable-bytes']);
  assert.equal(intoLen.returns, 'u64');
  assert.deepEqual(setMax.params, ['u64']);
  assert.equal(setMax.returns, 'void');
  assert.deepEqual(cancel.params, ['u64']);
  assert.equal(cancel.returns, 'bool');
  assert.deepEqual(status.params, ['u64']);
  assert.equal(status.returns, 'u32');
});

test('ffi.json excludes out-pointer and callback symbols with documented reasons', () => {
  const functions = generateScriptcFunctions();
  const included = new Set(functions.map((entry) => entry.name));
  for (const { symbol } of scriptcExcludedSymbols) assert.equal(included.has(symbol), false);
  // out 포인터에 쓰는 심볼 — scriptc 직접 세계에 caller 주소 프리미티브가 없다.
  for (const name of [
    'rustra_ffi_invoke',
    'rustra_ffi_invoke_json',
    'rustra_ffi_invoke_json_into',
    'rustra_ffi_invoke_buffer',
    'rustra_ffi_invoke_raw',
    'rustra_ffi_get_schema',
    'rustra_ffi_contract_hash',
    'rustra_ffi_free',
    'rustra_ffi_free_owned_bytes',
  ])
    assert.equal(included.has(name), false);
  // 콜백 함수 포인터를 받는 심볼도 callback descriptor(format 2+/5) 없이는 불가.
  for (const name of [
    'rustra_ffi_invoke_async',
    'rustra_ffi_event_sink_register',
    'rustra_ffi_channel_create',
  ])
    assert.equal(included.has(name), false);
  // 사유는 그룹별로 명시한다(out 포인터 / 포인터 인자 / 콜백 / 짝 심볼).
  for (const { symbol, reason } of scriptcExcludedSymbols) {
    assert.match(
      reason,
      /out-pointer|pointer parameter|callback descriptor|C-unwind callback|pairs with/,
    );
    assert.ok(symbol.startsWith('rustra_ffi_'), symbol);
  }
  // caller-buffer 계약의 scriptc 형태 대체재가 존재해야 한다.
  assert.ok(included.has('rustra_ffi_invoke_json_into_len'));
});

test('ffi.json serialization is stable and parses back to the manifest', () => {
  const manifest = generateScriptcManifest('/tmp/target/release/libx.a');
  const json = renderScriptcFfiJson(manifest);
  // JSON 산출물엔 헤더를 각인하지 않는다(generated-header.ts 계약).
  assert.ok(!json.startsWith('//'));
  assert.deepEqual(JSON.parse(json), manifest);
  assert.equal(json, renderScriptcFfiJson(generateScriptcManifest('/tmp/target/release/libx.a')));
});

test('declarations gold: signature-only TS for calculator schema', () => {
  const archive = resolveScriptcArchivePath('/tmp/target', CALCULATOR_PACKAGE);
  const { declarations, ffiJson, manifest } = generateScriptcArtifacts({
    schema: loadCalculatorSchema(),
    archivePath: archive,
  });
  assert.deepEqual(manifest.libraries, [archive]);
  // 골드 시그니처 — 플랫 클래스 배열이 TS 타입으로 1:1 펼쳐진다.
  const gold = [
    'declare function rustra_mobile_init(): void;',
    'declare function rustra_ffi_invoke_json_into_len(payload: string, buf: Uint8Array): bigint;',
    'declare function rustra_ffi_schema_generation(): bigint;',
    'declare function rustra_ffi_get_max_payload(): bigint;',
    'declare function rustra_ffi_set_max_payload(bytes: bigint): void;',
    'declare function rustra_ffi_invoke_cancel(invocation_id: bigint): boolean;',
    'declare function rustra_ffi_cancellation_status(invocation_id: bigint): number;',
  ];
  for (const line of gold) assert.ok(declarations.includes(line), line);
  // 시그니처-only — 함수 본문이 없어야 한다.
  for (const line of declarations.split('\n'))
    if (line.startsWith('export declare function ')) assert.ok(line.endsWith(';'), line);
  // 근거 스키마 각인과 생성 헤더(첫 행은 'rustra generated' 대시 런).
  assert.ok(declarations.includes('근거 스키마: examples.calculator (schemaVersion 1)'));
  assert.ok(declarations.startsWith('// ── rustra generated ──'));
  assert.ok(declarations.includes(`File:   ${SCRIPTC_SOURCE_FILE}`));
  // ffi.json 은 calculator 아카이브를 가리킨다.
  assert.deepEqual(JSON.parse(ffiJson).libraries, [archive]);
});

test('declarations record schemaVersion only when the schema carries one', () => {
  const manifest = generateScriptcManifest('/tmp/libx.a');
  assert.ok(
    renderScriptcDeclarations(manifest, 'app.x').includes('근거 스키마: app.x\n'),
    'no schemaVersion marker when absent',
  );
  assert.ok(
    renderScriptcDeclarations(manifest, 'app.x', 3).includes(
      '근거 스키마: app.x (schemaVersion 3)',
    ),
  );
});

test('SCRIPTC_MANIFEST_FILE and declarations file names are the committed contract', () => {
  assert.equal(SCRIPTC_MANIFEST_FILE, 'ffi.json');
  assert.equal(SCRIPTC_DECLARATIONS_FILE, 'scriptc-ffi.d.ts');
});

test('generation is byte-stable across runs (manifest gate parity)', () => {
  const input = { schema: loadCalculatorSchema(), archivePath: '/tmp/target/release/libx.a' };
  assert.deepEqual(generateScriptcArtifacts(input), generateScriptcArtifacts(input));
});

test('empty or package-less schemas fail closed', () => {
  const archive = '/tmp/target/release/libx.a';
  assert.throws(
    () =>
      generateScriptcArtifacts({ schema: { packageId: '', commands: [] }, archivePath: archive }),
    /packageId/,
  );
  assert.throws(
    () =>
      generateScriptcArtifacts({
        schema: { packageId: 'app.empty', commands: [] },
        archivePath: archive,
      }),
    /no commands/,
  );
});

test('retained foreign callbacks have identity-paired release and omit native context from TS', () => {
  const manifest = generateScriptcManifest('/tmp/libx.a');
  const source = renderScriptcDeclarations(manifest, 'app.x');
  assert.ok(
    source.includes(
      'rustra_ffi_channel_create_bytes(receive: (value0: number, value1: Uint8Array) => void): number;',
    ),
  );
  assert.ok(
    source.includes(
      'rustra_ffi_channel_release_scriptc(receive: (value0: number, value1: Uint8Array) => void): void;',
    ),
  );
  assert.ok(
    source.includes(
      'rustra_ffi_event_sink_register_scriptc(onEvent: (value0: string, value1: string) => void): void;',
    ),
  );
  assert.ok(
    source.includes(
      'rustra_ffi_event_sink_release_scriptc(onEvent: (value0: string, value1: string) => void): void;',
    ),
  );
  assert.ok(
    source.includes(
      'rustra_ffi_invoke_json_async_channel(payload: string, channel: number): bigint;',
    ),
  );
  assert.equal(source.includes('context:'), false);
  const releases = manifest.functions.filter((entry) =>
    entry.params.some(
      (param) => typeof param === 'object' && 'callback' in param && 'release' in param.callback,
    ),
  );
  assert.equal(releases.length, 2);
});

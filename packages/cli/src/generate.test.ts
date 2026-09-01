import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  generateTypesTs,
  generateCommandsTs,
  generateContractTs,
  generateRkyvCodecsCpp,
  generateRkyvCodecsHpp,
  generateRkyvCodecsTs,
  generateRkyvRegistryTs,
  generatePositionalFacadeTs,
} from './generate.js';
import { collectDefinitions, postcardHelperSource } from './codegen.js';
import { readConfigSync } from './config.js';
import { buildCodecIr } from './codec-ir.js';
import {
  generateBunEntryTs,
  generateNodeEntryTs,
  generateReactNativeEntryTs,
  generateTauriEntryTs,
  parsePackageSchema,
  renderReactNativeModule,
  renderInitProjectFiles,
  selectCodegenBinary,
  selectReactNativeCargoTarget,
  templateVersions,
  buildGeneratedManifest,
  checkGeneratedFiles,
} from './index.js';
import type { PackageSchema } from './schema.js';
import { parseCodegenArgs, parseGenerateArgs } from './cli-options.js';
import { INIT_CONFIG_SCHEMA_PATH } from './init-template.js';
import { generateFromSchema } from './cli-generate-files.js';

const simpleSchema: PackageSchema = {
  packageId: 'test',
  commands: [
    {
      name: 'add',
      commandId: 1,
      inputType: 'AddInput',
      outputType: 'AddOutput',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'integer' }, b: { type: 'integer' } },
        required: ['a', 'b'],
        title: 'AddInput',
      },
      outputSchema: {
        type: 'object',
        properties: { value: { type: 'integer' } },
        required: ['value'],
        title: 'AddOutput',
      },
    },
  ],
};

test('generateTypesTs re-exports EngineClient and RustraError', () => {
  const types = generateTypesTs(simpleSchema);
  assert.ok(types.includes('EngineClient'));
  assert.ok(types.includes('RustraError'));
  assert.ok(types.includes("from '@rustra/types'"));
});

test('generateTypesTs maps tuple types', () => {
  const schema: PackageSchema = {
    packageId: 'test',
    commands: [
      {
        name: 'pair',
        commandId: 2,
        inputType: 'PairInput',
        outputType: 'PairOutput',
        inputSchema: {
          type: 'object',
          properties: { data: { type: 'array', items: [{ type: 'string' }, { type: 'integer' }] } },
          required: ['data'],
          title: 'PairInput',
        },
        outputSchema: { type: 'object', properties: {}, required: [], title: 'PairOutput' },
      },
    ],
  };
  const types = generateTypesTs(schema);
  assert.ok(types.includes('[string, number]'));
});

test('generateTypesTs maps Record types', () => {
  const schema: PackageSchema = {
    packageId: 'test',
    commands: [
      {
        name: 'lookup',
        commandId: 3,
        inputType: 'LookupInput',
        outputType: 'LookupOutput',
        inputSchema: {
          type: 'object',
          properties: { map: { type: 'object', additionalProperties: { type: 'integer' } } },
          required: ['map'],
          title: 'LookupInput',
        },
        outputSchema: { type: 'object', properties: {}, required: [], title: 'LookupOutput' },
      },
    ],
  };
  const types = generateTypesTs(schema);
  assert.ok(types.includes('Record<string, number>'));
});

test('generateTypesTs maps Set types (uniqueItems)', () => {
  const schema: PackageSchema = {
    packageId: 'test',
    commands: [
      {
        name: 'tags',
        commandId: 4,
        inputType: 'TagsInput',
        outputType: 'TagsOutput',
        inputSchema: {
          type: 'object',
          properties: {
            tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
            values: { type: 'array', items: { type: 'integer' } },
          },
          required: ['tags'],
          title: 'TagsInput',
        },
        outputSchema: { type: 'object', properties: {}, required: [], title: 'TagsOutput' },
      },
    ],
  };
  const types = generateTypesTs(schema);
  assert.ok(types.includes('tags: Set<string>'));
  // uniqueItems 없는 배열은 기존대로 배열 타입 유지 (선택적 필드라 ? 접두사)
  assert.ok(types.includes('values?: number[]'));
});

test('generateTypesTs exposes all byte-buffer runtime representations', () => {
  const schema: PackageSchema = {
    packageId: 'test.bytes',
    commands: [
      {
        name: 'echoBytes',
        commandId: 1,
        inputType: 'BytesInput',
        outputType: 'BytesOutput',
        inputSchema: {
          type: 'object',
          properties: { data: { type: 'array', items: { type: 'integer', format: 'uint8' } } },
          required: ['data'],
        },
        outputSchema: {
          type: 'object',
          properties: { data: { type: 'array', items: { type: 'integer', format: 'uint8' } } },
          required: ['data'],
        },
      },
    ],
  };
  const types = generateTypesTs(schema);
  assert.ok(types.includes('data: Uint8Array | ArrayBuffer | number[]'));
  const commands = generateCommandsTs(schema);
  assert.ok(
    commands.includes('invokeGeneratedBytes<BytesOutput>(1, \'echoBytes\', input, input["data"]'),
  );
  const hpp = generateRkyvCodecsHpp(schema);
  assert.ok(hpp.includes('bool has_buffer_codec(uint16_t cmd_id)'));
  assert.ok(hpp.includes('void encode_buffer_by_id(uint16_t cmd_id'));
  assert.ok(hpp.includes('decode_buffer_result_by_id'));
  const cpp = generateRkyvCodecsCpp(schema);
  assert.ok(cpp.includes('w.push_uvar(size)'));
  assert.ok(cpp.includes('if (size > 0) w.push_bytes(data, size)'));
  assert.ok(cpp.includes('static void encode_pos_echoBytes'));
  assert.ok(cpp.includes('const auto& _v = argv[0]'));
  assert.ok(cpp.includes('w.append_uninitialized(_n)'));
  assert.ok(cpp.includes('static RustraByteSpan rustra_bytes'));
  assert.ok(cpp.includes('BYTES_PER_ELEMENT'));
  assert.ok(cpp.includes('view is outside its ArrayBuffer'));
  assert.ok(cpp.includes('Value decode_buffer_result_by_id'));
  assert.ok(cpp.includes('std::move(buffer)'));
  assert.ok(cpp.includes('r.read_bytes_view((size_t)_n)'));
});

test('direct byte capability fails closed for optional or extra-required fields', () => {
  const schema: PackageSchema = {
    packageId: 'test.bytes.optional',
    commands: [
      {
        name: 'maybeEchoBytes',
        commandId: 1,
        inputType: 'BytesInput',
        outputType: 'BytesOutput',
        inputSchema: {
          type: 'object',
          properties: { data: { type: 'array', items: { type: 'integer', format: 'uint8' } } },
          required: [],
        },
        outputSchema: {
          type: 'object',
          properties: { data: { type: 'array', items: { type: 'integer', format: 'uint8' } } },
          required: ['data', 'ghost'],
        },
      },
    ],
  };

  const commands = generateCommandsTs(schema);
  assert.ok(!commands.includes('invokeGeneratedBytes'));
  const cpp = generateRkyvCodecsCpp(schema);
  const bufferCapability = cpp.slice(
    cpp.indexOf('bool has_buffer_codec'),
    cpp.indexOf('void encode_buffer_by_id'),
  );
  assert.ok(!bufferCapability.includes('case 1: return true;'));
});

test('generateTypesTs emits recursive self-referencing types', () => {
  const nodeSchema: import('./schema.js').JsonSchema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      children: { type: 'array', items: { $ref: '#/definitions/TreeNode' } },
    },
    required: ['name'],
    title: 'TreeNode',
  };
  const schema: PackageSchema = {
    packageId: 'test',
    commands: [
      {
        name: 'depth',
        commandId: 5,
        inputType: 'DepthInput',
        outputType: 'DepthOutput',
        inputSchema: {
          type: 'object',
          properties: { root: { $ref: '#/definitions/TreeNode' } },
          required: ['root'],
          title: 'DepthInput',
          definitions: { TreeNode: nodeSchema },
        },
        outputSchema: { type: 'object', properties: {}, required: [], title: 'DepthOutput' },
      },
    ],
  };
  const types = generateTypesTs(schema);
  assert.ok(types.includes('export type TreeNode = {'));
  // required 에 없는 children 은 선택적 필드가 된다 (self-reference 유지)
  assert.ok(types.includes('children?: TreeNode[]'));
  assert.ok(types.includes('root: TreeNode'));
});

test('collectDefinitions gathers nested definitions recursively', () => {
  // 정의가 루트가 아닌 중첩 위치(definitions 내부의 정의가 또 definitions 를 가짐)에
  // 있어도 재귀적으로 수집한다.
  const leaf: import('./schema.js').JsonSchema = {
    type: 'object',
    properties: { v: { type: 'integer' } },
    title: 'Leaf',
  };
  const schema: import('./schema.js').JsonSchema = {
    type: 'object',
    properties: {},
    definitions: {
      Middle: {
        type: 'object',
        properties: { inner: { $ref: '#/definitions/Leaf' } },
        definitions: { Leaf: leaf },
      },
    },
  };
  const out: Record<string, import('./schema.js').JsonSchema> = {};
  collectDefinitions(schema, out);
  assert.ok(out['Middle'], 'top-level definition collected');
  assert.ok(out['Leaf'], 'nested definition inside another definition collected');
});

test('generateTypesTs maps oneOf with const tags to discriminated unions', () => {
  const schema: PackageSchema = {
    packageId: 'test',
    commands: [
      {
        name: 'area',
        commandId: 6,
        inputType: 'AreaInput',
        outputType: 'AreaOutput',
        inputSchema: {
          type: 'object',
          properties: {
            shape: {
              oneOf: [
                {
                  type: 'object',
                  properties: {
                    kind: { const: 'circle' },
                    radius: { type: 'number' },
                  },
                  required: ['kind', 'radius'],
                },
                {
                  type: 'object',
                  properties: {
                    kind: { const: 'rectangle' },
                    width: { type: 'number' },
                    height: { type: 'number' },
                  },
                  required: ['kind', 'width', 'height'],
                },
              ],
            },
          },
          required: ['shape'],
          title: 'AreaInput',
        },
        outputSchema: { type: 'object', properties: {}, required: [], title: 'AreaOutput' },
      },
    ],
  };
  const types = generateTypesTs(schema);
  // oneOf → union join + const 태그 → 리터럴 판별 필드
  assert.ok(types.includes("kind: 'circle'"));
  assert.ok(types.includes("kind: 'rectangle'"));
  assert.ok(types.includes('|'));
});

test('generateCommandsTs produces command function', () => {
  const commands = generateCommandsTs(simpleSchema);
  assert.ok(commands.includes('export const add = createGeneratedFields2<AddInput, AddOutput>'));
  assert.ok(commands.includes('(1, \'add\', "a", "b", \'add\')'));
  assert.ok(commands.includes('createGeneratedFields2'));
  assert.ok(commands.includes("import type { InvokeOptions } from '@rustra/types'"));
});

test('generateCommandsTs keeps complex inputs on the generic route', () => {
  const commands = generateCommandsTs(cppSchema);
  const sumList = commands.split('export function sumList')[1] ?? '';
  assert.ok(sumList.includes("invokeGenerated<SumListOutput>(6, 'sumList', input, options)"));
});

test('generateCommandsTs handles void input and JSDoc description', () => {
  const schema: PackageSchema = {
    packageId: 'test.pkg',
    commands: [
      {
        name: 'ping',
        commandId: 1,
        inputType: '()',
        outputType: '()',
        inputSchema: { description: 'Pings the server' },
        outputSchema: {},
      },
    ],
  };

  const commands = generateCommandsTs(schema);
  assert.ok(commands.includes('/**\n * Pings the server\n */'));
  assert.ok(commands.includes('export function ping(options?: InvokeOptions): Promise<void>'));
  assert.ok(commands.includes("invokeGenerated<void>(1, 'ping', undefined, options)"));
});

test('generateTypesTs emits JSDoc comments from schema description', () => {
  const schema: PackageSchema = {
    packageId: 'test.pkg',
    commands: [
      {
        name: 'getItem',
        commandId: 1,
        inputType: 'GetItemInput',
        outputType: 'GetItemOutput',
        inputSchema: {
          type: 'object',
          description: 'Input for getting item',
          properties: {
            id: { type: 'string', description: 'Unique identifier' },
          },
        },
        outputSchema: {
          type: 'object',
        },
      },
    ],
  };

  const types = generateTypesTs(schema);
  assert.ok(types.includes('/**\n * Input for getting item\n */'));
  assert.ok(types.includes('/** Unique identifier */'));
});

test('generated TypeScript has clean JSDoc blank lines and one final newline', () => {
  const schema: PackageSchema = {
    ...simpleSchema,
    commands: [
      {
        ...simpleSchema.commands[0]!,
        inputSchema: {
          ...simpleSchema.commands[0]!.inputSchema,
          description: 'Adds two values.\n\nUsed by every host.',
        },
      },
    ],
  };

  for (const generated of [
    generateTypesTs(schema),
    generateCommandsTs(schema),
    generateRkyvCodecsTs(schema),
  ]) {
    assert.doesNotMatch(generated, /[ \t]+\n/u);
    assert.ok(generated.endsWith('\n'));
    assert.ok(!generated.endsWith('\n\n'));
  }
  assert.match(generateTypesTs(schema), /\* Adds two values\.\n \*\n \* Used by every host\./u);
});

test('generateContractTs produces hash constant', () => {
  const contract = generateContractTs('{"test": true}');
  assert.ok(contract.includes('GENERATED_CONTRACT_HASH'));
  assert.ok(contract.includes("'"));
  // schemaVersion 필드가 없는 구 스키마는 1 로 취급한다.
  assert.ok(contract.includes('SCHEMA_VERSION = 1;'));
});

test('generateContractTs exports schemaVersion from the schema', () => {
  const contract = generateContractTs(
    '{"packageId": "ota.ver", "schemaVersion": 7, "commands": []}',
  );
  assert.ok(contract.includes('GENERATED_CONTRACT_HASH'));
  assert.ok(contract.includes('SCHEMA_VERSION = 7;'));
  // Rust 코드젠(GeneratedPackage::contract_ts)과 동일한 형식이어야 한다.
  assert.ok(contract.endsWith('export const SCHEMA_VERSION = 7;\n'));
});

// ── C++ codec generation (B1) ──────────────────────────────

/** 모든 postcard 필드 종류(zigzag/f64/bool/string/vec/struct)를 커버하는 스키마. */
const cppSchema: PackageSchema = {
  packageId: 'test.cpp',
  commands: [
    {
      name: 'createItem',
      commandId: 8,
      inputType: 'CreateItemInput',
      outputType: 'CreateItemOutput',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, value: { type: 'integer' } },
        required: ['name', 'value'],
        title: 'CreateItemInput',
      },
      outputSchema: {
        type: 'object',
        properties: { item: { $ref: '#/definitions/Item' } },
        required: ['item'],
        title: 'CreateItemOutput',
        definitions: {
          Item: {
            type: 'object',
            properties: {
              active: { type: 'boolean' },
              name: { type: 'string' },
              value: { type: 'integer' },
            },
            required: ['active', 'name', 'value'],
            title: 'Item',
          },
        },
      },
    },
    {
      name: 'sumList',
      commandId: 6,
      inputType: 'SumListInput',
      outputType: 'SumListOutput',
      inputSchema: {
        type: 'object',
        properties: { numbers: { type: 'array', items: { type: 'integer' } } },
        required: ['numbers'],
        title: 'SumListInput',
      },
      outputSchema: {
        type: 'object',
        properties: { count: { type: 'integer' }, total: { type: 'integer' } },
        required: ['count', 'total'],
        title: 'SumListOutput',
      },
    },
    {
      name: 'scale',
      commandId: 10,
      inputType: 'ScaleInput',
      outputType: 'ScaleOutput',
      inputSchema: {
        type: 'object',
        properties: { values: { type: 'array', items: { type: 'number' } } },
        required: ['values'],
        title: 'ScaleInput',
      },
      outputSchema: {
        type: 'object',
        properties: { doubled: { type: 'array', items: { type: 'number' } } },
        required: ['doubled'],
        title: 'ScaleOutput',
      },
    },
  ],
};

test('generateRkyvCodecsHpp declares dispatch API', () => {
  const hpp = generateRkyvCodecsHpp(cppSchema);
  assert.ok(hpp.includes('#pragma once'));
  assert.ok(hpp.includes('namespace rustra::generated'));
  assert.ok(hpp.includes('bool encode_by_name('));
  assert.ok(hpp.includes('Value decode_by_name('));
  assert.ok(hpp.includes('bool has_static_codec('));
  assert.ok(hpp.includes('bool has_static_codec_id('));
  assert.ok(hpp.includes('bool has_raw_codec('));
  assert.ok(hpp.includes('void encode_raw_slots('));
  assert.ok(hpp.includes('Value decode_raw_result('));
  assert.ok(hpp.includes('#include "rustra-codec.hpp"'));
  // P0-3: by_id 진입(invokeTypedById)용 선언도 방출한다.
  assert.ok(hpp.includes('bool encode_by_id('));
  assert.ok(hpp.includes('Value decode_by_id('));
  assert.ok(hpp.includes('uint16_t cmd_id'));
});

test('generateRkyvCodecsCpp emits per-command encode/decode + dispatch', () => {
  const cpp = generateRkyvCodecsCpp(cppSchema);

  // per-command encode/decode (lowerCamelCase 함수명)
  assert.ok(cpp.includes('static void encode_createItem('));
  assert.ok(cpp.includes('static jsi::Value decode_createItem('));
  assert.ok(cpp.includes('static void encode_sumList('));
  assert.ok(cpp.includes('static jsi::Value decode_sumList('));

  // dispatch 테이블이 양쪽 명령을 모두 라우팅
  assert.ok(cpp.includes('if (name == "createItem") { encode_createItem'));
  assert.ok(cpp.includes('if (name == "createItem") return decode_createItem'));
  assert.ok(cpp.includes('if (name == "sumList") { encode_sumList'));
  assert.ok(cpp.includes('return false; // 동적 명령'));

  // cmd_id LE 바이트가 encode 본문에 직접 방출 (createItem=8 → 0x08, 0x00)
  assert.ok(cpp.includes('w.push_u8(8); w.push_u8(0);'));
  assert.ok(cpp.includes('w.push_u8(6); w.push_u8(0);'));
});

test('generateRkyvCodecsCpp assigns tuple decode values to array slots', () => {
  const schema: PackageSchema = {
    packageId: 'test.tuple.cpp',
    commands: [
      {
        name: 'pair',
        commandId: 9,
        inputType: 'PairInput',
        outputType: 'PairOutput',
        inputSchema: {
          type: 'object',
          properties: { left: { type: 'string' }, right: { type: 'integer' } },
          required: ['left', 'right'],
          title: 'PairInput',
        },
        outputSchema: {
          type: 'object',
          properties: {
            pair: {
              type: 'array',
              minItems: 2,
              maxItems: 2,
              items: [{ type: 'string' }, { type: 'integer' }],
            },
          },
          required: ['pair'],
          title: 'PairOutput',
        },
      },
    ],
  };

  const cpp = generateRkyvCodecsCpp(schema);
  assert.ok(cpp.includes('static jsi::Value decode_pair'));
  assert.ok(cpp.includes('_arr.setValueAtIndex(rt, 0'));
  assert.ok(cpp.includes('_arr.setValueAtIndex(rt, 1'));
  assert.ok(!cpp.includes('_arr_tmp_0'));
  assert.ok(!cpp.includes('_arr_tmp_1'));
});

test('generateRkyvCodecsCpp binds PropNameID cache lifetime to its JSI Runtime', () => {
  const hpp = generateRkyvCodecsHpp(cppSchema);
  const cpp = generateRkyvCodecsCpp(cppSchema);

  assert.ok(cpp.includes('class RuntimePropNameCache final : public jsi::NativeState'));
  assert.ok(cpp.includes('std::weak_ptr<RuntimePropNameCache>'));
  assert.ok(cpp.includes('holder.setNativeState(rt, cache)'));
  assert.ok(cpp.includes('rt.global().setProperty(rt, "__rustraPropNameCache"'));
  assert.ok(!cpp.includes('void resetPropNameCache()'));
  assert.ok(!hpp.includes('void resetPropNameCache()'));
});

test('generateRkyvCodecsCpp emits by_id switch dispatch (P0-3)', () => {
  const cpp = generateRkyvCodecsCpp(cppSchema);

  // switch 기반 by_id 디스패치 — per-command 함수를 cmd_id 케이스로 재사용
  assert.ok(
    cpp.includes(
      'bool encode_by_id(Runtime& rt, uint16_t cmd_id, const Value& args, rc::Writer& w)',
    ),
  );
  assert.ok(cpp.includes('Value decode_by_id(Runtime& rt, uint16_t cmd_id, rc::Reader& r)'));
  assert.ok(cpp.includes('case 8: encode_createItem(rt, args, w); return true;'));
  assert.ok(cpp.includes('case 6: encode_sumList(rt, args, w); return true;'));
  assert.ok(cpp.includes('case 8: return decode_createItem(rt, r);'));
  assert.ok(cpp.includes('case 6: return decode_sumList(rt, r);'));
  // 미발견 분기: encode 는 false, decode 는 throw (by_name 과 동일 계약)
  assert.ok(cpp.includes('default: return false; // 동적/알 수 없는 cmd_id'));
  assert.ok(cpp.includes('std::to_string(cmd_id)'));
});

test('generateRkyvCodecsCpp emits raw capability and public result-shape restoration', () => {
  const cpp = generateRkyvCodecsCpp(simpleSchema);
  assert.ok(cpp.includes('bool has_raw_codec(uint16_t cmd_id)'));
  assert.ok(cpp.includes('case 1: return true;'));
  assert.ok(cpp.includes('void encode_raw_slots(Runtime& rt, uint16_t cmd_id'));
  assert.ok(cpp.includes('int64_t value = rustra_i64(rt, argv[0], "a")'));
  assert.ok(cpp.includes('Value decode_raw_result(Runtime& rt, uint16_t cmd_id, uint64_t slot)'));
  assert.ok(cpp.includes('int64_t value; std::memcpy(&value, &slot, sizeof(value));'));
  assert.ok(cpp.includes('cachedProp(rt, "value")'));
  assert.ok(cpp.includes('return std::move(result);'));
});

test('generateRkyvCodecsCpp maps each postcard field kind to the right push/read', () => {
  const cpp = generateRkyvCodecsCpp(cppSchema);

  // integer → safe-integer 검증 후 push_i64 / read_i64
  assert.ok(cpp.includes('w.push_i64(rustra_i64(rt,'));
  assert.ok(cpp.includes('must be a safe integer'));
  assert.ok(cpp.includes('(double)r.read_i64()'));
  // string → push_string / createFromUtf8
  assert.ok(cpp.includes('w.push_string(_v);'));
  assert.ok(cpp.includes('jsi::String::createFromUtf8'));
  // bool (출력 Item.active → decode read_bool; encode 경로는 입력에 bool 이 없으므로 제외)
  assert.ok(cpp.includes('r.read_bool()'));
  // vec (varint 길이 + 루프)
  assert.ok(cpp.includes('w.push_uvar(_n);'));
  assert.ok(cpp.includes('jsi::Array(rt, (size_t)_n);'));
  // 중첩 struct (Item) → 보조 Object 조립
  assert.ok(cpp.includes('auto _obj = jsi::Object(rt);'));
});

test('generateRkyvCodecsCpp is pure C++ (no TS leakage)', () => {
  const cpp = generateRkyvCodecsCpp(cppSchema);
  assert.ok(!cpp.includes('Uint8Array'));
  assert.ok(!cpp.includes('DataView'));
  assert.ok(!cpp.includes('TextEncoder'));
  assert.ok(!cpp.includes('from ./'));
});

// ── Option/Vec<String>/Vec<Struct>/enum 코덱 지원 + 미지원 제외 정책 ─────

const richSchema: PackageSchema = {
  packageId: 'test.rich',
  commands: [
    {
      name: 'updateItem',
      commandId: 4,
      inputType: 'UpdateItemInput',
      outputType: 'UpdateItemOutput',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: ['string', 'null'] },
          value: { type: ['integer', 'null'] },
        },
        required: ['id'],
        title: 'UpdateItemInput',
      },
      outputSchema: {
        type: 'object',
        properties: { item: { anyOf: [{ $ref: '#/definitions/Item' }, { type: 'null' }] } },
        title: 'UpdateItemOutput',
        definitions: {
          Item: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              value: { type: 'integer' },
            },
            required: ['id', 'name', 'value'],
            title: 'Item',
          },
        },
      },
    },
    {
      name: 'listItems',
      commandId: 5,
      inputType: 'ListInput',
      outputType: 'ListOutput',
      inputSchema: {
        type: 'object',
        properties: { tags: { type: 'array', items: { type: 'string' } } },
        required: ['tags'],
        title: 'ListInput',
      },
      outputSchema: {
        type: 'object',
        properties: { items: { type: 'array', items: { $ref: '#/definitions/Item2' } } },
        required: ['items'],
        title: 'ListOutput',
        definitions: {
          Item2: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            title: 'Item2',
          },
        },
      },
    },
    {
      name: 'sortBy',
      commandId: 6,
      inputType: 'SortInput',
      outputType: 'SortOutput',
      inputSchema: {
        type: 'object',
        properties: { order: { type: 'string', enum: ['asc', 'desc'] } },
        required: ['order'],
        title: 'SortInput',
      },
      outputSchema: {
        type: 'object',
        properties: { done: { type: 'boolean' } },
        required: ['done'],
        title: 'SortOutput',
      },
    },
    {
      name: 'mapScores',
      commandId: 7,
      inputType: 'MapInput',
      outputType: 'MapOutput',
      inputSchema: {
        type: 'object',
        properties: {
          scores: { type: 'object', additionalProperties: { type: 'integer' } },
        },
        required: ['scores'],
        title: 'MapInput',
      },
      outputSchema: {
        type: 'object',
        properties: { total: { type: 'integer' } },
        required: ['total'],
        title: 'MapOutput',
      },
    },
    {
      name: 'unsupportedNestedMap',
      commandId: 8,
      inputType: 'NestedMapInput',
      outputType: 'NestedMapOutput',
      inputSchema: {
        type: 'object',
        properties: {
          groups: {
            type: 'object',
            additionalProperties: { type: 'array', items: { type: 'string' } },
          },
        },
        required: ['groups'],
        title: 'NestedMapInput',
      },
      outputSchema: {
        type: 'object',
        properties: { count: { type: 'integer' } },
        required: ['count'],
        title: 'NestedMapOutput',
      },
    },
  ],
};

test('generateTypesTs maps allOf to intersection and integer enum to literal union', () => {
  const schema: PackageSchema = {
    packageId: 'test.allof',
    commands: [
      {
        name: 'merge',
        commandId: 1,
        inputType: 'MergeInput',
        outputType: 'MergeOutput',
        inputSchema: {
          type: 'object',
          properties: {
            both: { allOf: [{ $ref: '#/definitions/A' }, { $ref: '#/definitions/B' }] },
            level: { type: 'integer', enum: [1, 2, 3] },
          },
          required: ['both', 'level'],
          title: 'MergeInput',
          definitions: {
            A: { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'] },
            B: { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] },
          },
        },
        outputSchema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          title: 'MergeOutput',
        },
      },
    ],
  };
  const types = generateTypesTs(schema);
  assert.ok(
    types.includes('both: A & B;'),
    `allOf must map to intersection, got: ${types.slice(0, 400)}`,
  );
  assert.ok(types.includes('level: 1 | 2 | 3;'), 'integer enum must map to literal union');
});

test('generateTypesTs exposes bigint for int64 and C++ joins with BigInt decode', () => {
  const schema: PackageSchema = {
    packageId: 'wide-integer',
    commands: [
      {
        name: 'readCounter',
        commandId: 31,
        inputType: 'CounterInput',
        outputType: 'CounterOutput',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'integer', format: 'int64' } },
          required: ['value'],
        },
        outputSchema: {
          type: 'object',
          properties: { value: { type: 'integer', format: 'uint64' } },
          required: ['value'],
        },
      },
    ],
  };
  assert.match(generateTypesTs(schema), /value: number \| bigint;/);
  // B1: C++ 정적 코덱도 와이드 정수를 직접 처리한다 — 광고 제외 해제.
  assert.match(generateRkyvCodecsCpp(schema), /readCounter/);
  assert.match(generateRkyvRegistryTs(schema), /\['readCounter', readCounterCodec\]/);
});

test('int64/uint64 fields join the postcard fast path with 64-bit helpers', () => {
  const schema: PackageSchema = {
    packageId: 'wide-fast-path',
    fieldOrder: 'declaration',
    commands: [
      {
        name: 'readCounter',
        commandId: 31,
        inputType: 'CounterInput',
        outputType: 'CounterOutput',
        inputSchema: {
          type: 'object',
          properties: {
            value: { type: 'integer', format: 'int64' },
            offset: { type: 'integer', format: 'uint64' },
          },
          required: ['value', 'offset'],
        },
        outputSchema: {
          type: 'object',
          properties: { value: { type: 'integer', format: 'uint64' } },
          required: ['value'],
        },
      },
    ],
  };

  const codecs = generateRkyvCodecsTs(schema);
  const registry = generateRkyvRegistryTs(schema);

  // 와이드 정수 필드가 64-bit 헬퍼로 emit 된다(zigzag64 → _pcEncodeZigzag64,
  // uvar64 → _pcEncodeVarint64).
  assert.match(codecs, /_pcEncodeZigzag64\(args\.value\)/);
  assert.match(codecs, /_pcEncodeVarint64\(args\.offset\)/);
  assert.match(codecs, /_pcDecodeVarint64\(u8, offset\)/);
  // complex 폴백이 아니라 postcard fast-path 코덱 그 자체가 된다.
  assert.doesNotMatch(codecs, /createComplexCodec<CounterInput/);
  assert.match(registry, /route: postcard/);
  assert.doesNotMatch(registry, /route: complex/);
  // B1: C++ 정적 코덱도 64-bit 헬퍼(push_i64/push_uvar)로 와이드 정수를 emit.
  const cpp = generateRkyvCodecsCpp(schema);
  assert.match(cpp, /readCounter/);
  assert.match(
    cpp,
    /w\.push_i64\(rustra_i64\(rt, argsObj\.getProperty\(rt, "value"\), "value"\)\)/,
  );
  assert.match(
    cpp,
    /w\.push_uvar\(rustra_u64\(rt, argsObj\.getProperty\(rt, "offset"\), "offset"\)\)/,
  );
});

test('generateRkyvCodecsTs encodes Option fields (no silent drop)', () => {
  const codecs = generateRkyvCodecsTs(richSchema);
  const update = codecs.split('updateItemCodec')[1];
  assert.ok(update.includes('args.name'), 'Option<string> name must be encoded');
  assert.ok(update.includes('args.value'), 'Option<i64> value must be encoded');
  // Option 태그 바이트(0/1) 분기 생성 확인
  assert.ok(update.includes('new Uint8Array([0])'));
  assert.ok(update.includes('new Uint8Array([1])'));
});

test('generateRkyvCodecsTs encodes Vec<String> and Vec<Struct>', () => {
  const codecs = generateRkyvCodecsTs(richSchema);
  const list = codecs.split('listItemsCodec')[1].split('export const')[0];
  assert.ok(list.includes('args.tags'), 'Vec<String> tags must be encoded');
  assert.ok(
    list.includes('_pcEncodeString(_arr[_i])'),
    'Vec<String> elements must be string-encoded',
  );
  assert.ok(list.includes('result.items'), 'Vec<Struct> items must be decoded');
});

test('generateRkyvCodecsTs encodes string enums as variant index', () => {
  const codecs = generateRkyvCodecsTs(richSchema);
  const sort = codecs.split('sortByCodec')[1].split('export const')[0];
  assert.ok(sort.includes('["asc","desc"]'), 'enum variants must be embedded');
  assert.ok(sort.includes('_variants.indexOf'), 'enum index lookup must be generated');
});

test('generateRkyvCodecsTs encodes primitive-valued dynamic maps deterministically', () => {
  const codecs = generateRkyvCodecsTs(richSchema);
  const map = codecs.split('mapScoresCodec')[1].split('export const')[0];
  assert.ok(map.includes('const _map = args.scores'));
  assert.ok(map.includes('Object.keys(_map).sort()'));
  assert.ok(map.includes('_pcEncodeString(_k)'));
  assert.ok(map.includes('result.total'));
});

test('generateRkyvCodecsTs promotes complex maps and data enums to the complex codec', () => {
  const schema: PackageSchema = {
    packageId: 'complex.codec',
    commands: [
      {
        name: 'process',
        commandId: 17,
        inputType: 'ProcessInput',
        outputType: 'ProcessOutput',
        inputSchema: {
          type: 'object',
          properties: {
            profiles: { type: 'object', additionalProperties: { $ref: '#/definitions/Profile' } },
            status: {
              oneOf: [
                {
                  type: 'object',
                  properties: {
                    Active: {
                      type: 'object',
                      properties: { level: { type: 'integer' } },
                      required: ['level'],
                    },
                  },
                  required: ['Active'],
                  additionalProperties: false,
                },
                { type: 'string', enum: ['Idle'] },
              ],
            },
          },
          required: ['profiles', 'status'],
        },
        outputSchema: {
          type: 'object',
          properties: { accepted: { type: 'boolean' } },
          required: ['accepted'],
        },
        definitions: {
          Profile: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
      },
    ],
  };
  const codecs = generateRkyvCodecsTs(schema);
  const registry = generateRkyvRegistryTs(schema);
  assert.match(codecs, /createComplexCodec/);
  assert.match(codecs, /processComplexCodec/);
  assert.match(codecs, /export const processCodec = processComplexCodec/);
  assert.match(registry, /processComplexCodec/);
  assert.match(registry, /route: complex/);
});

test('generateRkyvRegistryTs routes supported complex commands to the complex codec', () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => warnings.push(String(message));
  let registry: string;
  try {
    registry = generateRkyvRegistryTs(richSchema);
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(registry.includes("['updateItem'"), 'Option commands must be included');
  assert.ok(registry.includes("['sortBy'"), 'enum commands must be included');
  assert.ok(registry.includes("['listItems'"), 'Vec<Struct> commands must be included');
  assert.ok(registry.includes("['mapScores'"), 'primitive-valued map commands must be included');
  assert.ok(
    registry.includes("['unsupportedNestedMap', unsupportedNestedMapComplexCodec]"),
    'nested collection map commands must use the complex codec',
  );
  assert.equal(warnings.length, 0, 'supported complex commands must not warn or fall back');
});

test('ambiguous oneOf schemas stay on the Tier 3 fallback', () => {
  const schema: PackageSchema = {
    packageId: 'complex.ambiguous-union',
    commands: [
      {
        name: 'choose',
        commandId: 1,
        inputType: 'ChooseInput',
        outputType: 'ChooseOutput',
        inputSchema: {
          oneOf: [{ type: 'string' }, { type: 'integer' }],
        },
        outputSchema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
      },
    ],
  };
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => warnings.push(String(message));
  let registry: string;
  try {
    registry = generateRkyvRegistryTs(schema);
  } finally {
    console.warn = originalWarn;
  }
  assert.doesNotMatch(registry, /chooseCodec/);
  assert.match(warnings[0] ?? '', /unsupported by both/);
});

test('codec IR accepts explicit oneOf keys for anonymous variants and sorts wire order', () => {
  const result = buildCodecIr(
    {
      oneOf: [{ type: 'string' }, { type: 'integer' }],
      'x-rustra-variant-order': ['text', 'count'],
    },
    {},
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.node.kind, 'oneOf');
    if (result.node.kind === 'oneOf') {
      assert.deepEqual(
        result.node.variants.map((variant) => variant.key),
        ['count', 'text'],
      );
    }
  }
});

test('single-entry allOf newtype handles stay on the postcard fast path', () => {
  const schema: PackageSchema = {
    packageId: 'handles',
    fieldOrder: 'declaration',
    commands: [
      {
        name: 'sendChannel',
        commandId: 1,
        inputType: 'SendChannelInput',
        outputType: 'SendChannelOutput',
        inputSchema: {
          type: 'object',
          required: ['channel', 'label'],
          properties: {
            channel: { allOf: [{ $ref: '#/definitions/ChannelHandle' }] },
            label: { type: 'string' },
          },
        },
        outputSchema: {
          type: 'object',
          required: ['sent'],
          properties: { sent: { type: 'boolean' } },
        },
        definitions: {
          ChannelHandle: { type: 'integer', format: 'uint32', minimum: 0 },
        },
      },
    ],
  };

  const registry = generateRkyvRegistryTs(schema);
  const codecs = generateRkyvCodecsTs(schema);
  const commands = generateCommandsTs(schema);
  assert.match(registry, /\['sendChannel', sendChannelCodec\]/);
  assert.match(codecs, /_pcEncodeVarint\(args\.channel\)/);
  assert.ok(
    commands.includes(
      'createGeneratedFields2<SendChannelInput, SendChannelOutput>(1, \'sendChannel\', "channel", "label", \'sendChannel\')',
    ),
  );
});

test('generateRkyvCodecsCpp promotes supported complex commands to native static codec', () => {
  const cpp = generateRkyvCodecsCpp(richSchema);
  assert.ok(cpp.includes('if (name == "updateItem") { encode_updateItem'));
  assert.ok(cpp.includes('if (name == "mapScores") { encode_mapScores'));
  assert.ok(
    cpp.includes('if (name == "unsupportedNestedMap") { encode_complex_unsupportedNestedMap'),
    'supported nested map command must use the native complex codec',
  );
});

test('generateRkyvCodecsCpp promotes primitive-element Sets to the native complex codec', () => {
  const schema: PackageSchema = {
    packageId: 'native-complex-boundaries',
    commands: [
      {
        name: 'setValues',
        commandId: 21,
        inputType: 'SetInput',
        outputType: 'SetOutput',
        inputSchema: {
          type: 'object',
          properties: { values: { type: 'array', items: { type: 'integer' }, uniqueItems: true } },
          required: ['values'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            uniques: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          },
          required: ['ok', 'uniques'],
        },
      },
      {
        name: 'wideValue',
        commandId: 22,
        inputType: 'WideInput',
        outputType: 'WideOutput',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'integer', format: 'uint64' } },
          required: ['value'],
        },
        outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      },
    ],
  };
  const cpp = generateRkyvCodecsCpp(schema);
  const registry = generateRkyvRegistryTs(schema);
  // B2: 원시 요소 Set 은 C++ complex 경로로 직결 — Set 안의 정수는 순서 보존
  // postcard seq 로 인코딩하고 디코드는 전역 Set 생성자로 복원한다(TS
  // complex-codec 계약 동일: [...set] 순서 보존 encode, new Set(values) decode).
  assert.match(cpp, /encode_complex_setValues/);
  // encode: 전역 Array.from 로 이터레이션 순서 보존 복사. 실제 jsi 는 Value
  // 복사가 삭제돼 initializer_list/배열 전달이 컴파일에 실패한다(RN Pods 빌드
  // 게이트) — move-wrapped rvalue 1개로 가변 템플릿에 흘려보낸다.
  assert.match(cpp, /instanceOf\(rt, rt\.global\(\)\.getPropertyAsFunction\(rt, "Set"\)\)/);
  assert.match(cpp, /getPropertyAsFunction\(rt, "Array"\)\.getPropertyAsFunction\(rt, "from"\)/);
  assert.match(cpp, /\.call\(rt, jsi::Value\(rt, \w+\)\)/);
  assert.doesNotMatch(cpp, /callAsFunction/);
  assert.doesNotMatch(cpp, /\.call\(rt, \{ /);
  // decode: 전역 Set 생성자 — callAsConstructor 도 move-wrapped rvalue 로.
  assert.match(cpp, /callAsConstructor\(rt, jsi::Value\(rt, _cx\d+\)\)/);
  assert.doesNotMatch(cpp, /_setArgs/);
  // wideValue 는 B1 이후 C++ 정적 postcard 코덱 소속.
  assert.match(cpp, /wideValue/);
  // Set 명령도 registry 에는 complex 코덱이 그대로 남는다(non-typed 호스트용).
  assert.match(registry, /setValuesComplexCodec/);
  assert.match(registry, /\['wideValue', wideValueCodec\]/);
  assert.doesNotMatch(registry, /wideValueComplexCodec/);
});

test('generateRkyvCodecsCpp keeps object-element Sets on the JS complex route', () => {
  const schema: PackageSchema = {
    packageId: 'native-complex-object-set',
    commands: [
      {
        name: 'objectSet',
        commandId: 24,
        inputType: 'ObjectSetInput',
        outputType: 'ObjectSetOutput',
        inputSchema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name'],
              },
              uniqueItems: true,
            },
          },
          required: ['items'],
        },
        outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      },
    ],
  };
  const cpp = generateRkyvCodecsCpp(schema);
  const registry = generateRkyvRegistryTs(schema);
  // 객체 요소 Set 은 IR 정규화 한계로 여전히 JS complex 경로 소속이다.
  assert.doesNotMatch(cpp, /encode_complex_objectSet/);
  assert.match(registry, /objectSetComplexCodec/);
});

test('generateRkyvCodecsCpp promotes wide-int complex commands with BigInt safe-range decode', () => {
  const schema: PackageSchema = {
    packageId: 'cpp-bigint-complex',
    commands: [
      {
        name: 'wideAgg',
        commandId: 40,
        inputType: 'WideAggInput',
        outputType: 'WideAggOutput',
        inputSchema: {
          type: 'object',
          properties: {
            samples: { type: 'array', items: { type: 'integer', format: 'uint64' } },
            offset: { type: ['integer', 'null'], format: 'int64' },
          },
          required: ['samples'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            adjusted: { type: 'integer', format: 'int64' },
            max: { type: 'integer', format: 'uint64' },
          },
          required: ['adjusted', 'max'],
        },
      },
    ],
  };
  const cpp = generateRkyvCodecsCpp(schema);
  // 광고 — 정적 postcard 코덱 승격(A2 이후 와이드 정수는 fast-path 소속).
  assert.match(cpp, /name == "wideAgg"/);
  assert.match(cpp, /static void encode_wideAgg/);
  // uint64 디코드: safe 범위면 number, 아니면 jsi::BigInt::fromUint64.
  assert.match(
    cpp,
    /read_uvar\(\); if \(_v <= 9007199254740991ull\) return jsi::Value\(static_cast<double>\(_v\)\); return jsi::Value\(rt, jsi::BigInt::fromUint64\(rt, _v\)\)/,
  );
  // int64 디코드: safe 범위면 number, 아니면 jsi::BigInt::fromInt64.
  assert.match(
    cpp,
    /read_i64\(\); if \(_v >= -9007199254740991ll && _v <= 9007199254740991ll\) return jsi::Value\(static_cast<double>\(_v\)\); return jsi::Value\(rt, jsi::BigInt::fromInt64\(rt, _v\)\)/,
  );
  // encode 는 확장된 validator 로 bigint 를 받는다.
  assert.match(cpp, /value\.isBigInt\(\)/);
  assert.match(cpp, /asBigInt\(rt\)\.asUint64\(rt\)/);
  assert.match(cpp, /asBigInt\(rt\)\.asInt64\(rt\)/);
});

test('generateRkyvCodecsCpp emits bounded recursive reference functions', () => {
  const schema: PackageSchema = {
    packageId: 'recursive-native-complex',
    commands: [
      {
        name: 'walk',
        commandId: 23,
        inputType: 'WalkInput',
        outputType: 'WalkOutput',
        inputSchema: {
          type: 'object',
          properties: { node: { $ref: '#/definitions/Node' } },
          required: ['node'],
        },
        outputSchema: {
          type: 'object',
          properties: { node: { $ref: '#/definitions/Node' } },
          required: ['node'],
        },
        definitions: {
          Node: {
            type: 'object',
            properties: {
              value: { type: 'integer' },
              next: { anyOf: [{ $ref: '#/definitions/Node' }, { type: 'null' }] },
            },
            required: ['value', 'next'],
          },
        },
      },
    ],
  };
  const cpp = generateRkyvCodecsCpp(schema);
  assert.match(cpp, /complex_encode_ref_Node/);
  assert.match(cpp, /complex_decode_ref_Node/);
  assert.match(cpp, /complex value depth exceeds 32/);
  assert.match(cpp, /encode_complex_walk/);
});

test('generateRkyvCodecsCpp positional codecs enforce arity and preserve enum wire', () => {
  const cpp = generateRkyvCodecsCpp(richSchema);
  const sort = cpp.split('static void encode_pos_sortBy')[1]?.split('static ')[0] ?? '';
  assert.ok(sort.includes('if (argc != 1)'), 'positional codec must reject missing/extra argv');
  assert.ok(sort.includes('const char* _variants[] = {"asc","desc"}'));
  assert.ok(sort.includes('w.push_uvar((uint32_t)_idx)'), 'enum must encode variant index');
  assert.ok(!sort.includes('w.push_string(_s)'), 'enum must not use string postcard wire');
});

test('generateRkyvCodecsCpp positional f32 uses four-byte postcard wire', () => {
  const schema: PackageSchema = {
    packageId: 'test.f32',
    commands: [
      {
        name: 'scaleFloat',
        commandId: 19,
        inputType: 'ScaleFloatInput',
        outputType: 'ScaleFloatOutput',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'number', format: 'float' } },
          required: ['value'],
        },
        outputSchema: {
          type: 'object',
          properties: { value: { type: 'number', format: 'float' } },
          required: ['value'],
        },
      },
    ],
  };
  const cpp = generateRkyvCodecsCpp(schema);
  const positional = cpp.split('static void encode_pos_scaleFloat')[1]?.split('static ')[0] ?? '';
  assert.ok(positional.includes('w.push_f32(rustra_f32(rt, argv[0], "value"))'));
  assert.ok(!positional.includes('w.push_f64'));
});

test('generateRkyvCodecsCpp validates numeric inputs before native casts', () => {
  const cpp = generateRkyvCodecsCpp(cppSchema);
  assert.ok(cpp.includes('std::isfinite(number)'));
  assert.ok(cpp.includes('std::trunc(number) != number'));
  assert.ok(cpp.includes('number < 0.0 || number > maxSafe'));
  assert.ok(cpp.includes('number >= 0.0 && number <= 255.0'));
  assert.ok(cpp.includes('must be an integer in 0..255'));
  assert.ok(!cpp.includes('(int64_t)_v'));
});

// ── positional facade (P2) ──────────────────────────────────

test('generatePositionalFacadeTs emits positional signatures for simple commands', () => {
  const facade = generatePositionalFacadeTs(richSchema);
  // updateItem — Option 필드지만 pass-through 가능(단일 input 객체) 확인
  assert.ok(facade.includes('installRustraPositional'), 'installer must be exported');
  assert.ok(facade.includes('PositionalNative'), 'native type must be exported');
  // sortBy (enum, 단일 필드) → positional — Tier 1 부턴 callPos(cmdId, …) 로
  // 이름 문자열 대신 cmd_id 가 전달된다.
  const sort = facade.split('export function sortBy')[1]?.split('export function')[0] ?? '';
  assert.ok(sort.includes('order: string'), 'enum field must map to string param');
  assert.ok(sort.includes('callPos<'), 'positional entry (invokeTypedPos) must be used');
  // 중첩 collection map 은 제외
  assert.ok(!facade.includes('unsupportedNestedMap'), 'unsupported commands must be excluded');
});

test('generatePositionalFacadeTs uses positional params for ≤3 primitive fields', () => {
  const facade = generatePositionalFacadeTs(simpleSchema);
  assert.ok(
    facade.includes('export function add(a: number, b: number,'),
    'simple 2-field command must be positional',
  );
});

test('facade callPos command set exactly matches C++ positional codec set', () => {
  // 회귀 가드: facade와 C++ 코드젠의 positional kind 세트가 어긋나면
  // facade가 callPos 로 노출한 명령이 C++ encode_pos_by_id 에 없어
  // 런타임 JSError("no positional codec for cmd_id")로 즉시 실패한다.
  // 두 생성기가 같은 커맨드 집합에 대해 내리는 판정을 전수 비교한다.
  const cpp = generateRkyvCodecsCpp(richSchema);
  const facade = generatePositionalFacadeTs(richSchema);

  const cppCases = new Set([...cpp.matchAll(/case (\d+): encode_pos_/g)].map((m) => Number(m[1])));
  const facadeCalls = new Set(
    [...facade.matchAll(/callPos<[^>]*>\((\d+),/g)].map((m) => Number(m[1])),
  );

  assert.ok(cppCases.size > 0, 'fixture must contain positional codecs');
  assert.ok(facadeCalls.size > 0, 'fixture must contain callPos entries');

  const missingInCpp = [...facadeCalls].filter((id) => !cppCases.has(id));
  const missingInFacade = [...cppCases].filter((id) => !facadeCalls.has(id));
  assert.deepEqual(
    missingInCpp,
    [],
    `facade exposes callPos for cmd ids with no C++ codec: ${missingInCpp.join(', ')}`,
  );
  assert.deepEqual(
    missingInFacade,
    [],
    `C++ has positional codecs the facade never uses: ${missingInFacade.join(', ')}`,
  );
});

// ── 스키마 식별자 화이트리스트 (생성 TS 코드 주입 방어) ─────

test('parsePackageSchema rejects hostile identifiers', () => {
  const base = {
    packageId: 'ok.pkg',
    schemaVersion: 1,
    commands: [
      {
        name: 'addNumbers',
        commandId: 1,
        inputType: 'AddInput',
        outputType: 'AddOutput',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      },
    ],
  };
  // 정상 통과
  parsePackageSchema(base);
  // 악의적 타입명 — 생성 TS 에 그대로 삽입되는 식별자
  for (const bad of ['Evil { $ }', 'X; import("fs")', 'A\\n}; //', '']) {
    assert.throws(
      () => parsePackageSchema({ ...base, commands: [{ ...base.commands[0], inputType: bad }] }),
      /identifier|Invalid schema/,
    );
  }
  // 정의(definitions) 키도 검증 대상
  assert.throws(
    () =>
      parsePackageSchema({
        ...base,
        commands: [{ ...base.commands[0], definitions: { 'bad key!': { type: 'object' } } }],
      }),
    /identifier|Invalid schema/,
  );
  // command.name 도 식별자성 이름(생성 함수명/문자열 리터럴에 삽입)
  assert.throws(
    () => parsePackageSchema({ ...base, commands: [{ ...base.commands[0], name: 'bad name!' }] }),
    /identifier|Invalid schema/,
  );
});

test('parsePackageSchema diagnoses generic type names with a rebuild hint', () => {
  const base = {
    packageId: 'ok.pkg',
    schemaVersion: 1,
    commands: [
      {
        name: 'echo',
        commandId: 1,
        inputType: 'Wrapper<String >',
        outputType: 'AddOutput',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      },
    ],
  };
  // 구버전 rustra의 type_name 파손 이름 — 원인(제네릭)과 해결책(재빌드·모노몰포이즈
  // 이름)을 함께 알려줘야 사용자가 다음 동작을 알 수 있다.
  assert.throws(
    () => parsePackageSchema(base),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /generic type name/);
      assert.match(message, /Wrapper_for_X/, 'monomorphized name example must be shown');
      assert.match(message, /Rebuild the Rust package/);
      return true;
    },
  );
});

test('parsePackageSchema accepts the declaration-order marker and rejects unknown values', () => {
  const base = {
    packageId: 'ok.pkg',
    schemaVersion: 1,
    fieldOrder: 'declaration',
    commands: [],
  };
  assert.equal(parsePackageSchema(base).fieldOrder, 'declaration');
  assert.throws(
    () => parsePackageSchema({ ...base, fieldOrder: 'alphabetical' }),
    /fieldOrder.*declaration/,
  );
});

// ── 잔여 주입 벡터 차단 (중첩 definitions/속성명/이스케이프) ─────

/** 식별자 검증 테스트 공용 최소 스키마 — parsePackageSchema 화이트리스트 대상. */
const hostileBase = {
  packageId: 'ok.pkg',
  schemaVersion: 1,
  commands: [
    {
      name: 'addNumbers',
      commandId: 1,
      inputType: 'AddInput',
      outputType: 'AddOutput',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    },
  ],
};

test('parsePackageSchema rejects hostile nested definitions keys', () => {
  // collectDefinitionsInner 는 inputSchema/outputSchema 내부와 중첩 definitions
  // 까지 재귀 수집해 `export type ${name}` 으로 방출한다 — 최상위 cmd.definitions
  // 외의 모든 definitions 키도 식별자여야 한다.
  assert.throws(
    () =>
      parsePackageSchema({
        ...hostileBase,
        commands: [
          {
            ...hostileBase.commands[0],
            inputSchema: {
              type: 'object',
              definitions: { 'bad; evil()': { type: 'object' } },
            },
          },
        ],
      }),
    /identifier|Invalid schema/,
  );
  // definition 내부의 definitions(재귀 위치)도 동일하게 검증된다.
  assert.throws(
    () =>
      parsePackageSchema({
        ...hostileBase,
        commands: [
          {
            ...hostileBase.commands[0],
            outputSchema: {
              type: 'object',
              definitions: {
                Middle: { type: 'object', definitions: { 'bad key!': { type: 'object' } } },
              },
            },
          },
        ],
      }),
    /identifier|Invalid schema/,
  );
});

test('parsePackageSchema rejects hostile property names and $ref targets', () => {
  // 속성명은 생성 TS/C++ 에 따옴표 없이 삽입된다(codegen.ts `${name}:`,
  // rkyv 코덱 `args.${name}`, C++ `getProperty(rt, "${name}")`) — 식별자만 허용.
  assert.throws(
    () =>
      parsePackageSchema({
        ...hostileBase,
        commands: [
          {
            ...hostileBase.commands[0],
            inputSchema: {
              type: 'object',
              properties: { 'a; evil()': { type: 'integer' } },
            },
          },
        ],
      }),
    /identifier|Invalid schema/,
  );
  // $ref 대상 타입명도 타입 위치에 그대로 방출된다(resolveRef → 식별자).
  assert.throws(
    () =>
      parsePackageSchema({
        ...hostileBase,
        commands: [
          {
            ...hostileBase.commands[0],
            inputSchema: {
              type: 'object',
              properties: { ok: { $ref: '#/definitions/Foo; evil()' } },
            },
          },
        ],
      }),
    /identifier|Invalid schema/,
  );
});

test('generated code escapes hostile descriptions (JSDoc breakout)', () => {
  // description 은 정당하게 자유 문자열이므로 파싱 거부가 아니라 방출 시점
  // 이스케이프로 방어한다 — `*/` 로 주석을 깨고 코드 위치로 나오는 것을 차단.
  const schema: PackageSchema = {
    packageId: 'hostile.jsdoc',
    commands: [
      {
        name: 'boom',
        commandId: 1,
        inputType: 'BoomInput',
        outputType: 'BoomOutput',
        inputSchema: {
          type: 'object',
          description: 'breaks */ const evil = 1; /* out',
          properties: { id: { type: 'string', description: 'field */ evil() //' } },
        },
        outputSchema: { type: 'object' },
      },
    ],
  };
  const types = generateTypesTs(schema);
  // 탈출 전 원본 `*/` + 페이로드 패턴이 코드 위치에 남으면 안 된다.
  assert.ok(!types.includes('*/ const evil = 1'), 'description broke out of JSDoc');
  // 이스케이프 후에는 페이로드가 주석 안에 남아있어야 한다.
  assert.ok(types.includes('*\\/ const evil = 1'), 'payload must stay inside escaped JSDoc');
  assert.ok(types.includes('field *\\/'), 'field description must be escaped too');
  const commands = generateCommandsTs(schema);
  assert.ok(!commands.includes('*/ const evil = 1'), 'command JSDoc broke out');
  assert.ok(commands.includes('*\\/ const evil = 1'));
});

test('generated code escapes hostile enum/const string literals', () => {
  // enum/const 값은 정당하게 자유 문자열 — 작은따옴표 리터럴 방출 시 이스케이프.
  const schema: PackageSchema = {
    packageId: 'hostile.literal',
    commands: [
      {
        name: 'pick',
        commandId: 1,
        inputType: 'PickInput',
        outputType: 'PickOutput',
        inputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ["ok', evil() //"] },
            kind: { const: "tag', evil() //" },
          },
          required: ['mode', 'kind'],
          title: 'PickInput',
        },
        outputSchema: { type: 'object', properties: {}, required: [], title: 'PickOutput' },
      },
    ],
  };
  const types = generateTypesTs(schema);
  // 탈출 전: `'ok'` 가 닫히며 evil() 이 코드 위치로 나온다.
  assert.ok(!types.includes("'ok', evil()"), 'enum value broke out of string literal');
  assert.ok(types.includes("'ok\\', evil() //'"), 'enum value must stay inside escaped literal');
  assert.ok(!types.includes("'tag', evil()"), 'const value broke out of string literal');
  assert.ok(types.includes("'tag\\', evil() //'"), 'const value must stay inside escaped literal');
});

test('templateVersions permits independent CLI, types, and Cargo versions', () => {
  assert.deepEqual(templateVersions('0.5.0', '^0.4.0', '^0.4.0'), {
    cargoRange: '^0.4.0',
    npmCliCaret: '^0.5.0',
    npmTypesRange: '^0.4.0',
  });
  assert.throws(() => templateVersions('0.5.0', '', '^0.4.0'), /compatibility ranges/);
  assert.throws(() => templateVersions('0.5.0', '^0.4.0', ''), /compatibility ranges/);
});

test('init scaffold has a real shared package and executable codegen bin', () => {
  const files = renderInitProjectFiles(templateVersions('0.5.0', '^0.4.0', '^0.4.0'));
  assert.match(files.cargoToml, /rustra = "\^0\.4\.0"/);
  assert.match(files.packageJson, /"@rustra\/cli": "\^0\.5\.0"/);
  assert.match(files.packageJson, /"@rustra\/types": "\^0\.4\.0"/);
  assert.match(files.packageJson, /"@rustra\/node": "\^0\.5\.0"/);
  assert.match(files.packageJson, /"packageManager": "bun@1\.4\.0"/);
  assert.match(files.libRs, /pub fn package\(\) -> Package/);
  assert.match(files.generateRs, /rustra_app::package\(\)\.generate_typescript\(\)/);
  assert.match(files.mainRs, /__rustra_contract/);
  assert.match(files.appTs, /generated\/node\.js/);
  assert.doesNotMatch(files.generateRs, /see src\/main\.rs/);
  // 최소 템플릿 — $schema 참조 + schema/output + 감지된 호스트 섹션만.
  // codegen/node 바이너리는 CLI 폴백 선택(selectCodegenBinary)이 scaffold 레이아웃에서 정답을 고른다.
  assert.deepEqual(JSON.parse(files.rustraJson), {
    $schema: INIT_CONFIG_SCHEMA_PATH,
    schema: './generated/schema.json',
    output: './src/generated',
    node: {},
  });
  assert.match(files.packageJson, /"doctor": "rustra doctor --config rustra\.json"/);
  assert.match(files.packageJson, /"codegen": "rustra codegen --config rustra\.json"/);
  assert.match(
    files.packageJson,
    /"codegen:check": "rustra codegen --config rustra\.json --check"/,
  );
  assert.match(files.packageJson, /"dev": "rustra dev --config rustra\.json"/);
  assert.match(files.gitignore, /target/);
  assert.match(files.tsconfig, /NodeNext/);
});

test('codegen and generate parsers accept short help and JSON output format', () => {
  assert.deepEqual(parseCodegenArgs(['-h']), { help: true });
  assert.deepEqual(parseGenerateArgs(['--schema=x', '--output=y', '--format', 'json']), {
    schemaPath: 'x',
    outputPath: 'y',
    format: 'json',
  });
  assert.deepEqual(parseCodegenArgs(['--config=x', '--format=json']), {
    configPath: 'x',
    format: 'json',
  });
});

test('config parser rejects unknown keys instead of silently skipping a host', () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-config-unknown-'));
  const path = join(root, 'rustra.json');
  writeFileSync(
    path,
    JSON.stringify({ schema: './schema.json', output: './generated', reactNativ: {} }),
  );
  try {
    assert.throws(() => readConfigSync(path), /unknown config key.*reactNativ/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config parser suggests the closest known key for a typo', () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-config-suggest-'));
  const path = join(root, 'rustra.json');
  writeFileSync(
    path,
    JSON.stringify({ schema: './schema.json', output: './generated', reactNativ: {} }),
  );
  try {
    assert.throws(() => readConfigSync(path), /unknown config key.*reactNativ[\s\S]*reactNative/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('selectCodegenBinary prefers generate, accepts one binary, and rejects ambiguity', () => {
  const target = (name: string) => ({ name, kind: ['bin'], crate_types: ['bin'] });
  assert.equal(selectCodegenBinary([target('app'), target('generate')]), 'generate');
  assert.equal(selectCodegenBinary([target('app')]), 'app');
  assert.throws(
    () => selectCodegenBinary([target('app'), target('worker')]),
    /codegen\.rust_binary_ambiguous.*app.*worker/s,
  );
});

test('generated manifest records schema and file hashes', () => {
  const manifest = buildGeneratedManifest('{}', '0.5.0', [
    { path: 'types.ts', content: 'export {}\n' },
  ]);
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.schemaHash, /^[a-f0-9]{64}$/);
  assert.equal(manifest.generatorVersion, '0.5.0');
  assert.equal(manifest.files[0]?.path, 'types.ts');
  assert.match(manifest.files[0]?.sha256 ?? '', /^[a-f0-9]{64}$/);
});

test('generated check reports missing files without writing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-drift-'));
  try {
    const manifestPath = join(root, '.rustra-generated.json');
    const missing = join(root, 'types.ts');
    writeFileSync(
      manifestPath,
      `${JSON.stringify(buildGeneratedManifest('{}', '0.5.0', [{ path: 'types.ts', content: 'x' }]))}\n`,
    );
    await assert.rejects(
      () => checkGeneratedFiles([{ path: missing, content: 'x' }], manifestPath),
      /missing.*types\.ts/i,
    );
    assert.equal(readFileSync(manifestPath, 'utf8').includes('types.ts'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('generated check rejects changed bytes and leaves them unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-drift-'));
  try {
    const manifestPath = join(root, '.rustra-generated.json');
    const target = join(root, 'types.ts');
    writeFileSync(target, 'old\n');
    writeFileSync(
      manifestPath,
      `${JSON.stringify(buildGeneratedManifest('{}', '0.5.0', [{ path: 'types.ts', content: 'new\n' }]))}\n`,
    );
    await assert.rejects(
      () => checkGeneratedFiles([{ path: target, content: 'new\n' }], manifestPath),
      /changed.*types\.ts/i,
    );
    assert.equal(readFileSync(target, 'utf8'), 'old\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('generated check distinguishes a stale manifest from changed generated bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-drift-'));
  try {
    const manifestPath = join(root, '.rustra-generated.json');
    const target = join(root, 'types.ts');
    writeFileSync(target, 'new\n');
    writeFileSync(
      manifestPath,
      `${JSON.stringify(buildGeneratedManifest('{}', '0.5.0', [{ path: 'types.ts', content: 'old\n' }]))}\n`,
    );
    await assert.rejects(
      () => checkGeneratedFiles([{ path: target, content: 'new\n' }], manifestPath),
      /manifest stale.*types\.ts/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('React Native entry owns lazy native setup and re-exports generated commands', () => {
  const source = generateReactNativeEntryTs();
  assert.match(source, /createRustraBootstrap/);
  assert.match(source, /from "@rustra\/generated-react-native"/);
  assert.match(source, /export \* from '\.\/commands\.js'/);
  assert.match(source, /contractHash: GENERATED_CONTRACT_HASH/);
  assert.match(source, /schemaVersion: SCHEMA_VERSION/);
  assert.match(source, /export \{ subscribeEvent \} from '@rustra\/react-native'/);
});

test('desktop host entries own lazy setup and preserve explicit escape hatches', () => {
  const node = generateNodeEntryTs({
    targetDirectoryUrl: '../../target/',
    targetName: 'my-app',
  });
  assert.match(node, /createNodeBootstrap/);
  assert.match(node, /GENERATED_CONTRACT_HASH/);
  assert.match(node, /contractHash: GENERATED_CONTRACT_HASH/);
  assert.match(node, /release\/\$\{executable\}/);
  assert.match(node, /args: \["invoke"\]/);
  assert.match(node, /RUSTRA_NODE_BINARY|commandCandidates/);

  const bun = generateBunEntryTs({
    targetDirectoryUrl: '../../target/',
    targetName: 'my_app',
  });
  assert.match(bun, /createBunBootstrap/);
  assert.match(bun, /rkyvV2Codecs: rkyvV2Registry/);
  assert.match(bun, /GENERATED_CONTRACT_HASH/);

  const tauri = generateTauriEntryTs();
  assert.match(tauri, /createTauriBootstrap\(\)/);
  assert.match(tauri, /subscribeTauriEvent as subscribeEvent/);
});

test('React Native Cargo target inference uses the manifest package and staticlib name', () => {
  const selected = selectReactNativeCargoTarget(
    {
      packages: [
        {
          name: 'my-rust-app',
          manifest_path: '/app/native/Cargo.toml',
          targets: [{ name: 'custom_mobile_lib', crate_types: ['rlib', 'staticlib'] }],
        },
        {
          name: 'other',
          manifest_path: '/app/other/Cargo.toml',
          targets: [{ name: 'other', crate_types: ['lib'] }],
        },
      ],
    },
    '/app/native/Cargo.toml',
  );
  assert.deepEqual(selected, {
    rustPackage: 'my-rust-app',
    rustLibrary: 'custom_mobile_lib',
  });
});

test('React Native Cargo target inference fails with an actionable ambiguous-workspace hint', () => {
  assert.throws(
    () =>
      selectReactNativeCargoTarget(
        {
          packages: ['one', 'two'].map((name) => ({
            name,
            manifest_path: `/workspace/${name}/Cargo.toml`,
            targets: [{ name, crate_types: ['staticlib'] }],
          })),
        },
        '/workspace/Cargo.toml',
      ),
    /Point rustManifest at the app crate, or set reactNative\.rustPackage/,
  );
});

test('React Native Cargo target inference never substitutes a different requested package', () => {
  assert.throws(
    () =>
      selectReactNativeCargoTarget(
        {
          packages: [
            {
              name: 'actual-app',
              manifest_path: '/app/Cargo.toml',
              targets: [{ name: 'actual_app', crate_types: ['staticlib'] }],
            },
          ],
        },
        '/workspace/Cargo.toml',
        'missing-app',
      ),
    /Cargo package missing-app was not found uniquely/,
  );
});

test('React Native scaffold is Expo-independent and collision-resistant', () => {
  const files = renderReactNativeModule({
    appRoot: '/app',
    moduleDir: '/app/modules/rustra-bridge',
    cppOutputPath: '/app/modules/rustra-bridge/generated',
    rustManifestPath: '/workspace/Cargo.toml',
    rustPackage: 'my-rust-app',
    rustLibrary: 'my_rust_app',
    adapterRange: '^0.3.0',
  });
  assert.equal(JSON.parse(files['package.json']!).name, '@rustra/generated-react-native');
  assert.match(files['react-native.config.js']!, /dev\.rustra\.bridge\.RustraBridgePackage/);
  assert.match(files['src/index.ts']!, /NativeModules\.RustraBridge/);
  assert.ok(!Object.keys(files).some((name) => name.includes('expo')));
  assert.ok(!Object.values(files).some((content) => content.includes('expo-modules-core')));
  assert.match(files['RustraBridge.podspec']!, /RustraBridge/);
  assert.match(files['android/CMakeLists.txt']!, /rustra_bridge/);
});

test('React Native scaffold resolves a hoisted adapter with native sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-rn-generate-'));
  try {
    const appRoot = join(root, 'apps', 'viewer-expo');
    const moduleDir = join(appRoot, 'modules', 'rustra-bridge');
    // An old app-local install must not hide the valid hoisted package.
    mkdirSync(join(appRoot, 'node_modules', '@rustra', 'react-native'), {
      recursive: true,
    });
    const adapterNative = join(root, 'node_modules', '@rustra', 'react-native', 'native');
    mkdirSync(adapterNative, { recursive: true });
    writeFileSync(
      join(adapterNative, '..', 'package.json'),
      JSON.stringify({ name: '@rustra/react-native', version: '0.4.0' }),
    );
    const nativeFiles = [
      'android/rustra-jsi-jni.cpp',
      'cpp/RustraJSIBridge.cpp',
      'cpp/RustraJSIBridge.hpp',
      'cpp/rustra-codec.hpp',
      'ios/RustraJSIModule.mm',
    ];
    for (const file of nativeFiles) {
      const target = join(adapterNative, file);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, 'native fixture');
    }

    const files = renderReactNativeModule({
      appRoot,
      moduleDir,
      cppOutputPath: join(moduleDir, 'generated'),
      rustManifestPath: join(root, 'native', 'Cargo.toml'),
      rustPackage: 'leftcar',
      rustLibrary: 'leftcar',
      adapterRange: '^0.4.0',
    });

    assert.match(
      files['RustraBridge.podspec']!,
      /File\.expand_path\('\.\.\/\.\.\/\.\.\/\.\.\/node_modules\/@rustra\/react-native\/native'/,
    );
    assert.match(
      files['android/build.gradle']!,
      /file\("\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/node_modules\/@rustra\/react-native\/native"\)/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('React Native scaffold ignores a complete adapter package with the wrong version', () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-rn-versioned-generate-'));
  try {
    const appRoot = join(root, 'apps', 'viewer');
    const moduleDir = join(appRoot, 'modules', 'rustra-bridge');
    const nativeFiles = [
      'android/rustra-jsi-jni.cpp',
      'cpp/RustraJSIBridge.cpp',
      'cpp/RustraJSIBridge.hpp',
      'cpp/rustra-codec.hpp',
      'ios/RustraJSIModule.mm',
    ];
    for (const [packageRoot, version] of [
      [join(appRoot, 'node_modules', '@rustra', 'react-native'), '0.3.0'],
      [join(root, 'node_modules', '@rustra', 'react-native'), '0.4.0'],
    ] as const) {
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        join(packageRoot, 'package.json'),
        JSON.stringify({ name: '@rustra/react-native', version }),
      );
      for (const file of nativeFiles) {
        const target = join(packageRoot, 'native', file);
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, `${version} native fixture`);
      }
    }

    const files = renderReactNativeModule({
      appRoot,
      moduleDir,
      cppOutputPath: join(moduleDir, 'generated'),
      rustManifestPath: join(root, 'native', 'Cargo.toml'),
      rustPackage: 'viewer',
      rustLibrary: 'viewer',
      adapterRange: '^0.4.0',
    });

    assert.match(
      files['RustraBridge.podspec']!,
      /File\.expand_path\('\.\.\/\.\.\/\.\.\/\.\.\/node_modules\/@rustra\/react-native\/native'/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('React Native scaffold reports when only a stale complete adapter is installed', () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-rn-stale-generate-'));
  try {
    const appRoot = join(root, 'app');
    const packageRoot = join(appRoot, 'node_modules', '@rustra', 'react-native');
    const nativeFiles = [
      'android/rustra-jsi-jni.cpp',
      'cpp/RustraJSIBridge.cpp',
      'cpp/RustraJSIBridge.hpp',
      'cpp/rustra-codec.hpp',
      'ios/RustraJSIModule.mm',
    ];
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@rustra/react-native', version: '0.3.0' }),
    );
    for (const file of nativeFiles) {
      const target = join(packageRoot, 'native', file);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, 'stale native fixture');
    }

    assert.throws(
      () =>
        renderReactNativeModule({
          appRoot,
          moduleDir: join(appRoot, 'modules/rustra-bridge'),
          cppOutputPath: join(appRoot, 'modules/rustra-bridge/generated'),
          rustManifestPath: join(root, 'Cargo.toml'),
          rustPackage: 'stale',
          rustLibrary: 'stale',
          adapterRange: '^0.4.0',
        }),
      /complete but incompatible.*expected \^0\.4\.0/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('React Native scaffold keeps calculator-only ABI behind the fixture flag', () => {
  const base = {
    appRoot: '/app',
    moduleDir: '/app/modules/rustra-bridge',
    cppOutputPath: '/app/modules/rustra-bridge/generated',
    rustManifestPath: '/workspace/Cargo.toml',
    rustPackage: 'calculator',
    rustLibrary: 'calculator',
    adapterRange: '^0.3.0',
  };
  const production = renderReactNativeModule(base);
  const fixture = renderReactNativeModule({ ...base, legacyBenchmarks: true });
  assert.doesNotMatch(production['RustraBridge.podspec']!, /RUSTRA_ENABLE_LEGACY_BENCHMARKS/);
  assert.match(fixture['RustraBridge.podspec']!, /RUSTRA_ENABLE_LEGACY_BENCHMARKS/);
  assert.match(fixture['android/build.gradle']!, /RUSTRA_LEGACY_BENCHMARKS=ON/);
});

test('generateEventsTs emits payload types, name union, and subscribe helper', async () => {
  const { generateEventsTs } = await import('./generate.js');
  const schema = {
    packageId: 'example.stream',
    commands: [],
    events: [
      {
        name: 'progress.tick',
        payload: {
          type: 'object',
          required: ['value'],
          properties: { value: { type: 'integer', format: 'int64' } },
        },
      },
    ],
  } as Parameters<typeof generateEventsTs>[0];

  const out = generateEventsTs(schema);
  assert.ok(out.includes("export type RustraEventName = 'progress.tick'"));
  assert.ok(out.includes("  'progress.tick': {"));
  assert.ok(out.includes('value: number | bigint;'));
  assert.ok(out.includes('export function onRustraEvent'));
  assert.ok(out.includes('export type SubscribeFn'));
});

test('generateEventsTs returns empty string without events (backcompat)', async () => {
  const { generateEventsTs } = await import('./generate.js');
  const schema = { packageId: 'example.plain', commands: [] } as Parameters<
    typeof generateEventsTs
  >[0];
  assert.equal(generateEventsTs(schema), '');
});

// ── 64-bit varint/zigzag runtime helpers (postcardHelperSource) ────────────
// postcardHelperSource() 가 반환하는 템플릿은 TS 코드 그 자체다. 임시 파일로
// 쓰고 import 해서 실제 동작을 실행 검증한다(스냅샷/정규식만으로는 부정확).

test('postcardHelperSource declares 64-bit varint/zigzag helpers', () => {
  const source = postcardHelperSource();
  for (const name of [
    '_pcEncodeVarint64',
    '_pcDecodeVarint64',
    '_pcEncodeZigzag64',
    '_pcDecodeZigzag64',
  ]) {
    assert.ok(source.includes(`function ${name}`), `missing helper ${name}`);
  }
});

interface TestHooks {
  encodeVarint64: (v: number | bigint) => Uint8Array;
  decodeVarint64: (
    buf: Uint8Array,
    offset: number,
  ) => { value: number | bigint; bytesRead: number };
  encodeZigzag64: (v: number | bigint) => Uint8Array;
  decodeZigzag64: (v: number | bigint) => number | bigint;
  encodeVarint: (v: number) => Uint8Array;
}

async function loadHelperHooks(): Promise<TestHooks> {
  const source = postcardHelperSource();
  const bridge =
    `export function _pcTestEncodeVarint64(v: number | bigint): Uint8Array { return _pcEncodeVarint64(v); }\n` +
    `export function _pcTestDecodeVarint64(buf: Uint8Array, offset: number) { return _pcDecodeVarint64(buf, offset); }\n` +
    `export function _pcTestEncodeZigzag64(v: number | bigint): Uint8Array { return _pcEncodeZigzag64(v); }\n` +
    `export function _pcTestDecodeZigzag64(v: number | bigint) { return _pcDecodeZigzag64(v); }\n` +
    `export function _pcTestEncodeVarint(v: number): Uint8Array { return _pcEncodeVarint(v); }\n`;
  const dir = mkdtempSync(join(tmpdir(), 'rustra-varint64-'));
  const file = join(dir, 'helpers.ts');
  writeFileSync(file, source + bridge);
  try {
    // Node ESM 동적 import 는 파일 경로에 file:// URL 을 요구할 수 있어 변환.
    const ns = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    return {
      encodeVarint64: ns._pcTestEncodeVarint64 as TestHooks['encodeVarint64'],
      decodeVarint64: ns._pcTestDecodeVarint64 as TestHooks['decodeVarint64'],
      encodeZigzag64: ns._pcTestEncodeZigzag64 as TestHooks['encodeZigzag64'],
      decodeZigzag64: ns._pcTestDecodeZigzag64 as TestHooks['decodeZigzag64'],
      encodeVarint: ns._pcTestEncodeVarint as TestHooks['encodeVarint'],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('postcardHelperSource 64-bit helpers round-trip u64 and i64 boundaries', async () => {
  const h = await loadHelperHooks();
  const u64Max = 2n ** 64n - 1n;

  // u64::MAX → 10-byte LEB128, decode reverses it.
  const encoded = h.encodeVarint64(u64Max);
  assert.equal(encoded.length, 10);
  const decoded = h.decodeVarint64(encoded, 0);
  assert.equal(decoded.value, 18446744073709551615n);
  assert.equal(decoded.bytesRead, 10);

  // 2^53 경계: 이하 → number, 초과 → bigint (complex-codec toJsInteger 계약).
  assert.equal(typeof h.decodeVarint64(h.encodeVarint64(2n ** 53n - 1n), 0).value, 'number');
  assert.equal(h.decodeVarint64(h.encodeVarint64(2n ** 53n - 1n), 0).value, 9007199254740991);
  assert.equal(typeof h.decodeVarint64(h.encodeVarint64(2n ** 53n), 0).value, 'bigint');
  assert.equal(h.decodeVarint64(h.encodeVarint64(2n ** 53n), 0).value, 2n ** 53n);

  // safe number 입력은 number 경로 — 32-bit number 헬퍼와 출력이 동일하다.
  for (const v of [0, 1, 127, 128, 300, 2 ** 32 - 1]) {
    assert.deepEqual(h.encodeVarint64(v), h.encodeVarint(v), `number path mismatch at ${v}`);
  }
});

test('postcardHelperSource zigzag64 round-trips i64 boundaries', async () => {
  const h = await loadHelperHooks();
  const i64Min = -(2n ** 63n);
  const i64Max = 2n ** 63n - 1n;

  for (const v of [0n, 1n, -1n, i64Min, i64Max, 2n ** 53n, -(2n ** 53n) - 1n]) {
    const bytes = h.encodeZigzag64(v);
    const back = h.decodeZigzag64(h.decodeVarint64(bytes, 0).value);
    // 디코드 계약: safe 범위면 number, 넘으면 bigint (toJsInteger 선례).
    const expected = v >= -(2n ** 53n) + 1n && v <= 2n ** 53n - 1n ? Number(v) : v;
    assert.equal(back, expected, `zigzag64 round-trip failed at ${v}`);
  }

  // i64::MIN → u64::MAX 와이어, i64::MAX → 2·i64MAX = 2^64-2 (둘 다 10바이트).
  assert.deepEqual(h.encodeZigzag64(i64Min), h.encodeVarint64(2n ** 64n - 1n));
  assert.deepEqual(h.encodeZigzag64(i64Max), h.encodeVarint64(2n ** 64n - 2n));
  assert.equal(h.encodeZigzag64(i64Max).length, 10);
});

test('generated composite 64-bit codecs (vec_u64/map_i64/option_i64) encode and decode known bytes', async () => {
  // 복합 64-bit emit 경로(vec_i64/vec_u64/map_i64/map_u64/option_*)는 생성된
  // 코드를 실제 실행해 알려진 바이트와 대조한다 — 오타가 조용히 배포되는 것을
  // 막는 최소 게이트. wideAgg cross-wire 픽스처(examples/calculator)가
  // Rust↔TS 쪽을 담당하고, 여기서는 분류별 emit 을 모두 실행 본다.
  const schema: PackageSchema = {
    packageId: 'wide-composite',
    fieldOrder: 'declaration',
    commands: [
      {
        name: 'wideComposite',
        commandId: 41,
        inputType: 'WideCompositeInput',
        outputType: 'WideCompositeOutput',
        inputSchema: {
          type: 'object',
          properties: {
            samples: { type: 'array', items: { type: 'integer', format: 'uint64' } },
            scores: {
              type: 'object',
              additionalProperties: { type: 'integer', format: 'int64' },
            },
            offset: { type: ['integer', 'null'], format: 'int64' },
          },
          required: ['samples', 'scores', 'offset'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            max: { type: 'integer', format: 'uint64' },
            pairs: { type: 'array', items: { type: 'integer', format: 'int64' } },
          },
          required: ['max', 'pairs'],
        },
      },
    ],
  };

  const codecs = generateRkyvCodecsTs(schema);
  // 분류 확인: 원소/값/옵션 레벨 64-bit 헬퍼.
  assert.match(codecs, /_pcEncodeVarint64\(_arr\[_i\]\)/, 'vec_u64 element encode');
  assert.match(codecs, /_pcEncodeZigzag64\(_v\)/, 'map_i64 value encode');
  assert.match(codecs, /_pcEncodeZigzag64\(_opt\)/, 'option_zigzag64 encode');

  // 생성물을 임시 모듈로 써서 실제 encode/decode 실행.
  const dir = mkdtempSync(join(tmpdir(), 'rustra-wide-composite-'));
  const stub =
    `type RustraError = { code: string; message: string };\n` +
    `export type RkyvV2Codec<TIn, TOut> = {\n` +
    `  commandId: number;\n` +
    `  encode(args: TIn): ArrayBuffer;\n` +
    `  decode(buf: ArrayBuffer): { ok: boolean; result?: TOut; error?: RustraError };\n` +
    `};\n`;
  const file = join(dir, 'codecs.ts');
  writeFileSync(file, stub + codecs);
  try {
    const ns = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    const codec = ns.wideCompositeCodec as {
      encode(input: Record<string, unknown>): ArrayBuffer;
      decode(buffer: ArrayBuffer | Uint8Array): {
        ok: boolean;
        result?: { max: bigint; pairs: number[] };
      };
    };

    // 알려진 바이트 — postcard 계약을 손으로 계산한 기대값.
    // uvar(3) | uvar64(1)=01 uvar64(128)=8001 uvar64(2^53+1)=8180808080808010
    // | map 1엔트리 {"a": zigzag64(-5)=09} | Some(zigzag64(7)=0e)
    const req = codec.encode({
      samples: [1, 128, 9007199254740993n],
      scores: { a: -5 },
      offset: 7,
    });
    assert.equal(
      Buffer.from(new Uint8Array(req)).toString('hex'),
      '290003' + '01' + '8001' + '8180808080808010' + '01' + '0161' + '09' + '01' + '0e',
      'composite 64-bit encode must produce exact postcard bytes',
    );

    // 응답 디코드: max=u64::MAX(10B LEB128), pairs=[-1, 2^53-1](zigzag 01, feffffffffffff1f)
    const body = [
      ...[0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01], // u64::MAX
      2, // vec len
      ...[0x01], // zigzag(-1)
      ...[0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f], // zigzag(2^53-1)… 8B
    ];
    const out = new Uint8Array(8 + body.length);
    out[0] = 1;
    out.set(body, 8);
    const decoded = codec.decode(out.buffer);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.result?.max, 18446744073709551615n, 'u64::MAX → bigint');
    assert.equal(decoded.result?.pairs[0], -1);
    assert.equal(decoded.result?.pairs[1], 9007199254740991, 'safe boundary stays number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('postcardHelperSource decoder rejects overlong and out-of-range encodings', async () => {
  const h = await loadHelperHooks();
  const u64MaxBytes = h.encodeVarint64(2n ** 64n - 1n); // ff ×9 + 01

  // 10바이트째 마지막 바이트는 0x00/0x01 만 허용 (Rust postcard
  // max_of_last_byte = 1). 0x02..0x7f 는 64비트 초과 — 무음 왜곡 대신 throw.
  const overlong = new Uint8Array([...u64MaxBytes.slice(0, 9), 0x7f]);
  assert.throws(() => h.decodeVarint64(overlong, 0), /varint exceeds 64 bits/);
  // 같은 바이트가 0x01 이면 정상 — u64::MAX 와이어.
  assert.equal(h.decodeVarint64(u64MaxBytes, 0).value, 2n ** 64n - 1n);
  // 10바이트째 0x00 — 정확히 63비트 경계 인코딩.
  const boundary = new Uint8Array([...u64MaxBytes.slice(0, 9), 0x00]);
  assert.equal(h.decodeVarint64(boundary, 0).value, 2n ** 63n - 1n);

  // 11바이트 — 앞 10바이트가 모두 continuation — 'varint too long'.
  // (u64MaxBytes 뒤에 바이트를 붙이는 건 varint 가 아니라 다음 필드다.)
  const eleven = new Uint8Array(11).fill(0xff);
  assert.throws(() => h.decodeVarint64(eleven, 0), /varint too long/);

  // 잘린 입력(continuation 으로 끝나는 5바이트) — 'varint out of bounds'.
  const truncated = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]);
  assert.throws(() => h.decodeVarint64(truncated, 0), /varint out of bounds/);
  // buffer 끝을 넘기는 offset 도 동일.
  assert.throws(() => h.decodeVarint64(new Uint8Array([0x01]), 5), /varint out of bounds/);
});

test('postcardHelperSource encoders reject negative and out-of-i64 inputs', async () => {
  const h = await loadHelperHooks();

  // 음수 varint — number 와 bigint 모두.
  assert.throws(() => h.encodeVarint64(-1), /varint must be non-negative/);
  assert.throws(() => h.encodeVarint64(-1n), /varint must be non-negative/);
  assert.throws(() => h.encodeVarint64(-(2n ** 64n)), /varint must be non-negative/);

  // zigzag64 는 i64 범위 밖 입력을 throw (validateInteger 선례, 무음 왜곡 금지).
  assert.throws(() => h.encodeZigzag64(2n ** 63n), /outside i64 range/);
  assert.throws(() => h.encodeZigzag64(-(2n ** 63n) - 1n), /outside i64 range/);
  assert.doesNotThrow(() => h.encodeZigzag64(2n ** 63n - 1n));
  assert.doesNotThrow(() => h.encodeZigzag64(-(2n ** 63n)));

  // varint64 는 u64 범위 밖 입력을 throw — 아니면 모든 디코더가 거절하는
  // 와이어(10바이트째 payload 0x02)를 내보게 된다(무음 왜곡 금지).
  assert.throws(() => h.encodeVarint64(2n ** 64n), /varint exceeds u64 range/);
  assert.doesNotThrow(() => h.encodeVarint64(2n ** 64n - 1n));
});

test('generateFromSchema names the schema file when its JSON is broken', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-generate-broken-schema-'));
  try {
    const schemaPath = join(root, 'schema.json');
    writeFileSync(schemaPath, '{ oops');
    await assert.rejects(generateFromSchema(schemaPath, join(root, 'out')), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /Invalid schema\.json/);
      assert.ok(message.includes(schemaPath), 'error must name the schema file');
      assert.match(message, /cargo run/);
      // 파서 세부 문구는 런타임마다 다르다(Node: "Expected property name or '}'…",
      // Bun: "Expected '}'") — 하드코딩 대신 원인이 살아있는지만 본다.
      assert.match(message, /:\s*JSON Parse error|:\s*Expected/, 'parse detail must survive');
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

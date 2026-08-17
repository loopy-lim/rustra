import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateTypesTs,
  generateCommandsTs,
  generateContractTs,
  generateRkyvCodecsCpp,
  generateRkyvCodecsHpp,
} from './generate.js';
import { collectDefinitions } from './codegen.js';
import type { PackageSchema } from './schema.js';

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
  assert.ok(commands.includes('export function add('));
  assert.ok(commands.includes("invoke<AddOutput>('add'"));
  assert.ok(commands.includes("import { invoke } from '@rustra/types'"));
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
  assert.ok(hpp.includes('#include "rustra-codec.hpp"'));
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

test('generateRkyvCodecsCpp maps each postcard field kind to the right push/read', () => {
  const cpp = generateRkyvCodecsCpp(cppSchema);

  // integer → push_i64 / read_i64
  assert.ok(cpp.includes('w.push_i64((int64_t)_v);'));
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

import assert from 'node:assert/strict';
import test from 'node:test';
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
  assert.ok(commands.includes("import type { InvokeOptions } from '@rustra/types'"));
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
  assert.ok(commands.includes("invoke<void>('ping', undefined, options)"));
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
      name: 'unsupportedMap',
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

test('generateRkyvRegistryTs excludes unsupported commands with a header note', () => {
  const registry = generateRkyvRegistryTs(richSchema);
  assert.ok(registry.includes("['updateItem'"), 'Option commands must be included');
  assert.ok(registry.includes("['sortBy'"), 'enum commands must be included');
  assert.ok(registry.includes("['listItems'"), 'Vec<Struct> commands must be included');
  assert.ok(!registry.includes("['unsupportedMap'"), 'map commands must be excluded');
  assert.ok(registry.includes('Tier 3 fallback'), 'exclusion note must be present');
});

test('generateRkyvCodecsCpp excludes unsupported commands from has_static_codec', () => {
  const cpp = generateRkyvCodecsCpp(richSchema);
  assert.ok(cpp.includes('if (name == "updateItem") { encode_updateItem'));
  assert.ok(
    !cpp.includes('unsupportedMap'),
    'unsupported map command must not appear in C++ codec',
  );
});

// ── positional facade (P2) ──────────────────────────────────

test('generatePositionalFacadeTs emits positional signatures for simple commands', () => {
  const facade = generatePositionalFacadeTs(richSchema);
  // updateItem — Option 필드지만 pass-through 가능(단일 input 객체) 확인
  assert.ok(facade.includes('installRustraPositional'), 'installer must be exported');
  assert.ok(facade.includes('PositionalNative'), 'native type must be exported');
  // sortBy (enum, 단일 필드) → positional
  const sort = facade.split('export function sortBy')[1]?.split('export function')[0] ?? '';
  assert.ok(sort.includes('order: string'), 'enum field must map to string param');
  assert.ok(sort.includes("'sortBy'"), 'command name must be passed');
  // unsupportedMap 은 제외
  assert.ok(!facade.includes('unsupportedMap'), 'unsupported commands must be excluded');
});

test('generatePositionalFacadeTs uses positional params for ≤3 primitive fields', () => {
  const facade = generatePositionalFacadeTs(simpleSchema);
  assert.ok(
    facade.includes('export function add(a: number, b: number,'),
    'simple 2-field command must be positional',
  );
});

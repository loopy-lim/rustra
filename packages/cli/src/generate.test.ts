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
import { parsePackageSchema, renderInitProjectFiles, templateVersions } from './index.js';
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

test('generateTypesTs exposes both byte-array runtime representations', () => {
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
  assert.ok(types.includes('data: Uint8Array | number[]'));
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
  assert.ok(commands.includes("invokeGenerated<AddOutput>(1, 'add'"));
  assert.ok(commands.includes("import { invokeGenerated } from '@rustra/types'"));
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

test('generateRkyvRegistryTs excludes unsupported commands with a header note', () => {
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
    !registry.includes("['unsupportedNestedMap'"),
    'nested collection map commands must be excluded',
  );
  assert.ok(registry.includes('Tier 3 fallback'), 'exclusion note must be present');
  assert.equal(warnings.length, 1, 'unsupported commands must emit one actionable warning');
  assert.match(warnings[0], /unsupportedNestedMap/);
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
          required: ['channel'],
          properties: {
            channel: { allOf: [{ $ref: '#/definitions/ChannelHandle' }] },
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
  assert.match(registry, /\['sendChannel', sendChannelCodec\]/);
  assert.match(codecs, /_pcEncodeVarint\(args\.channel\)/);
});

test('generateRkyvCodecsCpp excludes unsupported commands from has_static_codec', () => {
  const cpp = generateRkyvCodecsCpp(richSchema);
  assert.ok(cpp.includes('if (name == "updateItem") { encode_updateItem'));
  assert.ok(cpp.includes('if (name == "mapScores") { encode_mapScores'));
  assert.ok(
    !cpp.includes('unsupportedNestedMap'),
    'unsupported nested map command must not appear in C++ codec',
  );
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
  assert.ok(cpp.includes('number > 255'));
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

test('templateVersions keeps CLI, types, and crates versions independent', () => {
  // @rustra/types는 CLI와 독립 버전이다. CLI 버전에서 추측하면 존재하지 않는
  // 패키지를 scaffold에 기록할 수 있으므로 실제 dependency 범위를 보존한다.
  assert.deepEqual(templateVersions('0.3.0', '^0.3.1', '0.3'), {
    cargoMinor: '0.3',
    npmCliCaret: '^0.3.0',
    npmTypesRange: '^0.3.1',
  });
});

test('init scaffold has a real shared package and executable codegen bin', () => {
  const files = renderInitProjectFiles(templateVersions('0.3.0', '^0.3.1', '0.3'));
  assert.match(files.cargoToml, /rustra = "0\.3"/);
  assert.match(files.packageJson, /"@rustra\/cli": "\^0\.3\.0"/);
  assert.match(files.packageJson, /"@rustra\/types": "\^0\.3\.1"/);
  assert.match(files.packageJson, /"packageManager": "bun@1\.4\.0"/);
  assert.match(files.libRs, /pub fn package\(\) -> Package/);
  assert.match(files.generateRs, /rustra_app::package\(\)\.generate_typescript\(\)/);
  assert.doesNotMatch(files.generateRs, /see src\/main\.rs/);
  assert.deepEqual(JSON.parse(files.rustraJson), {
    schema: './generated/schema.json',
    output: './src/generated',
  });
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
  assert.ok(out.includes('value: number;'));
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

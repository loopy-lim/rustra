import type { ComplexSchema } from './complex-codec-types.js';
import { ComplexCodecError, DEFAULT_MAX_DEPTH } from './complex-codec-types.js';
import { compareUtf8 } from './complex-codec-wire.js';
import { isUnsigned, optionInner, refName } from './complex-codec-schema.js';
import { discriminator, variantKey } from './complex-codec-variants.js';

/**
 * 컴파일된 complex 스키마 노드 — Rust `complex_schema_ir` 의 JS 미러.
 *
 * `createComplexCodec` 이 코덱 생성 시점에 **한 번** 스키마를 순회해 만든다.
 * 이후 encode/decode 는 `resolvedSchema`($ref/allOf hop + 전체 객체 스캔),
 * `optionInner`(재구성 클론), `variants`(키 유도+사전순 정렬)를 호출마다
 * 재계산하지 않고 컴파일된 결정만 소비한다. 원본이 매 호출 raw 스키마 모양을
 * 보고 내리는 결정(변형 매칭/본체 디스패치, Set 언래핑, uniqueItems)은
 * 컴파일 시점에 스냅샷해 와이어와 관찰 동작을 그대로 유지한다.
 */
export type CompiledNode =
  | { kind: 'string' | 'boolean' | 'null' }
  | { kind: 'integer'; unsigned: boolean; format?: string }
  | { kind: 'number'; single: boolean }
  | {
      kind: 'seq';
      tuple: CompiledNode[] | null;
      items: CompiledNode | null;
      uniqueItems: boolean;
    }
  | { kind: 'option'; inner: CompiledNode }
  | {
      kind: 'struct';
      fields: { key: string; node: CompiledNode; required: boolean }[];
    }
  | { kind: 'map'; value: CompiledNode }
  | { kind: 'enum'; values: unknown[] }
  | { kind: 'const'; value: unknown; inner: CompiledNode | null }
  | { kind: 'oneof'; variants: CompiledVariant[] };

/** 변형 — matcher/body 결정을 원본 matchesVariant/encodeVariant/decodeVariant
 * 순서대로 컴파일 시점에 밟아 고정한다. */
export type CompiledVariant = {
  tag: { key: string; value: unknown } | null;
  matcher:
    | { kind: 'discriminator' }
    | { kind: 'singleProperty'; key: string }
    | { kind: 'constEq'; value: unknown }
    | { kind: 'enumSingle'; value: unknown }
    | { kind: 'anyString' | 'anyObject' | 'never' };
  body:
    | { kind: 'tagged'; node: CompiledNode; skipKey: string }
    | { kind: 'unwrapSingle'; key: string; node: CompiledNode }
    | { kind: 'constValue'; value: unknown }
    | { kind: 'enumFirst'; value: unknown }
    | { kind: 'node'; node: CompiledNode };
};

const MAX_DEPTH = DEFAULT_MAX_DEPTH;

export function compileSchema(
  schema: ComplexSchema,
  definitions: Record<string, ComplexSchema>,
): CompiledNode {
  return compileNode(schema, definitions, new Map(), 0);
}

function compileNode(
  schema: ComplexSchema,
  definitions: Record<string, ComplexSchema>,
  refs: Map<string, CompiledNode>,
  depth: number,
): CompiledNode {
  if (depth > MAX_DEPTH) throw new ComplexCodecError('schema reference depth exceeded');
  // resolvedSchema 미러 — $ref/allOf 전개.
  if (schema.$ref) {
    const name = refName(schema.$ref);
    const resolved = definitions[name];
    if (!resolved) throw new ComplexCodecError(`missing schema definition ${schema.$ref}`);
    const memo = refs.get(name);
    // 진행 중(사이클) 재진입은 아직 완성되지 않은 노드를 재사용해 끊는다 —
    // 컴파일 산물은 불변 트리이므로 부분 완성 노드의 재진입 참조도 안전.
    if (memo) return memo;
    // 플레이스홀더를 먼저 놓지 않는 대신, 완성 후 맵에 넣는다. 사이클은
    // depth 한도로도 방어된다(원본 resolved_schema 와 동일 정책).
    const compiled = compileNode(resolved, definitions, refs, depth + 1);
    refs.set(name, compiled);
    return compiled;
  }
  if (schema.allOf) {
    if (schema.allOf.length !== 1)
      throw new ComplexCodecError('complex codec does not support multi-entry allOf');
    return compileNode(schema.allOf[0], definitions, refs, depth + 1);
  }
  // optionInner 미러.
  const option = optionInner(schema);
  if (option) return { kind: 'option', inner: compileNode(option, definitions, refs, depth + 1) };
  if (schema.oneOf) return compileOneOf(schema, definitions, refs, depth);
  if (schema.enum) return { kind: 'enum', values: schema.enum };
  if (schema.const !== undefined) {
    const inner =
      schema.type !== undefined
        ? compileNode({ ...schema, const: undefined }, definitions, refs, depth)
        : null;
    return { kind: 'const', value: schema.const, inner };
  }
  switch (schema.type) {
    case 'boolean':
      return { kind: 'boolean' };
    case 'integer':
      return { kind: 'integer', unsigned: isUnsigned(schema), format: schema.format };
    case 'number':
      return { kind: 'number', single: schema.format === 'float' };
    case 'string':
      return { kind: 'string' };
    case 'null':
      return { kind: 'null' };
    case 'array': {
      const items = schema.items;
      if (Array.isArray(items)) {
        return {
          kind: 'seq',
          tuple: items.map((item) => compileNode(item, definitions, refs, depth + 1)),
          items: null,
          uniqueItems: schema.uniqueItems === true,
        };
      }
      if (!items) throw new ComplexCodecError('array schema is missing items');
      return {
        kind: 'seq',
        tuple: null,
        items: compileNode(items, definitions, refs, depth + 1),
        uniqueItems: schema.uniqueItems === true,
      };
    }
    case 'object': {
      if (schema.additionalProperties !== undefined && !schema.properties) {
        if (!schema.additionalProperties || typeof schema.additionalProperties === 'boolean')
          throw new ComplexCodecError('map schema is missing value type');
        return {
          kind: 'map',
          value: compileNode(schema.additionalProperties, definitions, refs, depth + 1),
        };
      }
      const required = new Set(schema.required ?? []);
      return {
        kind: 'struct',
        fields: Object.entries(schema.properties ?? {}).map(([key, fieldSchema]) => ({
          key,
          node: compileNode(fieldSchema, definitions, refs, depth + 1),
          required: required.has(key),
        })),
      };
    }
    default:
      throw new ComplexCodecError(`unsupported schema type ${String(schema.type)}`);
  }
}

function compileOneOf(
  schema: ComplexSchema,
  definitions: Record<string, ComplexSchema>,
  refs: Map<string, CompiledNode>,
  depth: number,
): CompiledNode {
  const explicit = schema['x-rustra-variant-order'];
  const choices = schema.oneOf ?? [];
  if (
    explicit &&
    (explicit.length !== choices.length || new Set(explicit).size !== explicit.length)
  ) {
    throw new ComplexCodecError(
      'x-rustra-variant-order must contain unique keys for every variant',
    );
  }
  const keyed = choices.map((variant, index) => {
    const key = explicit?.[index] ?? variantKey(variant);
    if (key === null)
      throw new ComplexCodecError('enum variants require a stable key or explicit metadata');
    return { schema: variant, key };
  });
  keyed.sort((left, right) => compareUtf8(left.key, right.key));
  if (new Set(keyed.map((variant) => variant.key)).size !== keyed.length) {
    throw new ComplexCodecError('enum variant keys must be unique');
  }
  return {
    kind: 'oneof',
    variants: keyed.map(({ schema: variant }) => compileVariant(variant, definitions, refs, depth)),
  };
}

function compileVariant(
  variant: ComplexSchema,
  definitions: Record<string, ComplexSchema>,
  refs: Map<string, CompiledNode>,
  depth: number,
): CompiledVariant {
  const tag = discriminator(variant);
  const properties = variant.properties;
  // matchesVariant 순서: discriminator → 단일 프로퍼티 → const → 단일 enum →
  // type 폴백(string/object) → never.
  const matcher: CompiledVariant['matcher'] = tag
    ? { kind: 'discriminator' }
    : properties && Object.keys(properties).length === 1
      ? { kind: 'singleProperty', key: Object.keys(properties)[0] }
      : variant.const !== undefined
        ? { kind: 'constEq', value: variant.const }
        : variant.enum?.length === 1
          ? { kind: 'enumSingle', value: variant.enum[0] }
          : variant.type === 'string'
            ? { kind: 'anyString' }
            : variant.type === 'object'
              ? { kind: 'anyObject' }
              : { kind: 'never' };
  // encodeVariant/decodeVariant 순서: discriminator(tag+object) → 단일 프로퍼티
  // → const/enum → 폴스루.
  const body: CompiledVariant['body'] =
    tag && variant.type === 'object'
      ? {
          kind: 'tagged',
          skipKey: tag.key,
          node: {
            kind: 'struct',
            fields: Object.entries(properties ?? {}).map(([key, fieldSchema]) => ({
              key,
              node: compileNode(fieldSchema, definitions, refs, depth + 1),
              required: (variant.required ?? []).includes(key),
            })),
          },
        }
      : properties && Object.keys(properties).length === 1
        ? {
            kind: 'unwrapSingle',
            key: Object.keys(properties)[0],
            node: compileNode(properties[Object.keys(properties)[0]], definitions, refs, depth + 1),
          }
        : variant.const !== undefined
          ? { kind: 'constValue', value: variant.const }
          : variant.enum
            ? { kind: 'enumFirst', value: variant.enum[0] }
            : { kind: 'node', node: compileNode(variant, definitions, refs, depth + 1) };
  return { tag, matcher, body };
}

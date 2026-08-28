import type { JsonSchema } from './schema.js';

/**
 * The canonical schema shape used by generated binary codecs.
 *
 * The Rust runtime still receives the original JSON Schema, but every
 * TypeScript-side generator (JS and C++) must make the same decisions from
 * this IR: declaration-order structs, sorted map/variant keys, optional
 * presence tags, and recursive references.
 */
export type CodecIrNode =
  | { kind: 'boolean' }
  | { kind: 'integer'; format?: string }
  | { kind: 'number'; format?: string }
  | { kind: 'string' }
  | { kind: 'null' }
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'enum'; values: (string | number | boolean | null)[] }
  | { kind: 'ref'; name: string }
  | { kind: 'optional'; inner: CodecIrNode }
  | { kind: 'sequence'; item: CodecIrNode; unique: boolean }
  | { kind: 'tuple'; items: CodecIrNode[] }
  | { kind: 'map'; value: CodecIrNode }
  | {
      kind: 'struct';
      fields: { name: string; node: CodecIrNode; optional: boolean }[];
    }
  | {
      kind: 'variant';
      key: string;
      node: CodecIrNode;
      wrapper: 'value' | 'property' | 'discriminator' | 'direct';
      property?: string;
      discriminator?: { key: string; value: string | number | boolean | null };
    }
  | {
      kind: 'oneOf';
      variants: {
        key: string;
        node: CodecIrNode;
        wrapper: 'value' | 'property' | 'discriminator' | 'direct';
        property?: string;
        discriminator?: { key: string; value: string | number | boolean | null };
      }[];
    };

export type CodecIrResult = { ok: true; node: CodecIrNode } | { ok: false; reason: string };

const MAX_SCHEMA_DEPTH = 32;

function refName(ref: string): string {
  return ref.slice(ref.lastIndexOf('/') + 1);
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Sort keys by the bytes put on the wire, not by UTF-16 code units. */
export function compareCodecKeys(left: string, right: string): number {
  const a = utf8(left);
  const b = utf8(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function primitive(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function explicitVariantKeys(schema: JsonSchema, count: number): string[] | null {
  const value = schema['x-rustra-variant-order'];
  if (
    !Array.isArray(value) ||
    value.length !== count ||
    !value.every((item) => typeof item === 'string')
  ) {
    return null;
  }
  const keys = value as string[];
  return new Set(keys).size === keys.length ? keys : null;
}

/** Derives the stable identity used by both TS and C++ oneOf codecs. */
export function codecVariantKey(schema: JsonSchema): string | null {
  if (primitive(schema.const) && typeof schema.const === 'string') return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length === 1 && primitive(schema.enum[0])) {
    return String(schema.enum[0]);
  }
  if (schema.properties) {
    const discriminator = Object.entries(schema.properties).find(
      ([, value]) => primitive(value.const) && value.const !== undefined,
    );
    if (discriminator) return String(discriminator[1].const);
    const keys = Object.keys(schema.properties);
    if (keys.length === 1) return keys[0];
  }
  return typeof schema.title === 'string' ? schema.title : null;
}

function discriminator(
  schema: JsonSchema,
): { key: string; value: string | number | boolean | null } | null {
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    if (primitive(value.const) && value.const !== undefined) {
      return { key, value: value.const as string | number | boolean | null };
    }
  }
  return null;
}

function optionalInner(schema: JsonSchema): JsonSchema | null {
  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter((type) => type !== 'null');
    if (schema.type.length === 2 && nonNull.length === 1) {
      return { ...schema, type: nonNull[0] };
    }
  }
  if (schema.anyOf?.length === 2) {
    const nonNull = schema.anyOf.filter((item) => item.type !== 'null');
    if (nonNull.length === 1) return nonNull[0];
  }
  return null;
}

function variantNode(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema>,
  refs: Set<string>,
  depth: number,
): CodecIrResult {
  const tag = discriminator(schema);
  if (tag && schema.type === 'object') {
    const required = new Set(schema.required ?? []);
    const fields: { name: string; node: CodecIrNode; optional: boolean }[] = [];
    for (const [name, field] of Object.entries(schema.properties ?? {})) {
      if (name === tag.key) continue;
      const result = buildIr(field, definitions, refs, depth + 1);
      if (!result.ok) return { ok: false, reason: `${name}: ${result.reason}` };
      fields.push({ name, node: result.node, optional: !required.has(name) });
    }
    return {
      ok: true,
      node: {
        kind: 'variant',
        key: String(tag.value),
        wrapper: 'discriminator',
        discriminator: tag,
        node: { kind: 'struct', fields },
      },
    };
  }
  const properties = schema.properties;
  if (properties && Object.keys(properties).length === 1) {
    const [property, propertySchema] = Object.entries(properties)[0];
    const child = buildIr(propertySchema, definitions, refs, depth + 1);
    if (!child.ok) return child;
    return {
      ok: true,
      node: { kind: 'variant', key: property, wrapper: 'property', property, node: child.node },
    };
  }
  if (schema.const !== undefined) {
    if (!primitive(schema.const)) return { ok: false, reason: 'oneOf const must be a primitive' };
    return {
      ok: true,
      node: {
        kind: 'variant',
        key: String(schema.const),
        wrapper: 'value',
        node: { kind: 'literal', value: schema.const },
      },
    };
  }
  if (schema.enum) {
    if (schema.enum.length !== 1 || !primitive(schema.enum[0]))
      return { ok: false, reason: 'oneOf enum variants must contain one primitive value' };
    return {
      ok: true,
      node: {
        kind: 'variant',
        key: String(schema.enum[0]),
        wrapper: 'value',
        node: { kind: 'literal', value: schema.enum[0] },
      },
    };
  }
  const child = buildIr(schema, definitions, refs, depth + 1);
  if (!child.ok) return child;
  return {
    ok: true,
    node: {
      kind: 'variant',
      key: codecVariantKey(schema) ?? '',
      wrapper: 'direct',
      node: child.node,
    },
  };
}

function buildIr(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema>,
  refs: Set<string>,
  depth: number,
): CodecIrResult {
  if (depth > MAX_SCHEMA_DEPTH) return { ok: false, reason: 'schema depth exceeded' };

  if (schema.$ref) {
    const name = refName(schema.$ref);
    const definition = definitions[name];
    if (!definition) return { ok: false, reason: `missing schema definition ${schema.$ref}` };
    if (refs.has(name)) return { ok: true, node: { kind: 'ref', name } };
    const nextRefs = new Set(refs);
    nextRefs.add(name);
    const result = buildIr(definition, definitions, nextRefs, depth + 1);
    return result.ok ? { ok: true, node: { kind: 'ref', name } } : result;
  }

  if (schema.allOf) {
    if (schema.allOf.length !== 1) return { ok: false, reason: 'multi-entry allOf is unsupported' };
    return buildIr(schema.allOf[0], definitions, refs, depth + 1);
  }

  const inner = optionalInner(schema);
  if (inner) {
    const result = buildIr(inner, definitions, refs, depth + 1);
    return result.ok ? { ok: true, node: { kind: 'optional', inner: result.node } } : result;
  }

  if (schema.oneOf) {
    if (schema.oneOf.length === 0) return { ok: false, reason: 'oneOf must not be empty' };
    const explicit = explicitVariantKeys(schema, schema.oneOf.length);
    const variants = schema.oneOf.map((variant, index) => {
      const result = variantNode(variant, definitions, refs, depth + 1);
      if (!result.ok) return result;
      const derived = result.node.kind === 'variant' ? result.node.key : null;
      const key = explicit?.[index] ?? (derived || codecVariantKey(variant));
      if (!key)
        return {
          ok: false as const,
          reason: 'oneOf variants require a stable key or x-rustra-variant-order',
        };
      return { ok: true as const, key, node: result.node };
    });
    const failed = variants.find((variant) => !variant.ok);
    if (failed && !failed.ok) return failed;
    const resolved = variants as { ok: true; key: string; node: CodecIrNode }[];
    if (new Set(resolved.map((variant) => variant.key)).size !== resolved.length) {
      return { ok: false, reason: 'oneOf variant keys must be unique' };
    }
    resolved.sort((left, right) => compareCodecKeys(left.key, right.key));
    return {
      ok: true,
      node: {
        kind: 'oneOf',
        variants: resolved.map((variant) => {
          const node = variant.node;
          if (node.kind !== 'variant') throw new Error('internal codec IR variant error');
          return {
            key: variant.key,
            node: node.node,
            wrapper: node.wrapper,
            property: node.property,
            discriminator: node.discriminator,
          };
        }),
      },
    };
  }

  if (schema.enum) {
    if (schema.enum.length === 0 || !schema.enum.every(primitive))
      return { ok: false, reason: 'enum values must be primitives' };
    return { ok: true, node: { kind: 'enum', values: schema.enum } };
  }
  if (schema.const !== undefined) {
    if (!primitive(schema.const)) return { ok: false, reason: 'const must be a primitive' };
    return { ok: true, node: { kind: 'literal', value: schema.const } };
  }

  if (schema.type === 'boolean') return { ok: true, node: { kind: 'boolean' } };
  if (schema.type === 'integer')
    return { ok: true, node: { kind: 'integer', format: schema.format } };
  if (schema.type === 'number')
    return { ok: true, node: { kind: 'number', format: schema.format } };
  if (schema.type === 'string') return { ok: true, node: { kind: 'string' } };
  if (schema.type === 'null') return { ok: true, node: { kind: 'null' } };

  if (schema.type === 'array') {
    if (Array.isArray(schema.items)) {
      const items = schema.items.map((item) => buildIr(item, definitions, refs, depth + 1));
      const failed = items.find((item) => !item.ok);
      if (failed && !failed.ok) return failed;
      return {
        ok: true,
        node: {
          kind: 'tuple',
          items: (items as { ok: true; node: CodecIrNode }[]).map((item) => item.node),
        },
      };
    }
    if (!schema.items || typeof schema.items === 'boolean')
      return { ok: false, reason: 'array schema is missing items' };
    const item = buildIr(schema.items, definitions, refs, depth + 1);
    return item.ok
      ? {
          ok: true,
          node: { kind: 'sequence', item: item.node, unique: schema.uniqueItems === true },
        }
      : item;
  }

  if (schema.type === 'object') {
    if (schema.additionalProperties !== undefined && !schema.properties) {
      if (typeof schema.additionalProperties === 'boolean')
        return { ok: false, reason: 'untyped object map is unsupported' };
      const value = buildIr(schema.additionalProperties, definitions, refs, depth + 1);
      return value.ok ? { ok: true, node: { kind: 'map', value: value.node } } : value;
    }
    if (schema.additionalProperties === true)
      return { ok: false, reason: 'open object properties are unsupported' };
    const required = new Set(schema.required ?? []);
    const fields: { name: string; node: CodecIrNode; optional: boolean }[] = [];
    for (const [name, field] of Object.entries(schema.properties ?? {})) {
      const result = buildIr(field, definitions, refs, depth + 1);
      if (!result.ok) return { ok: false, reason: `${name}: ${result.reason}` };
      fields.push({ name, node: result.node, optional: !required.has(name) });
    }
    return { ok: true, node: { kind: 'struct', fields } };
  }

  return { ok: false, reason: `unsupported schema type ${String(schema.type)}` };
}

/** Normalize a JSON Schema into the canonical recursive codec representation. */
export function buildCodecIr(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema>,
): CodecIrResult {
  return buildIr(schema, definitions, new Set(), 0);
}

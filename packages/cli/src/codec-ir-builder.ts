import type { JsonSchema } from './schema.js';
import type { CodecIrNode, CodecIrResult } from './codec-ir-types.js';
import {
  codecVariantKey,
  compareCodecKeys,
  explicitVariantKeys,
  MAX_SCHEMA_DEPTH,
  optionalInner,
  primitive,
  refName,
} from './codec-ir-keys.js';
import { variantNode } from './codec-ir-variants.js';

export function buildIr(
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

import type { JsonSchema } from './schema.js';
import type { CodecIrNode, CodecIrResult } from './codec-ir-types.js';
import { codecVariantKey, discriminator, primitive } from './codec-ir-keys.js';
import { buildIr } from './codec-ir-builder.js';

export function variantNode(
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

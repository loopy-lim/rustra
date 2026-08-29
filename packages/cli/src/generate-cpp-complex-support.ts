import type { CodecIrNode } from './codec-ir.js';
import { buildCodecIr } from './codec-ir.js';

export function cppComplexPrimitiveElement(node: CodecIrNode): boolean {
  switch (node.kind) {
    case 'boolean':
    case 'integer':
    case 'number':
    case 'string':
    case 'literal':
    case 'enum':
      return true;
    default:
      return false;
  }
}

export function cppComplexNativeSupported(
  node: CodecIrNode,
  definitions: Record<string, import('./schema.js').JsonSchema>,
  seen = new Set<string>(),
): boolean {
  switch (node.kind) {
    case 'integer':
      return true;
    case 'sequence':
      return (
        (node.unique ? cppComplexPrimitiveElement(node.item) : true) &&
        cppComplexNativeSupported(node.item, definitions, seen)
      );
    case 'tuple':
      return node.items.every((item) => cppComplexNativeSupported(item, definitions, seen));
    case 'map':
      return cppComplexNativeSupported(node.value, definitions, seen);
    case 'struct':
      return node.fields.every((field) => cppComplexNativeSupported(field.node, definitions, seen));
    case 'optional':
      return cppComplexNativeSupported(node.inner, definitions, seen);
    case 'oneOf':
      return node.variants.every((variant) =>
        cppComplexNativeSupported(variant.node, definitions, seen),
      );
    case 'ref': {
      if (seen.has(node.name)) return true;
      const definition = definitions[node.name];
      const result = definition
        ? buildCodecIr(definition, definitions)
        : { ok: false as const, reason: 'missing definition' };
      if (!result.ok) return false;
      const nextSeen = new Set(seen);
      nextSeen.add(node.name);
      return cppComplexNativeSupported(result.node, definitions, nextSeen);
    }
    case 'variant':
      return cppComplexNativeSupported(node.node, definitions, seen);
    default:
      return true;
  }
}

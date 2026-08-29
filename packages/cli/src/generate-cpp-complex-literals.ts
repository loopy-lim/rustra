import type { CodecIrNode } from './codec-ir.js';

export type ComplexVariantIr = Extract<CodecIrNode, { kind: 'oneOf' }>['variants'][number];
export type CppComplexState = { counter: number };

export function cppComplexName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}
export function cppComplexEncodeName(name: string): string {
  return `complex_encode_ref_${cppComplexName(name)}`;
}
export function cppComplexDecodeName(name: string): string {
  return `complex_decode_ref_${cppComplexName(name)}`;
}

export function cppLiteral(value: string | number | boolean | null): string {
  if (value === null) return 'jsi::Value::null()';
  if (typeof value === 'string') {
    const literal = JSON.stringify(value);
    return `jsi::String::createFromUtf8(rt, reinterpret_cast<const uint8_t*>(${literal}), sizeof(${literal}) - 1)`;
  }
  if (typeof value === 'boolean') return value ? 'jsi::Value(true)' : 'jsi::Value(false)';
  return `jsi::Value(${String(value)})`;
}

export function cppLiteralPredicate(
  value: string,
  literal: string | number | boolean | null,
): string {
  if (literal === null) return `${value}.isNull()`;
  if (typeof literal === 'string')
    return `${value}.isString() && ${value}.getString(rt).utf8(rt) == std::string(${JSON.stringify(literal)})`;
  if (typeof literal === 'boolean')
    return `${value}.isBool() && ${value}.getBool() == ${literal ? 'true' : 'false'}`;
  return `${value}.isNumber() && ${value}.asNumber() == ${String(literal)}`;
}

export function cppComplexNodePredicate(node: CodecIrNode, value: string): string {
  switch (node.kind) {
    case 'literal':
      return cppLiteralPredicate(value, node.value);
    case 'enum':
      return node.values.map((item) => cppLiteralPredicate(value, item)).join(' || ');
    case 'boolean':
      return `${value}.isBool()`;
    case 'integer':
    case 'number':
      return `${value}.isNumber()`;
    case 'string':
      return `${value}.isString()`;
    case 'null':
      return `${value}.isNull()`;
    case 'sequence':
    case 'tuple':
      return `${value}.isObject() && ${value}.asObject(rt).isArray(rt)`;
    case 'map':
    case 'struct':
    case 'ref':
    case 'oneOf':
      return `${value}.isObject() && !${value}.asObject(rt).isArray(rt)`;
    case 'optional':
      return `${value}.isNull() || ${cppComplexNodePredicate(node.inner, value)}`;
    case 'variant':
      return cppComplexNodePredicate(node.node, value);
  }
}

export function cppComplexVariantPredicate(variant: ComplexVariantIr, value: string): string {
  if (variant.wrapper === 'value') return cppComplexNodePredicate(variant.node, value);
  if (variant.wrapper === 'property')
    return `${value}.isObject() && ${value}.asObject(rt).hasProperty(rt, ${JSON.stringify(variant.property)})`;
  if (variant.wrapper === 'discriminator' && variant.discriminator) {
    const property = `${value}.asObject(rt).getProperty(rt, ${JSON.stringify(variant.discriminator.key)})`;
    return `${value}.isObject() && ${cppLiteralPredicate(property, variant.discriminator.value)}`;
  }
  return cppComplexNodePredicate(variant.node, value);
}

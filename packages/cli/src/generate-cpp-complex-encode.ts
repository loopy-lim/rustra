import type { CodecIrNode } from './codec-ir.js';
import {
  cppComplexEncodeName,
  cppComplexVariantPredicate,
  cppLiteralPredicate,
  type CppComplexState,
} from './generate-cpp-complex-literals.js';

export function cppComplexEncodeNode(
  node: CodecIrNode,
  value: string,
  indent: string,
  depth: string,
  state: CppComplexState,
): string[] {
  const next = () => `_cx${state.counter++}`;
  switch (node.kind) {
    case 'boolean':
      return [
        `${indent}if (!${value}.isBool()) throw jsi::JSError(rt, "complex boolean expected");`,
        `${indent}w.push_bool(${value}.getBool());`,
      ];
    case 'integer':
      return [
        `${indent}w.${node.format?.startsWith('uint') ? 'push_uvar(rustra_u64' : 'push_i64(rustra_i64'}(rt, ${value}, "complex integer"));`,
      ];
    case 'number':
      return [
        `${indent}w.${node.format === 'float' ? 'push_f32(rustra_f32' : 'push_f64(rustra_f64'}(rt, ${value}, "complex number"));`,
      ];
    case 'string':
      return [
        `${indent}if (!${value}.isString()) throw jsi::JSError(rt, "complex string expected");`,
        `${indent}w.push_string(${value}.getString(rt).utf8(rt));`,
      ];
    case 'null':
      return [`${indent}if (!${value}.isNull()) throw jsi::JSError(rt, "complex null expected");`];
    case 'literal':
      return [
        `${indent}if (!(${cppLiteralPredicate(value, node.value)})) throw jsi::JSError(rt, "complex literal mismatch");`,
      ];
    case 'enum': {
      const index = next();
      const lines = [`${indent}{ int ${index} = -1;`];
      node.values.forEach((item, itemIndex) =>
        lines.push(`${indent}  if (${cppLiteralPredicate(value, item)}) ${index} = ${itemIndex};`),
      );
      lines.push(
        `${indent}  if (${index} < 0) throw jsi::JSError(rt, "complex enum value mismatch");`,
        `${indent}  w.push_uvar(static_cast<uint64_t>(${index})); }`,
      );
      return lines;
    }
    case 'ref':
      return [`${indent}${cppComplexEncodeName(node.name)}(rt, ${value}, w, ${depth});`];
    case 'optional':
      return [
        `${indent}{ if (${value}.isNull() || ${value}.isUndefined()) { w.push_u8(0); } else { w.push_u8(1);`,
        ...cppComplexEncodeNode(node.inner, value, `${indent}  `, `${depth} + 1`, state),
        `${indent}} }`,
      ];
    case 'sequence': {
      const object = next();
      const array = next();
      const length = next();
      if (node.unique)
        return [
          `${indent}{ auto ${array} = [&]() -> jsi::Array {`,
          `${indent}    if (!${value}.isObject()) throw jsi::JSError(rt, "complex Set or array expected");`,
          `${indent}    auto ${object} = ${value}.asObject(rt);`,
          `${indent}    if (${object}.isArray(rt)) return ${object}.getArray(rt);`,
          `${indent}    if (!${object}.instanceOf(rt, rt.global().getPropertyAsFunction(rt, "Set"))) throw jsi::JSError(rt, "complex Set or array expected");`,
          `${indent}    auto _from = rt.global().getPropertyAsFunction(rt, "Array").getPropertyAsFunction(rt, "from");`,
          `${indent}    return _from.call(rt, jsi::Value(rt, ${value})).asObject(rt).getArray(rt);`,
          `${indent}  }();`,
          `${indent}  auto ${length} = ${array}.length(rt);`,
          `${indent}  w.push_uvar(${length});`,
          `${indent}  for (size_t _i = 0; _i < ${length}; _i++) {`,
          ...cppComplexEncodeNode(
            node.item,
            `${array}.getValueAtIndex(rt, _i)`,
            `${indent}    `,
            `${depth} + 1`,
            state,
          ),
          `${indent}  } }`,
        ];
      return [
        `${indent}{ auto ${object} = ${value}.asObject(rt);`,
        `${indent}  if (!${value}.isObject() || !${object}.isArray(rt)) throw jsi::JSError(rt, "complex array expected");`,
        `${indent}  auto ${array} = ${object}.getArray(rt); auto ${length} = ${array}.length(rt);`,
        `${indent}  w.push_uvar(${length});`,
        `${indent}  for (size_t _i = 0; _i < ${length}; _i++) {`,
        ...cppComplexEncodeNode(
          node.item,
          `${array}.getValueAtIndex(rt, _i)`,
          `${indent}    `,
          `${depth} + 1`,
          state,
        ),
        `${indent}  } }`,
      ];
    }
    case 'tuple': {
      const object = next();
      const array = next();
      const lines = [
        `${indent}{ auto ${object} = ${value}.asObject(rt);`,
        `${indent}  if (!${value}.isObject() || !${object}.isArray(rt) || ${object}.getArray(rt).length(rt) != ${node.items.length}) throw jsi::JSError(rt, "complex tuple length mismatch");`,
        `${indent}  auto ${array} = ${object}.getArray(rt); w.push_uvar(${node.items.length});`,
      ];
      node.items.forEach((item, index) =>
        lines.push(
          ...cppComplexEncodeNode(
            item,
            `${array}.getValueAtIndex(rt, ${index})`,
            `${indent}  `,
            `${depth} + 1`,
            state,
          ),
        ),
      );
      lines.push(`${indent}}`);
      return lines;
    }
    case 'map': {
      const object = next();
      const names = next();
      const entries = next();
      return [
        `${indent}{ if (!${value}.isObject() || ${value}.asObject(rt).isArray(rt)) throw jsi::JSError(rt, "complex object map expected");`,
        `${indent}  auto ${object} = ${value}.asObject(rt); auto ${names} = ${object}.getPropertyNames(rt);`,
        `${indent}  std::vector<std::pair<std::string, jsi::Value>> ${entries};`,
        `${indent}  for (size_t _i = 0; _i < ${names}.length(rt); _i++) { auto _key = ${names}.getValueAtIndex(rt, _i).getString(rt).utf8(rt); auto _property = ${object}.getProperty(rt, jsi::String::createFromUtf8(rt, reinterpret_cast<const uint8_t*>(_key.data()), _key.size())); ${entries}.push_back({_key, std::move(_property)}); }`,
        `${indent}  std::sort(${entries}.begin(), ${entries}.end(), [](const auto& _a, const auto& _b) { const auto& a = _a.first; const auto& b = _b.first; const size_t n = std::min(a.size(), b.size()); for (size_t i = 0; i < n; ++i) { const auto ca = static_cast<unsigned char>(a[i]); const auto cb = static_cast<unsigned char>(b[i]); if (ca != cb) return ca < cb; } return a.size() < b.size(); });`,
        `${indent}  w.push_uvar(${entries}.size()); for (auto& _entry : ${entries}) { w.push_string(_entry.first); auto& _value = _entry.second;`,
        ...cppComplexEncodeNode(node.value, '_value', `${indent}    `, `${depth} + 1`, state),
        `${indent}  } }`,
      ];
    }
    case 'struct': {
      const object = next();
      const lines = [
        `${indent}{ if (!${value}.isObject() || ${value}.asObject(rt).isArray(rt)) throw jsi::JSError(rt, "complex object expected");`,
        `${indent}  auto ${object} = ${value}.asObject(rt);`,
      ];
      for (const field of node.fields) {
        const fieldValue = next();
        const property = JSON.stringify(field.name);
        if (field.optional)
          lines.push(
            `${indent}  auto ${fieldValue} = ${object}.getProperty(rt, ${property}); if (${object}.hasProperty(rt, ${property}) && !${fieldValue}.isUndefined()) { w.push_u8(1);`,
            ...cppComplexEncodeNode(field.node, fieldValue, `${indent}    `, `${depth} + 1`, state),
            `${indent}  } else { w.push_u8(0); }`,
          );
        else
          lines.push(
            `${indent}  auto ${fieldValue} = ${object}.getProperty(rt, ${property});`,
            ...cppComplexEncodeNode(field.node, fieldValue, `${indent}  `, `${depth} + 1`, state),
          );
      }
      lines.push(`${indent}}`);
      return lines;
    }
    case 'oneOf': {
      const index = next();
      const lines = [`${indent}{ int ${index} = -1;`];
      node.variants.forEach((variant, variantIndex) =>
        lines.push(
          `${indent}  if (${cppComplexVariantPredicate(variant, value)}) ${index} = ${variantIndex};`,
        ),
      );
      lines.push(
        `${indent}  if (${index} < 0) throw jsi::JSError(rt, "complex oneOf value mismatch");`,
        `${indent}  w.push_uvar(static_cast<uint64_t>(${index}));`,
      );
      node.variants.forEach((variant, variantIndex) => {
        lines.push(`${indent}  if (${index} == ${variantIndex}) {`);
        if (variant.wrapper === 'property' && variant.property) {
          const object = next();
          lines.push(
            `${indent}    auto ${object} = ${value}.asObject(rt);`,
            ...cppComplexEncodeNode(
              variant.node,
              `${object}.getProperty(rt, ${JSON.stringify(variant.property)})`,
              `${indent}    `,
              `${depth} + 1`,
              state,
            ),
          );
        } else
          lines.push(
            ...cppComplexEncodeNode(variant.node, value, `${indent}    `, `${depth} + 1`, state),
          );
        lines.push(`${indent}  }`);
      });
      lines.push(`${indent}}`);
      return lines;
    }
    case 'variant':
      return cppComplexEncodeNode(node.node, value, indent, depth, state);
  }
}

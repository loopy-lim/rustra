import type { CodecIrNode } from './codec-ir.js';
import {
  cppLiteral,
  cppComplexDecodeName,
  type CppComplexState,
} from './generate-cpp-complex-literals.js';

export function cppComplexDecodeExpr(
  node: CodecIrNode,
  depth: string,
  state: CppComplexState,
): string {
  const next = () => `_cx${state.counter++}`;
  switch (node.kind) {
    case 'boolean':
      return 'jsi::Value(r.read_bool())';
    case 'integer':
      return node.format?.startsWith('uint')
        ? '[&]() -> jsi::Value { auto _v = r.read_uvar(); if (_v <= 9007199254740991ull) return jsi::Value(static_cast<double>(_v)); return jsi::Value(rt, jsi::BigInt::fromUint64(rt, _v)); }()'
        : '[&]() -> jsi::Value { auto _v = r.read_i64(); if (_v >= -9007199254740991ll && _v <= 9007199254740991ll) return jsi::Value(static_cast<double>(_v)); return jsi::Value(rt, jsi::BigInt::fromInt64(rt, _v)); }()';
    case 'number':
      return node.format === 'float'
        ? 'jsi::Value(static_cast<double>(r.read_f32()))'
        : 'jsi::Value(r.read_f64())';
    case 'string':
      return '[&]() -> jsi::Value { auto _s = r.read_string_view(); return jsi::String::createFromUtf8(rt, _s.data, _s.size); }()';
    case 'null':
      return 'jsi::Value::null()';
    case 'literal':
      return cppLiteral(node.value);
    case 'enum': {
      const index = next();
      const lines = [`[&]() -> jsi::Value { auto ${index} = r.read_uvar();`];
      node.values.forEach((value, valueIndex) =>
        lines.push(` if (${index} == ${valueIndex}) return ${cppLiteral(value)};`),
      );
      lines.push(' throw std::runtime_error("complex enum index out of range"); }()');
      return lines.join('');
    }
    case 'ref':
      return `${cppComplexDecodeName(node.name)}(rt, r, ${depth})`;
    case 'optional': {
      const tag = next();
      return `[&]() -> jsi::Value { auto ${tag} = r.read_u8(); if (${tag} == 0) return jsi::Value::null(); if (${tag} != 1) throw std::runtime_error("complex optional presence tag"); return ${cppComplexDecodeExpr(node.inner, `${depth} + 1`, state)}; }()`;
    }
    case 'sequence': {
      const length = next();
      const array = next();
      if (node.unique)
        return `[&]() -> jsi::Value { auto ${length} = r.read_uvar(); if (${length} > 100000) throw std::runtime_error("complex collection length exceeds 100000"); auto ${array} = jsi::Array(rt, static_cast<size_t>(${length})); for (size_t _i = 0; _i < ${length}; _i++) ${array}.setValueAtIndex(rt, _i, ${cppComplexDecodeExpr(node.item, `${depth} + 1`, state)}); return rt.global().getPropertyAsFunction(rt, "Set").callAsConstructor(rt, jsi::Value(rt, ${array})); }()`;
      return `[&]() -> jsi::Value { auto ${length} = r.read_uvar(); if (${length} > 100000) throw std::runtime_error("complex collection length exceeds 100000"); auto ${array} = jsi::Array(rt, static_cast<size_t>(${length})); for (size_t _i = 0; _i < ${length}; _i++) ${array}.setValueAtIndex(rt, _i, ${cppComplexDecodeExpr(node.item, `${depth} + 1`, state)}); return ${array}; }()`;
    }
    case 'tuple': {
      const length = next();
      const array = next();
      const lines = [
        `[&]() -> jsi::Value { auto ${length} = r.read_uvar(); if (${length} != ${node.items.length}) throw std::runtime_error("complex tuple length mismatch"); auto ${array} = jsi::Array(rt, ${node.items.length});`,
      ];
      node.items.forEach((item, index) =>
        lines.push(
          `${array}.setValueAtIndex(rt, ${index}, ${cppComplexDecodeExpr(item, `${depth} + 1`, state)});`,
        ),
      );
      lines.push(`return ${array}; }()`);
      return lines.join(' ');
    }
    case 'map': {
      const length = next();
      const object = next();
      const key = next();
      return `[&]() -> jsi::Value { auto ${length} = r.read_uvar(); if (${length} > 100000) throw std::runtime_error("complex map length exceeds 100000"); auto ${object} = jsi::Object(rt); for (size_t _i = 0; _i < ${length}; _i++) { auto ${key} = r.read_string_view(); auto _keyValue = jsi::String::createFromUtf8(rt, ${key}.data, ${key}.size); ${object}.setProperty(rt, _keyValue, ${cppComplexDecodeExpr(node.value, `${depth} + 1`, state)}); } return ${object}; }()`;
    }
    case 'struct': {
      const object = next();
      const lines = [`[&]() -> jsi::Value { auto ${object} = jsi::Object(rt);`];
      for (const field of node.fields) {
        const property = JSON.stringify(field.name);
        const value = cppComplexDecodeExpr(field.node, `${depth} + 1`, state);
        if (field.optional) {
          const tag = next();
          lines.push(
            ` auto ${tag} = r.read_u8(); if (${tag} > 1) throw std::runtime_error("complex optional field presence tag"); if (${tag} == 1) ${object}.setProperty(rt, ${property}, ${value});`,
          );
        } else lines.push(` ${object}.setProperty(rt, ${property}, ${value});`);
      }
      lines.push(` return ${object}; }()`);
      return lines.join('');
    }
    case 'oneOf': {
      const index = next();
      const lines = [`[&]() -> jsi::Value { auto ${index} = r.read_uvar();`];
      node.variants.forEach((variant, variantIndex) => {
        let value = cppComplexDecodeExpr(variant.node, `${depth} + 1`, state);
        if (variant.wrapper === 'property' && variant.property) {
          const object = next();
          value = `[&]() -> jsi::Value { auto ${object} = jsi::Object(rt); ${object}.setProperty(rt, ${JSON.stringify(variant.property)}, ${value}); return ${object}; }()`;
        } else if (variant.wrapper === 'discriminator' && variant.discriminator) {
          const decoded = next();
          const object = next();
          value = `[&]() -> jsi::Value { auto ${decoded} = ${value}; auto ${object} = ${decoded}.asObject(rt); ${object}.setProperty(rt, ${JSON.stringify(variant.discriminator.key)}, ${cppLiteral(variant.discriminator.value)}); return ${object}; }()`;
        }
        lines.push(` if (${index} == ${variantIndex}) return ${value};`);
      });
      lines.push(' throw std::runtime_error("complex oneOf index out of range"); }()');
      return lines.join('');
    }
    case 'variant':
      return cppComplexDecodeExpr(node.node, depth, state);
  }
}

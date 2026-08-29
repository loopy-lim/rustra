import type { PostcardField } from './generate-postcard-types.js';
import { OPTION_INNER_KIND } from './generate-postcard-types.js';
import { collectPostcardFields } from './generate-postcard-graph.js';

const safeInt = '9007199254740991';

export function cppFieldDecodeExpr(
  field: PostcardField,
  objExpr: string,
  definitions: Record<string, import('./schema.js').JsonSchema>,
  indent: string,
): string {
  const setProp = (value: string) =>
    `${indent}${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), ${value});`;
  switch (field.kind) {
    case 'zigzag':
      return setProp('(double)r.read_i64()');
    case 'zigzag64':
      return setProp(
        `[&]() -> jsi::Value { auto _v = r.read_i64(); if (_v >= -${safeInt}ll && _v <= ${safeInt}ll) return jsi::Value(static_cast<double>(_v)); return jsi::Value(rt, jsi::BigInt::fromInt64(rt, _v)); }()`,
      );
    case 'uvar':
      return setProp('(double)r.read_uvar()');
    case 'uvar64':
      return setProp(
        `[&]() -> jsi::Value { auto _v = r.read_uvar(); if (_v <= ${safeInt}ull) return jsi::Value(static_cast<double>(_v)); return jsi::Value(rt, jsi::BigInt::fromUint64(rt, _v)); }()`,
      );
    case 'f64':
      return setProp('r.read_f64()');
    case 'f32':
      return setProp('(double)r.read_f32()');
    case 'bool':
      return setProp('r.read_bool()');
    case 'string':
      return `${indent}{ auto _s = r.read_string_view(); ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), jsi::String::createFromUtf8(rt, _s.data, _s.size)); }`;
    case 'bytes':
      return `${indent}{ auto _n = r.read_uvar(); auto _bytes = r.read_bytes_view((size_t)_n); ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), rustra::generated::make_array_buffer(rt, _bytes.data, _bytes.size)); }`;
    case 'vec_zigzag':
      return `${indent}{ auto _n = r.read_uvar(); auto _arr = jsi::Array(rt, (size_t)_n); for (size_t _i = 0; _i < _n; _i++) { _arr.setValueAtIndex(rt, _i, (double)r.read_i64()); } ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), _arr); }`;
    case 'vec_i64':
    case 'set_i64':
      return `${indent}{ auto _n = r.read_uvar(); auto _arr = jsi::Array(rt, (size_t)_n); for (size_t _i = 0; _i < _n; _i++) { auto _v = r.read_i64(); _arr.setValueAtIndex(rt, _i, _v >= -${safeInt}ll && _v <= ${safeInt}ll ? jsi::Value(static_cast<double>(_v)) : jsi::Value(rt, jsi::BigInt::fromInt64(rt, _v))); } ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), _arr); }`;
    case 'vec_u64':
    case 'set_u64':
      return `${indent}{ auto _n = r.read_uvar(); auto _arr = jsi::Array(rt, (size_t)_n); for (size_t _i = 0; _i < _n; _i++) { auto _v = r.read_uvar(); _arr.setValueAtIndex(rt, _i, _v <= ${safeInt}ull ? jsi::Value(static_cast<double>(_v)) : jsi::Value(rt, jsi::BigInt::fromUint64(rt, _v))); } ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), _arr); }`;
    case 'vec_f64':
      return `${indent}{ auto _n = r.read_uvar(); auto _arr = jsi::Array(rt, (size_t)_n); for (size_t _i = 0; _i < _n; _i++) { _arr.setValueAtIndex(rt, _i, r.read_f64()); } ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), _arr); }`;
    case 'vec_uvar':
      return `${indent}{ auto _n = r.read_uvar(); auto _arr = jsi::Array(rt, (size_t)_n); for (size_t _i = 0; _i < _n; _i++) { _arr.setValueAtIndex(rt, _i, (double)r.read_uvar()); } ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), _arr); }`;
    case 'vec_bool':
      return `${indent}{ auto _n = r.read_uvar(); auto _arr = jsi::Array(rt, (size_t)_n); for (size_t _i = 0; _i < _n; _i++) { _arr.setValueAtIndex(rt, _i, r.read_bool()); } ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), _arr); }`;
    case 'struct': {
      if (!field.refType) return `${indent}// unknown struct field: ${field.name}`;
      const definition = definitions[field.refType];
      if (!definition) return `${indent}// missing definition for ${field.refType}`;
      const lines = [`${indent}{ auto _obj = jsi::Object(rt);`];
      for (const subField of collectPostcardFields(definition, definitions).fields)
        lines.push(cppFieldDecodeExpr(subField, '_obj', definitions, `${indent}  `));
      lines.push(
        `${indent}  ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), _obj); }`,
      );
      return lines.join('\n');
    }
    case 'vec_string':
      return `${indent}{ auto _n = r.read_uvar(); auto _arr = jsi::Array(rt, (size_t)_n); for (size_t _i = 0; _i < _n; _i++) { auto _s = r.read_string_view(); _arr.setValueAtIndex(rt, _i, jsi::String::createFromUtf8(rt, _s.data, _s.size)); } ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), _arr); }`;
    case 'map_zigzag':
    case 'map_uvar':
    case 'map_i64':
    case 'map_u64':
    case 'map_f64':
    case 'map_bool':
    case 'map_string': {
      const readVal =
        field.kind === 'map_zigzag'
          ? '_map.setProperty(rt, _k, (double)r.read_i64());'
          : field.kind === 'map_uvar'
            ? '_map.setProperty(rt, _k, (double)r.read_uvar());'
            : field.kind === 'map_i64'
              ? `{ auto _v = r.read_i64(); _map.setProperty(rt, _k, _v >= -${safeInt}ll && _v <= ${safeInt}ll ? jsi::Value(static_cast<double>(_v)) : jsi::Value(rt, jsi::BigInt::fromInt64(rt, _v))); }`
              : field.kind === 'map_u64'
                ? `{ auto _v = r.read_uvar(); _map.setProperty(rt, _k, _v <= ${safeInt}ull ? jsi::Value(static_cast<double>(_v)) : jsi::Value(rt, jsi::BigInt::fromUint64(rt, _v))); }`
                : field.kind === 'map_f64'
                  ? '_map.setProperty(rt, _k, r.read_f64());'
                  : field.kind === 'map_bool'
                    ? '_map.setProperty(rt, _k, r.read_bool());'
                    : '{ auto _vs = r.read_string_view(); _map.setProperty(rt, _k, jsi::String::createFromUtf8(rt, _vs.data, _vs.size)); }';
      return `${indent}{ auto _n = r.read_uvar(); auto _map = jsi::Object(rt); for (size_t _i = 0; _i < _n; _i++) { auto _ks = r.read_string_view(); auto _k = jsi::String::createFromUtf8(rt, _ks.data, _ks.size); ${readVal} } ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), std::move(_map)); }`;
    }
    case 'tuple': {
      const items = field.tupleItems ?? [];
      const lines = [`${indent}{ auto _arr = jsi::Array(rt, ${items.length});`];
      items.forEach((item, index) => {
        const itemObject = `_tuple_item_${index}`;
        lines.push(
          `${indent}  { auto ${itemObject} = jsi::Object(rt);`,
          cppFieldDecodeExpr({ ...item, name: 'value' }, itemObject, definitions, `${indent}    `),
          `${indent}    _arr.setValueAtIndex(rt, ${index}, ${itemObject}.getProperty(rustra::generated::cachedProp(rt, "value"))); }`,
        );
      });
      lines.push(
        `${indent}  ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), _arr); }`,
      );
      return lines.join('\n');
    }
    case 'vec_struct': {
      if (!field.refType) return `${indent}// unknown vec_struct field: ${field.name}`;
      const definition = definitions[field.refType];
      if (!definition) return `${indent}// missing definition for ${field.refType}`;
      const lines = [
        `${indent}{ auto _n = r.read_uvar(); auto _arr = jsi::Array(rt, (size_t)_n);`,
        `${indent}  for (size_t _i = 0; _i < _n; _i++) { auto _obj = jsi::Object(rt);`,
      ];
      for (const subField of collectPostcardFields(definition, definitions).fields)
        lines.push(cppFieldDecodeExpr(subField, '_obj', definitions, `${indent}    `));
      lines.push(
        `${indent}    _arr.setValueAtIndex(rt, _i, std::move(_obj)); }`,
        `${indent}  ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), _arr); }`,
      );
      return lines.join('\n');
    }
    case 'option_zigzag':
    case 'option_uvar':
    case 'option_zigzag64':
    case 'option_uvar64':
    case 'option_f64':
    case 'option_f32':
    case 'option_bool':
    case 'option_string':
    case 'option_struct':
    case 'option_bytes': {
      const inner: PostcardField = { ...field, kind: OPTION_INNER_KIND[field.kind] };
      const decoded = cppFieldDecodeExpr(inner, objExpr, definitions, '');
      return `${indent}{ auto _tag = r.read_u8(); if (_tag == 0) { ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), jsi::Value::null()); } else { ${decoded} } }`;
    }
    case 'enum_str': {
      const variants = `{${(field.enumVariants ?? []).map((variant) => JSON.stringify(variant)).join(',')}}`;
      return `${indent}{ auto _idx = r.read_uvar(); const char* _variants[] = ${variants}; if (_idx >= ${(field.enumVariants ?? []).length}) throw jsi::JSError(rt, "invalid enum index for ${field.name}"); ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), jsi::String::createFromAscii(rt, _variants[_idx])); }`;
    }
    default:
      return `${indent}// unsupported field kind: ${field.kind}`;
  }
}

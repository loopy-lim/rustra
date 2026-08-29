import type { PostcardField } from './generate-postcard-types.js';
import { OPTION_INNER_KIND } from './generate-postcard-types.js';
import { collectPostcardFields } from './generate-postcard-graph.js';

export function cppFieldEncodeExpr(
  field: PostcardField,
  objExpr: string,
  definitions: Record<string, import('./schema.js').JsonSchema>,
  indent: string,
): string {
  return cppEncodeWithGetter(
    field,
    `${objExpr}.getProperty(rt, "${field.name}")`,
    definitions,
    indent,
  );
}

export function cppEncodeWithGetter(
  field: PostcardField,
  get: string,
  definitions: Record<string, import('./schema.js').JsonSchema>,
  indent: string,
): string {
  switch (field.kind) {
    case 'zigzag':
    case 'zigzag64':
      return `${indent}w.push_i64(rustra_i64(rt, ${get}, "${field.name}"));`;
    case 'uvar':
    case 'uvar64':
      return `${indent}w.push_uvar(rustra_u64(rt, ${get}, "${field.name}"));`;
    case 'f64':
      return `${indent}w.push_f64(rustra_f64(rt, ${get}, "${field.name}"));`;
    case 'f32':
      return `${indent}w.push_f32(rustra_f32(rt, ${get}, "${field.name}"));`;
    case 'bool':
      return `${indent}{ auto _v = ${get}.getBool(); w.push_bool(_v); }`;
    case 'string':
      return `${indent}{ auto _v = ${get}.getString(rt).utf8(rt); w.push_string(_v); }`;
    case 'bytes':
      return `${indent}{ const auto& _v = ${get}; auto _o = _v.asObject(rt); if (_o.isArray(rt)) { auto _arr = _o.getArray(rt); auto _n = _arr.length(rt); w.push_uvar(_n); auto _dst = w.append_uninitialized(_n); for (size_t _i = 0; _i < _n; _i++) _dst[_i] = rustra_u8(rt, _arr.getValueAtIndex(rt, _i), "${field.name}[]"); } else { auto _span = rustra_bytes(rt, _v, "${field.name}"); w.push_uvar(_span.size); w.push_bytes(_span.data, _span.size); } }`;
    case 'vec_zigzag':
    case 'vec_i64':
      return `${indent}{ auto _arr = ${get}.asObject(rt).getArray(rt); auto _n = _arr.length(rt); w.push_uvar(_n); for (size_t _i = 0; _i < _n; _i++) w.push_i64(rustra_i64(rt, _arr.getValueAtIndex(rt, _i), "${field.name}[]")); }`;
    case 'vec_u64':
      return `${indent}{ auto _arr = ${get}.asObject(rt).getArray(rt); auto _n = _arr.length(rt); w.push_uvar(_n); for (size_t _i = 0; _i < _n; _i++) w.push_uvar(rustra_u64(rt, _arr.getValueAtIndex(rt, _i), "${field.name}[]")); }`;
    case 'set_i64':
    case 'set_u64': {
      const write =
        field.kind === 'set_i64'
          ? `w.push_i64(rustra_i64(rt, _arr.getValueAtIndex(rt, _i), "${field.name}{}"));`
          : `w.push_uvar(rustra_u64(rt, _arr.getValueAtIndex(rt, _i), "${field.name}{}"));`;
      return `${indent}{ auto _arr = ${get}.asObject(rt).getArray(rt); auto _n = _arr.length(rt); w.push_uvar(_n); for (size_t _i = 0; _i < _n; _i++) ${write} }`;
    }
    case 'vec_f64':
      return `${indent}{ auto _arr = ${get}.asObject(rt).getArray(rt); auto _n = _arr.length(rt); w.push_uvar(_n); for (size_t _i = 0; _i < _n; _i++) w.push_f64(rustra_f64(rt, _arr.getValueAtIndex(rt, _i), "${field.name}[]")); }`;
    case 'vec_bool':
      return `${indent}{ auto _arr = ${get}.asObject(rt).getArray(rt); auto _n = _arr.length(rt); w.push_uvar(_n); for (size_t _i = 0; _i < _n; _i++) { auto _e = _arr.getValueAtIndex(rt, _i).getBool(); w.push_bool(_e); } }`;
    case 'struct': {
      if (!field.refType) return `${indent}// unknown struct field: ${field.name}`;
      const definition = definitions[field.refType];
      if (!definition) return `${indent}// missing definition for ${field.refType}`;
      const object = `${get}.asObject(rt)`;
      return collectPostcardFields(definition, definitions)
        .fields.map((subField) => cppFieldEncodeExpr(subField, object, definitions, indent))
        .join('\n');
    }
    case 'vec_string':
      return `${indent}{ auto _arr = ${get}.asObject(rt).getArray(rt); auto _n = _arr.length(rt); w.push_uvar(_n); for (size_t _i = 0; _i < _n; _i++) { auto _e = _arr.getValueAtIndex(rt, _i).getString(rt).utf8(rt); w.push_string(_e); } }`;
    case 'map_zigzag':
    case 'map_uvar':
    case 'map_i64':
    case 'map_u64':
    case 'map_f64':
    case 'map_bool':
    case 'map_string': {
      const pushVal =
        field.kind === 'map_zigzag' || field.kind === 'map_i64'
          ? `w.push_i64(rustra_i64(rt, _e, "${field.name}{}"));`
          : field.kind === 'map_uvar' || field.kind === 'map_u64'
            ? `w.push_uvar(rustra_u64(rt, _e, "${field.name}{}"));`
            : field.kind === 'map_f64'
              ? `w.push_f64(rustra_f64(rt, _e, "${field.name}{}"));`
              : field.kind === 'map_bool'
                ? 'w.push_bool(_e.getBool());'
                : 'w.push_string(_e.getString(rt).utf8(rt));';
      return `${indent}{ auto _o = ${get}.asObject(rt); std::vector<std::pair<std::string, jsi::Value>> _entries; auto _names = _o.getPropertyNames(rt); for (size_t _j = 0; _j < _names.length(rt); _j++) { auto _k = _names.getValueAtIndex(rt, _j).getString(rt).utf8(rt); _entries.push_back({std::move(_k), _o.getProperty(rt, jsi::String::createFromUtf8(rt, reinterpret_cast<const uint8_t*>(_k.data()), _k.size()))}); } std::sort(_entries.begin(), _entries.end(), [](const auto& _a, const auto& _b){ return _a.first < _b.first; }); w.push_uvar(_entries.size()); for (auto& _it : _entries) { w.push_string(_it.first); jsi::Value& _e = _it.second; ${pushVal} } }`;
    }
    case 'tuple': {
      const lines = [`${indent}{ auto _arr = ${get}.asObject(rt).getArray(rt);`];
      (field.tupleItems ?? []).forEach((item, index) =>
        lines.push(
          cppEncodeWithGetter(
            item,
            `_arr.getValueAtIndex(rt, ${index})`,
            definitions,
            `${indent}  `,
          ),
        ),
      );
      lines.push(`${indent}}`);
      return lines.join('\n');
    }
    case 'vec_struct': {
      if (!field.refType) return `${indent}// unknown vec_struct field: ${field.name}`;
      const definition = definitions[field.refType];
      if (!definition) return `${indent}// missing definition for ${field.refType}`;
      const lines = [
        `${indent}{ auto _arr = ${get}.asObject(rt).getArray(rt); auto _n = _arr.length(rt); w.push_uvar(_n);`,
        `${indent}  for (size_t _i = 0; _i < _n; _i++) { auto _obj = _arr.getValueAtIndex(rt, _i).getObject(rt);`,
      ];
      for (const subField of collectPostcardFields(definition, definitions).fields)
        lines.push(cppFieldEncodeExpr(subField, '_obj', definitions, `${indent}    `));
      lines.push(`${indent}  } }`);
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
      return `${indent}{ auto _v = ${get}; if (_v.isNull() || _v.isUndefined()) { w.push_u8(0); } else { w.push_u8(1); ${cppEncodeWithGetter(inner, get, definitions, '')} } }`;
    }
    case 'enum_str': {
      const variants = `{${(field.enumVariants ?? []).map((variant) => JSON.stringify(variant)).join(',')}}`;
      return `${indent}{ auto _s = ${get}.getString(rt).utf8(rt); const char* _variants[] = ${variants}; int _idx = -1; for (int _i = 0; _i < ${(field.enumVariants ?? []).length}; _i++) { if (_s == _variants[_i]) { _idx = _i; break; } } if (_idx < 0) throw jsi::JSError(rt, "invalid enum value for ${field.name}"); w.push_uvar((uint32_t)_idx); }`;
    }
    default:
      return `${indent}// unsupported field kind: ${field.kind}`;
  }
}

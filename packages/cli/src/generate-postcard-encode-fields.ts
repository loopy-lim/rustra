import type { PostcardField } from './generate-postcard-types.js';
import { collectPostcardFields } from './generate-postcard-graph.js';
import { OPTION_INNER_KIND } from './generate-postcard-types.js';
import { generateCollectionEncodeExpr } from './generate-postcard-encode-collections.js';

export function generateFieldEncodeExpr(
  field: PostcardField,
  valueExpr: string,
  definitions: Record<string, import('./schema.js').JsonSchema>,
  indent: string,
): string {
  switch (field.kind) {
    case 'zigzag':
      return `${indent}parts.push(_pcEncodeZigzagVarint(${valueExpr}));`;
    case 'uvar':
      return `${indent}parts.push(_pcEncodeVarint(${valueExpr}));`;
    case 'zigzag64':
      return `${indent}parts.push(_pcEncodeZigzag64(${valueExpr}));`;
    case 'uvar64':
      return `${indent}parts.push(_pcEncodeVarint64(${valueExpr}));`;
    case 'f64':
      return `${indent}parts.push(_pcEncodeF64(${valueExpr}));`;
    case 'f32':
      return `${indent}parts.push(_pcEncodeF32(${valueExpr}));`;
    case 'bool':
      return `${indent}parts.push(new Uint8Array([${valueExpr} ? 1 : 0]));`;
    case 'string':
      return `${indent}parts.push(_pcEncodeString(${valueExpr}));`;
    case 'bytes': {
      return (
        `${indent}{\n` +
        `${indent}  const _b = ${valueExpr};\n` +
        `${indent}  const _u = _b instanceof Uint8Array ? _b : new Uint8Array(_b);\n` +
        `${indent}  parts.push(_pcEncodeVarint(_u.length));\n` +
        `${indent}  parts.push(_u);\n` +
        `${indent}}`
      );
    }
    case 'vec_zigzag':
    case 'vec_i64':
    case 'vec_u64':
    case 'vec_uvar':
    case 'vec_f64':
    case 'vec_bool':
    case 'set_zigzag':
    case 'set_i64':
    case 'set_u64':
    case 'set_uvar':
    case 'set_f64':
    case 'set_bool':
      return generateCollectionEncodeExpr(field.kind, valueExpr, indent);
    case 'struct': {
      if (!field.refType) return `${indent}// unknown struct field: ${field.name}`;
      const structDef = definitions[field.refType];
      if (!structDef) return `${indent}// missing definition for ${field.refType}`;
      return collectPostcardFields(structDef, definitions)
        .fields.map((subField) =>
          generateFieldEncodeExpr(subField, `${valueExpr}.${subField.name}`, definitions, indent),
        )
        .join('\n');
    }
    case 'vec_string':
      return (
        `${indent}{\n` +
        `${indent}  const _arr = ${valueExpr};\n` +
        `${indent}  parts.push(_pcEncodeVarint(_arr.length));\n` +
        `${indent}  for (let _i = 0; _i < _arr.length; _i++) {\n` +
        `${indent}    parts.push(_pcEncodeString(_arr[_i]));\n` +
        `${indent}  }\n` +
        `${indent}}`
      );
    case 'vec_struct': {
      if (!field.refType) return `${indent}// unknown vec_struct field: ${field.name}`;
      const structDef = definitions[field.refType];
      if (!structDef) return `${indent}// missing definition for ${field.refType}`;
      const lines = [
        `${indent}{`,
        `${indent}  const _arr = ${valueExpr};`,
        `${indent}  parts.push(_pcEncodeVarint(_arr.length));`,
        `${indent}  for (let _i = 0; _i < _arr.length; _i++) {`,
      ];
      for (const subField of collectPostcardFields(structDef, definitions).fields) {
        lines.push(
          generateFieldEncodeExpr(
            subField,
            `${valueExpr}[_i].${subField.name}`,
            definitions,
            `${indent}    `,
          ),
        );
      }
      lines.push(`${indent}  }`, `${indent}}`);
      return lines.join('\n');
    }
    case 'map_zigzag':
    case 'map_uvar':
    case 'map_i64':
    case 'map_u64':
    case 'map_f64':
    case 'map_bool':
    case 'map_string': {
      const valueEncoder =
        field.kind === 'map_zigzag'
          ? '_pcEncodeZigzagVarint(_v)'
          : field.kind === 'map_uvar'
            ? '_pcEncodeVarint(_v)'
            : field.kind === 'map_i64'
              ? '_pcEncodeZigzag64(_v)'
              : field.kind === 'map_u64'
                ? '_pcEncodeVarint64(_v)'
                : field.kind === 'map_f64'
                  ? '_pcEncodeF64(_v)'
                  : field.kind === 'map_bool'
                    ? 'new Uint8Array([_v ? 1 : 0])'
                    : '_pcEncodeString(_v)';
      return (
        `${indent}{\n` +
        `${indent}  const _map = ${valueExpr};\n` +
        `${indent}  const _keys = Object.keys(_map).sort();\n` +
        `${indent}  parts.push(_pcEncodeVarint(_keys.length));\n` +
        `${indent}  for (const _k of _keys) {\n` +
        `${indent}    const _v = _map[_k];\n` +
        `${indent}    parts.push(_pcEncodeString(_k));\n` +
        `${indent}    parts.push(${valueEncoder});\n` +
        `${indent}  }\n` +
        `${indent}}`
      );
    }
    case 'tuple': {
      const lines = [`${indent}{`];
      (field.tupleItems ?? []).forEach((item, index) => {
        lines.push(
          generateFieldEncodeExpr(item, `${valueExpr}[${index}]`, definitions, `${indent}  `),
        );
      });
      lines.push(`${indent}}`);
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
      const innerField: PostcardField = { ...field, kind: OPTION_INNER_KIND[field.kind] };
      return `${indent}{\n${indent}  const _opt = ${valueExpr};\n${indent}  if (_opt === null || _opt === undefined) {\n${indent}    parts.push(new Uint8Array([0]));\n${indent}  } else {\n${indent}    parts.push(new Uint8Array([1]));\n${generateFieldEncodeExpr(innerField, '_opt', definitions, `${indent}    `)}\n${indent}  }\n${indent}}`;
    }
    case 'enum_str': {
      const variants = JSON.stringify(field.enumVariants ?? []);
      return `${indent}{\n${indent}  const _variants = ${variants};\n${indent}  const _idx = _variants.indexOf(${valueExpr});\n${indent}  if (_idx < 0) throw new Error('invalid enum value for ${field.name}: ' + ${valueExpr});\n${indent}  parts.push(_pcEncodeVarint(_idx));\n${indent}}`;
    }
    default:
      return `${indent}// unsupported field kind: ${field.kind}`;
  }
}

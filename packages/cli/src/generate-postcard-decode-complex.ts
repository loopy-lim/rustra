import type { PostcardField } from './generate-postcard-types.js';
import { collectPostcardFields } from './generate-postcard-graph.js';
import { OPTION_INNER_KIND } from './generate-postcard-types.js';
import { generateCollectionDecodeExpr } from './generate-postcard-decode-collections.js';
import type { FieldDecodeGenerator } from './generate-postcard-decode-types.js';

export function generateComplexDecodeExpr(
  field: PostcardField,
  lvalue: string,
  definitions: Record<string, import('./schema.js').JsonSchema>,
  indent: string,
  generateField: FieldDecodeGenerator,
): string | null {
  if (field.kind.startsWith('vec_') || field.kind.startsWith('set_')) {
    if (field.kind !== 'vec_struct' && field.kind !== 'vec_string') {
      return generateCollectionDecodeExpr(field.kind, lvalue, indent);
    }
  }
  if (field.kind === 'struct') {
    if (!field.refType) return `${indent}// unknown struct field: ${field.name}`;
    const structDef = definitions[field.refType];
    if (!structDef) return `${indent}// missing definition for ${field.refType}`;
    const lines = [
      `${indent}{`,
      `${indent}  const _obj: ${field.refType} = {} as ${field.refType};`,
    ];
    for (const subField of collectPostcardFields(structDef, definitions).fields) {
      lines.push(generateField(subField, `_obj.${subField.name}`, definitions, `${indent}  `));
    }
    lines.push(`${indent}  ${lvalue} = _obj;`, `${indent}}`);
    return lines.join('\n');
  }
  if (field.kind === 'vec_string') {
    return `${indent}{\n${indent}  const _len = _pcDecodeVarint(u8, offset);\n${indent}  offset += _len.bytesRead;\n${indent}  const _arr: string[] = new Array(_len.value);\n${indent}  for (let _i = 0; _i < _len.value; _i++) {\n${indent}    const _v = _pcDecodeString(u8, offset);\n${indent}    _arr[_i] = _v.value;\n${indent}    offset += _v.bytesRead;\n${indent}  }\n${indent}  ${lvalue} = _arr;\n${indent}}`;
  }
  if (field.kind.startsWith('map_')) return generateMapDecodeExpr(field, lvalue, indent);
  if (field.kind === 'tuple') {
    const lines = [`${indent}{`];
    (field.tupleItems ?? []).forEach((item, index) => {
      lines.push(generateField(item, `${lvalue}[${index}]`, definitions, `${indent}  `));
    });
    lines.push(`${indent}}`);
    return lines.join('\n');
  }
  if (field.kind === 'vec_struct') {
    if (!field.refType) return `${indent}// unknown vec_struct field: ${field.name}`;
    const structDef = definitions[field.refType];
    if (!structDef) return `${indent}// missing definition for ${field.refType}`;
    const lines = [
      `${indent}{`,
      `${indent}  const _len = _pcDecodeVarint(u8, offset);`,
      `${indent}  offset += _len.bytesRead;`,
      `${indent}  const _arr: ${field.refType}[] = new Array(_len.value);`,
      `${indent}  for (let _i = 0; _i < _len.value; _i++) {`,
      `${indent}    const _obj: ${field.refType} = {} as ${field.refType};`,
    ];
    for (const subField of collectPostcardFields(structDef, definitions).fields) {
      lines.push(generateField(subField, `_obj.${subField.name}`, definitions, `${indent}    `));
    }
    lines.push(
      `${indent}    _arr[_i] = _obj;`,
      `${indent}  }`,
      `${indent}  ${lvalue} = _arr;`,
      `${indent}}`,
    );
    return lines.join('\n');
  }
  if (field.kind.startsWith('option_')) {
    const innerField: PostcardField = { ...field, kind: OPTION_INNER_KIND[field.kind] };
    return `${indent}{\n${indent}  const _tag = u8[offset];\n${indent}  offset += 1;\n${indent}  if (_tag === 0) {\n${indent}    ${lvalue} = null;\n${indent}  } else {\n${generateField(innerField, lvalue, definitions, `${indent}    `)}\n${indent}  }\n${indent}}`;
  }
  if (field.kind === 'enum_str') {
    return `${indent}{\n${indent}  const _v = _pcDecodeVarint(u8, offset);\n${indent}  offset += _v.bytesRead;\n${indent}  const _variants = ${JSON.stringify(field.enumVariants ?? [])};\n${indent}  ${lvalue} = _variants[_v.value];\n${indent}}`;
  }
  return null;
}

function generateMapDecodeExpr(field: PostcardField, lvalue: string, indent: string): string {
  const valueDecoder =
    field.kind === 'map_zigzag'
      ? '_pcDecodeZigzagVarint(u8, offset)'
      : field.kind === 'map_uvar'
        ? '_pcDecodeVarint(u8, offset)'
        : field.kind === 'map_i64' || field.kind === 'map_u64'
          ? '_pcDecodeVarint64(u8, offset)'
          : field.kind === 'map_f64'
            ? '_pcDecodeF64(u8, offset)'
            : null;
  const lines = [
    `${indent}{`,
    `${indent}  const _len = _pcDecodeVarint(u8, offset);`,
    `${indent}  offset += _len.bytesRead;`,
    `${indent}  const _map: Record<string, unknown> = {};`,
    `${indent}  for (let _i = 0; _i < _len.value; _i++) {`,
    `${indent}    const _k = _pcDecodeString(u8, offset);`,
    `${indent}    offset += _k.bytesRead;`,
  ];
  if (valueDecoder) {
    lines.push(`${indent}    const _v = ${valueDecoder};`);
    lines.push(
      `${indent}    _map[_k.value] = ${field.kind === 'map_i64' ? '_pcDecodeZigzag64(_v.value)' : '_v.value'};`,
    );
    lines.push(`${indent}    offset += _v.bytesRead;`);
  } else if (field.kind === 'map_bool') {
    lines.push(`${indent}    _map[_k.value] = u8[offset] === 1;`, `${indent}    offset += 1;`);
  } else {
    lines.push(
      `${indent}    const _v = _pcDecodeString(u8, offset);`,
      `${indent}    _map[_k.value] = _v.value;`,
      `${indent}    offset += _v.bytesRead;`,
    );
  }
  lines.push(`${indent}  }`, `${indent}  ${lvalue} = _map;`, `${indent}}`);
  return lines.join('\n');
}

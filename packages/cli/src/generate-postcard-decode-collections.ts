import type { CollectionDecodeSpec } from './generate-postcard-decode-types.js';

export const COLLECTION_ELEMENT_DECODER: Record<string, CollectionDecodeSpec> = {
  vec_zigzag: {
    valueType: 'number',
    decoder: '_pcDecodeZigzagVarint(u8, offset)',
    valueExpression: '_v.value',
  },
  vec_i64: {
    valueType: 'number | bigint',
    decoder: '_pcDecodeVarint64(u8, offset)',
    valueExpression: '_pcDecodeZigzag64(_v.value)',
  },
  vec_u64: {
    valueType: 'number | bigint',
    decoder: '_pcDecodeVarint64(u8, offset)',
    valueExpression: '_v.value',
  },
  vec_uvar: {
    valueType: 'number',
    decoder: '_pcDecodeVarint(u8, offset)',
    valueExpression: '_v.value',
  },
  vec_f64: {
    valueType: 'number',
    decoder: '_pcDecodeF64(u8, offset)',
    valueExpression: '_v.value',
  },
  vec_bool: { valueType: 'boolean', decoder: null, valueExpression: 'u8[offset] === 1' },
  set_zigzag: {
    valueType: 'number',
    decoder: '_pcDecodeZigzagVarint(u8, offset)',
    valueExpression: '_v.value',
  },
  set_i64: {
    valueType: 'number | bigint',
    decoder: '_pcDecodeVarint64(u8, offset)',
    valueExpression: '_pcDecodeZigzag64(_v.value)',
  },
  set_u64: {
    valueType: 'number | bigint',
    decoder: '_pcDecodeVarint64(u8, offset)',
    valueExpression: '_v.value',
  },
  set_uvar: {
    valueType: 'number',
    decoder: '_pcDecodeVarint(u8, offset)',
    valueExpression: '_v.value',
  },
  set_f64: {
    valueType: 'number',
    decoder: '_pcDecodeF64(u8, offset)',
    valueExpression: '_v.value',
  },
  set_bool: { valueType: 'boolean', decoder: null, valueExpression: 'u8[offset] === 1' },
};

export function generateCollectionDecodeExpr(kind: string, lvalue: string, indent: string): string {
  const spec = COLLECTION_ELEMENT_DECODER[kind];
  if (!spec) return `${indent}// unsupported collection kind: ${kind}`;
  const isSet = kind.startsWith('set_');
  const collection = isSet
    ? `const _set = new Set<${spec.valueType}>();`
    : `const _arr: ${spec.valueType}[] = new Array(_len.value);`;
  const element = isSet
    ? `_set.add(${spec.valueExpression});`
    : `_arr[_i] = ${spec.valueExpression};`;
  const lines = [
    `${indent}{`,
    `${indent}  const _len = _pcDecodeVarint(u8, offset);`,
    `${indent}  offset += _len.bytesRead;`,
    `${indent}  ${collection}`,
    `${indent}  for (let _i = 0; _i < _len.value; _i++) {`,
  ];
  if (spec.decoder) lines.push(`${indent}    const _v = ${spec.decoder};`);
  lines.push(`${indent}    ${element}`);
  lines.push(`${indent}    offset += ${spec.decoder ? '_v.bytesRead' : '1'};`);
  lines.push(`${indent}  }`, `${indent}  ${lvalue} = ${isSet ? '_set' : '_arr'};`, `${indent}}`);
  return lines.join('\n');
}

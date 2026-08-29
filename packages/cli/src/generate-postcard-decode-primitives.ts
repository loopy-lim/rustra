export function generatePrimitiveDecodeExpr(
  kind: string,
  lvalue: string,
  indent: string,
): string | null {
  const decoded = (decoder: string, value: string, bytes = '_v.bytesRead') =>
    `${indent}{\n${indent}  const _v = ${decoder};\n${indent}  ${lvalue} = ${value};\n${indent}  offset += ${bytes};\n${indent}}`;
  switch (kind) {
    case 'zigzag':
      return decoded('_pcDecodeZigzagVarint(u8, offset)', '_v.value');
    case 'uvar':
      return decoded('_pcDecodeVarint(u8, offset)', '_v.value');
    case 'uvar64':
      return decoded('_pcDecodeVarint64(u8, offset)', '_v.value');
    case 'zigzag64':
      return decoded('_pcDecodeVarint64(u8, offset)', '_pcDecodeZigzag64(_v.value)');
    case 'f64':
      return decoded('_pcDecodeF64(u8, offset)', '_v.value');
    case 'f32':
      return decoded('_pcDecodeF32(u8, offset)', '_v.value');
    case 'string':
      return decoded('_pcDecodeString(u8, offset)', '_v.value');
    case 'bool':
      return `${indent}{\n${indent}  ${lvalue} = u8[offset] === 1;\n${indent}  offset += 1;\n${indent}}`;
    case 'bytes':
      return `${indent}{\n${indent}  const _len = _pcDecodeVarint(u8, offset);\n${indent}  offset += _len.bytesRead;\n${indent}  ${lvalue} = u8.slice(offset, offset + _len.value);\n${indent}  offset += _len.value;\n${indent}}`;
    default:
      return null;
  }
}

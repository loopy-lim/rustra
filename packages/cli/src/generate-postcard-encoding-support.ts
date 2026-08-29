export const ENC_INTO_KINDS = new Set([
  'zigzag',
  'uvar',
  'zigzag64',
  'uvar64',
  'f64',
  'f32',
  'bool',
  'string',
  'bytes',
  'vec_zigzag',
  'vec_uvar',
]);

export const COLLECTION_ELEMENT_ENCODER: Record<string, string> = {
  vec_zigzag: '_pcEncodeZigzagVarint(_arr[_i])',
  vec_i64: '_pcEncodeZigzag64(_arr[_i])',
  vec_u64: '_pcEncodeVarint64(_arr[_i])',
  vec_uvar: '_pcEncodeVarint(_arr[_i])',
  vec_f64: '_pcEncodeF64(_arr[_i])',
  vec_bool: 'new Uint8Array([_arr[_i] ? 1 : 0])',
  set_zigzag: '_pcEncodeZigzagVarint(_arr[_i])',
  set_i64: '_pcEncodeZigzag64(_arr[_i])',
  set_u64: '_pcEncodeVarint64(_arr[_i])',
  set_uvar: '_pcEncodeVarint(_arr[_i])',
  set_f64: '_pcEncodeF64(_arr[_i])',
  set_bool: 'new Uint8Array([_arr[_i] ? 1 : 0])',
};

import type { JsonSchema } from './schema.js';

export type PostcardFieldKind =
  | 'zigzag'
  | 'uvar'
  | 'zigzag64'
  | 'uvar64'
  | 'f64'
  | 'f32'
  | 'bool'
  | 'string'
  | 'bytes'
  | 'vec_zigzag'
  | 'vec_f64'
  | 'vec_bool'
  | 'vec_i64'
  | 'vec_u64'
  | 'set_zigzag'
  | 'set_f64'
  | 'set_bool'
  | 'set_i64'
  | 'set_u64'
  | 'set_uvar'
  | 'struct'
  | 'vec_string'
  | 'vec_struct'
  | 'vec_uvar'
  | 'map_zigzag'
  | 'map_uvar'
  | 'map_i64'
  | 'map_u64'
  | 'map_f64'
  | 'map_bool'
  | 'map_string'
  | 'tuple'
  | 'data_enum'
  | 'option_zigzag'
  | 'option_uvar'
  | 'option_zigzag64'
  | 'option_uvar64'
  | 'option_f64'
  | 'option_f32'
  | 'option_bool'
  | 'option_string'
  | 'option_struct'
  | 'option_bytes'
  | 'enum_str';

export const OPTION_INNER_KIND: Record<string, PostcardFieldKind> = {
  option_zigzag: 'zigzag',
  option_uvar: 'uvar',
  option_zigzag64: 'zigzag64',
  option_uvar64: 'uvar64',
  option_f64: 'f64',
  option_f32: 'f32',
  option_bool: 'bool',
  option_string: 'string',
  option_struct: 'struct',
  option_bytes: 'bytes',
};

export type PostcardField = {
  name: string;
  kind: PostcardFieldKind;
  refType?: string;
  enumVariants?: string[];
  tupleItems?: PostcardField[];
  enumVariantsData?: { tag: string; fields: PostcardField[] }[];
};

export type Schema = JsonSchema;

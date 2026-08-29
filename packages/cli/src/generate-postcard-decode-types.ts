import type { PostcardField } from './generate-postcard-types.js';

export type CollectionDecodeSpec = {
  valueType: string;
  decoder: string | null;
  valueExpression: string;
};

export type FieldDecodeGenerator = (
  field: PostcardField,
  lvalue: string,
  definitions: Record<string, import('./schema.js').JsonSchema>,
  indent: string,
) => string;

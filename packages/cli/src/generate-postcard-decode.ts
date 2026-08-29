import type { PostcardField } from './generate-postcard-types.js';
import {
  generateCollectionDecodeExpr,
  COLLECTION_ELEMENT_DECODER,
} from './generate-postcard-decode-collections.js';
import { generatePrimitiveDecodeExpr } from './generate-postcard-decode-primitives.js';
import { generateComplexDecodeExpr } from './generate-postcard-decode-complex.js';

export {
  COLLECTION_ELEMENT_DECODER,
  generateCollectionDecodeExpr,
} from './generate-postcard-decode-collections.js';
export type { CollectionDecodeSpec } from './generate-postcard-decode-types.js';

export function generateFieldDecodeExpr(
  field: PostcardField,
  lvalue: string,
  definitions: Record<string, import('./schema.js').JsonSchema>,
  indent: string,
): string {
  const primitive = generatePrimitiveDecodeExpr(field.kind, lvalue, indent);
  if (primitive !== null) return primitive;
  if (COLLECTION_ELEMENT_DECODER[field.kind]) {
    return generateCollectionDecodeExpr(field.kind, lvalue, indent);
  }
  return (
    generateComplexDecodeExpr(field, lvalue, definitions, indent, generateFieldDecodeExpr) ??
    `${indent}// unsupported field kind: ${field.kind}`
  );
}

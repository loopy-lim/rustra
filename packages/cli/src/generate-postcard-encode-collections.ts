import { COLLECTION_ELEMENT_ENCODER } from './generate-postcard-encoding-support.js';

export function generateCollectionEncodeExpr(
  kind: string,
  valueExpr: string,
  indent: string,
): string {
  const element = COLLECTION_ELEMENT_ENCODER[kind];
  if (!element) return `${indent}// unsupported collection kind: ${kind}`;
  const source = kind.startsWith('set_') ? `[...${valueExpr}]` : valueExpr;
  return `${indent}{\n${indent}  const _arr = ${source};\n${indent}  parts.push(_pcEncodeVarint(_arr.length));\n${indent}  for (let _i = 0; _i < _arr.length; _i++) {\n${indent}    parts.push(${element});\n${indent}  }\n${indent}}`;
}

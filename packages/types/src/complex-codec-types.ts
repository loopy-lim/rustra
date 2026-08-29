import type { RkyvV2Codec, RustraError } from './index.js';

export type ComplexSchema = {
  type?: string | string[];
  properties?: Record<string, ComplexSchema>;
  required?: string[];
  items?: ComplexSchema | ComplexSchema[];
  additionalProperties?: ComplexSchema | boolean;
  uniqueItems?: boolean;
  $ref?: string;
  anyOf?: ComplexSchema[];
  oneOf?: ComplexSchema[];
  allOf?: ComplexSchema[];
  enum?: (string | number | boolean | null)[];
  const?: string | number | boolean | null;
  /** Explicit stable keys for oneOf variants, in schema declaration order. */
  'x-rustra-variant-order'?: string[];
  format?: string;
  [key: string]: unknown;
};

export type ComplexCodecOptions = {
  commandId: number;
  inputSchema: ComplexSchema;
  outputSchema: ComplexSchema;
  definitions?: Record<string, ComplexSchema>;
  maxDepth?: number;
  maxPayloadBytes?: number;
  maxCollectionLength?: number;
};

export const DEFAULT_MAX_DEPTH = 32;
export const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
export const DEFAULT_MAX_COLLECTION_LENGTH = 100_000;

export class ComplexCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComplexCodecError';
  }
}

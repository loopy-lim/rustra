import type { CommandSchema } from './schema.js';
import { collectPostcardFields, type PostcardField } from './generate-postcard-ir.js';

/**
 * (Tier 1) positional fast path가 다루는 스칼라 kind 집합.
 * facade(generatePositionalFacadeTs)와 C++ 코드젠(cppEncodePosCommand)이
 * 반드시 같은 집합을 써야 한다 — 어느 한쪽에만 포함된 kind는 facade가
 * callPos 로 노출한 명령을 C++ 이 인코딩하지 못해 런타임 JSError 가 난다.
 */
export const POSITIONAL_SCALAR_KINDS = [
  'zigzag',
  'uvar',
  'zigzag64',
  'uvar64',
  'f64',
  'f32',
  'bool',
  'string',
  'enum_str',
  'bytes',
] as const;

export const RAW_SCALAR_KINDS = [
  'zigzag',
  'uvar',
  'zigzag64',
  'uvar64',
  'f64',
  'f32',
  'bool',
] as const;

/** Existing object-input commands that can safely forward one to three fields. */
export function generatedFieldRoute(
  command: CommandSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): PostcardField[] | null {
  if (command.inputType === '()') return null;
  const { fields } = collectPostcardFields(command.inputSchema, definitions);
  const positionalKinds = new Set<string>(POSITIONAL_SCALAR_KINDS);
  if (fields.length === 0 || fields.length > 3) return null;
  if (!fields.every((field) => positionalKinds.has(field.kind))) return null;
  return fields;
}

/** Dedicated native path is intentionally narrow: exactly one `Vec<u8>` field. */
export function bufferCommandField(
  command: CommandSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): PostcardField | null {
  const fields = generatedFieldRoute(command, definitions);
  if (fields?.length !== 1 || fields[0].kind !== 'bytes') return null;
  const properties = command.inputSchema.properties;
  const required = command.inputSchema.required;
  if (
    !properties ||
    Object.keys(properties).length !== 1 ||
    !Array.isArray(required) ||
    required.length !== 1 ||
    required[0] !== fields[0].name
  ) {
    return null;
  }
  return fields[0];
}

/** Direct raw-byte ABI requires one byte field on both sides of the command. */

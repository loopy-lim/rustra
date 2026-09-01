import type { PackageSchema } from './schema.js';

const TS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function assertIdentifier(value: string, where: string): void {
  if (!TS_IDENTIFIER.test(value)) {
    // 제네릭 파손 이름(`Wrapper<String >` — 구버전 rustra의 type_name 잔재)은
    // 원인과 해결책을 명시한다. 신규 rustra는 schemars schema_name(모노몰포이즈
    // `Wrapper_for_String`)을 쓰므로 이 경우 Rust 쪽 재빌드가 정답.
    const genericMatch = value.match(/^(\w+)<.*>$/s);
    if (genericMatch) {
      throw new Error(
        `Invalid schema: ${where} is a generic type name, got: ${JSON.stringify(value)}. ` +
          `Generic payloads must use a concrete alias (type Foo = Bar<Baz>) or a ` +
          `monomorphized schemars name like ${genericMatch[1]}_for_X. ` +
          `Rebuild the Rust package with the current rustra and regenerate schema.json.`,
      );
    }
    throw new Error(
      `Invalid schema: ${where} must be a plain identifier, got: ${JSON.stringify(value)}`,
    );
  }
}

function assertSchemaIdentifiers(
  schema: unknown,
  where: string,
  visited: Set<unknown> = new Set(),
): void {
  if (typeof schema !== 'object' || schema === null || visited.has(schema)) return;
  visited.add(schema);
  const node = schema as {
    definitions?: Record<string, unknown>;
    properties?: Record<string, unknown>;
    $ref?: unknown;
    [key: string]: unknown;
  };
  if (typeof node.$ref === 'string') {
    const target = node.$ref.replace(/^#\/(definitions\/|\$defs\/)/, '');
    assertIdentifier(target, `${where} $ref target`);
  }
  if (node.definitions) {
    for (const key of Object.keys(node.definitions)) {
      assertIdentifier(key, `${where} definitions key`);
      assertSchemaIdentifiers(node.definitions[key], `${where}.${key}`, visited);
    }
  }
  if (node.properties) {
    for (const key of Object.keys(node.properties)) {
      assertIdentifier(key, `${where} property name`);
      assertSchemaIdentifiers(node.properties[key], `${where}.${key}`, visited);
    }
  }
  for (const arrayKey of ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const) {
    const arr = node[arrayKey];
    if (Array.isArray(arr)) {
      for (let i = 0; i < arr.length; i++) {
        assertSchemaIdentifiers(arr[i], `${where}.${arrayKey}[${i}]`, visited);
      }
    }
  }
  const items = node.items;
  if (Array.isArray(items)) {
    items.forEach((s, i) => assertSchemaIdentifiers(s, `${where}.items[${i}]`, visited));
  } else if (items) {
    assertSchemaIdentifiers(items, `${where}.items`, visited);
  }
  if (
    node.additionalProperties &&
    typeof node.additionalProperties === 'object' &&
    !Array.isArray(node.additionalProperties)
  ) {
    assertSchemaIdentifiers(node.additionalProperties, `${where}.additionalProperties`, visited);
  }
}

export function parsePackageSchema(value: unknown): PackageSchema {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid schema: expected an object');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.packageId !== 'string') {
    throw new Error('Invalid schema: missing or invalid "packageId"');
  }
  if (!Array.isArray(obj.commands)) {
    throw new Error('Invalid schema: missing or invalid "commands" array');
  }
  if (obj.fieldOrder !== undefined && obj.fieldOrder !== 'declaration') {
    throw new Error('Invalid schema: "fieldOrder" must be "declaration" when provided');
  }
  for (let i = 0; i < obj.commands.length; i++) {
    const cmd = obj.commands[i] as Record<string, unknown>;
    if (typeof cmd.name !== 'string') {
      throw new Error(`Invalid schema: commands[${i}].name must be a string`);
    }
    if (typeof cmd.inputType !== 'string' || typeof cmd.outputType !== 'string') {
      throw new Error(`Invalid schema: commands[${i}] must have inputType and outputType`);
    }
    if (typeof cmd.inputSchema !== 'object' || typeof cmd.outputSchema !== 'object') {
      throw new Error(`Invalid schema: commands[${i}] must have inputSchema and outputSchema`);
    }
    assertIdentifier(cmd.name, `commands[${i}].name`);
    if (cmd.inputType !== '()') assertIdentifier(cmd.inputType, `commands[${i}].inputType`);
    if (cmd.outputType !== '()') assertIdentifier(cmd.outputType, `commands[${i}].outputType`);
    if (cmd.definitions) {
      for (const key of Object.keys(cmd.definitions)) {
        assertIdentifier(key, `commands[${i}].definitions key`);
      }
    }
    assertSchemaIdentifiers(cmd.inputSchema, `commands[${i}].inputSchema`);
    assertSchemaIdentifiers(cmd.outputSchema, `commands[${i}].outputSchema`);
    if (cmd.definitions) {
      for (const [key, def] of Object.entries(cmd.definitions)) {
        assertSchemaIdentifiers(def, `commands[${i}].definitions.${key}`);
      }
    }
  }
  return value as PackageSchema;
}

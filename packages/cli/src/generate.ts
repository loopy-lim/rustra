import { createHash } from "node:crypto";
import type { CommandSchema, JsonSchema, PackageSchema } from "./schema.js";

export function generateTypesTs(schema: PackageSchema): string {
  let output =
    "export type EngineClient = {\n  invoke<T>(command: string, args?: unknown): Promise<T>;\n};\n\n" +
    "export type RustraError = {\n  readonly code: string;\n  readonly message: string;\n};\n\n";

  const allDefinitions: Record<string, JsonSchema> = {};
  for (const command of schema.commands) {
    collectDefinitions(command.inputSchema, allDefinitions);
    collectDefinitions(command.outputSchema, allDefinitions);
  }

  const emitted = new Set<string>();

  for (const [name, defSchema] of Object.entries(allDefinitions)) {
    if (emitted.has(name)) continue;
    emitted.add(name);
    output += `export type ${name} = ${tsTypeFromSchema(defSchema, allDefinitions)};\n\n`;
  }

  for (const command of schema.commands) {
    if (!emitted.has(command.inputType)) {
      emitted.add(command.inputType);
      output += `export type ${command.inputType} = ${tsTypeFromSchema(command.inputSchema, allDefinitions)};\n\n`;
    }
    if (!emitted.has(command.outputType)) {
      emitted.add(command.outputType);
      output += `export type ${command.outputType} = ${tsTypeFromSchema(command.outputSchema, allDefinitions)};\n\n`;
    }
  }

  return output;
}

export function generateCommandsTs(schema: PackageSchema): string {
  const typeNames = new Set(["EngineClient", "RustraError"]);
  for (const command of schema.commands) {
    typeNames.add(command.inputType);
    typeNames.add(command.outputType);
  }

  const imports = Array.from(typeNames).sort().join(", ");
  let output = `import type { ${imports} } from './types.js';\n\n`;

  for (const command of schema.commands) {
    const fnName = commandFunctionName(command.name);
    output +=
      `export function ${fnName}(engine: EngineClient, input: ${command.inputType}): Promise<${command.outputType}> {\n` +
      `  return engine.invoke<${command.outputType}>('${command.name}', input);\n` +
      `}\n\n`;
  }

  return output;
}

export function generateContractTs(schemaJson: string): string {
  const hash = contractHash(schemaJson);
  return `export const GENERATED_CONTRACT_HASH = '${hash}';\n`;
}

function contractHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function collectDefinitions(
  schema: JsonSchema,
  out: Record<string, JsonSchema>,
): void {
  if (schema.definitions) {
    for (const [key, value] of Object.entries(schema.definitions)) {
      out[key] = value;
    }
  }
}

function tsTypeFromSchema(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema>,
): string {
  if (schema.$ref) {
    return resolveRef(schema.$ref, definitions);
  }

  if (schema.anyOf) {
    return schema.anyOf
      .map((s) => tsTypeFromSchema(s, definitions))
      .join(" | ");
  }

  const type = schema.type;

  if (typeof type === "string") {
    switch (type) {
      case "object":
        return tsObjectFromSchema(schema, definitions);
      case "integer":
      case "number":
        return "number";
      case "string": {
        if (schema.enum && schema.enum.length > 0) {
          return schema.enum.map((v) => `'${v}'`).join(" | ");
        }
        return "string";
      }
      case "boolean":
        return "boolean";
      case "array": {
        const itemType = schema.items
          ? tsTypeFromSchema(schema.items, definitions)
          : "unknown";
        return `${itemType}[]`;
      }
      case "null":
        return "null";
      default:
        return "unknown";
    }
  }

  if (Array.isArray(type)) {
    const parts = type
      .map((t) => {
        switch (t) {
          case "integer":
          case "number":
            return "number";
          case "string":
            return "string";
          case "boolean":
            return "boolean";
          case "null":
            return "null";
          case "object":
            return tsObjectFromSchema(schema, definitions);
          case "array":
            return schema.items
              ? `${tsTypeFromSchema(schema.items, definitions)}[]`
              : "unknown[]";
          default:
            return "unknown";
        }
      })
      .filter((v, i, a) => a.indexOf(v) === i);
    return parts.join(" | ");
  }

  return "unknown";
}

function resolveRef(
  ref: string,
  _definitions: Record<string, JsonSchema>,
): string {
  const name =
    ref.startsWith("#/definitions/")
      ? ref.slice("#/definitions/".length)
      : ref.startsWith("#/$defs/")
        ? ref.slice("#/$defs/".length)
        : ref;
  return name;
}

function tsObjectFromSchema(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema>,
): string {
  const required = new Set(schema.required ?? []);
  const properties = schema.properties;

  if (!properties) {
    return "Record<string, unknown>";
  }

  const fields = Object.entries(properties)
    .map(([name, propSchema]) => {
      const optional = required.has(name) ? "" : "?";
      return `  ${name}${optional}: ${tsTypeFromSchema(propSchema, definitions)};`;
    })
    .join("\n");

  return `{\n${fields}\n}`;
}

function commandFunctionName(name: string): string {
  let output = "";
  let uppercaseNext = false;

  for (const char of name) {
    if (isAsciiAlphanumeric(char)) {
      if (output.length === 0) {
        output += char.toLowerCase();
      } else if (uppercaseNext) {
        output += char.toUpperCase();
        uppercaseNext = false;
      } else {
        output += char;
      }
    } else {
      uppercaseNext = true;
    }
  }

  return output.length > 0 ? output : "command";
}

function isAsciiAlphanumeric(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

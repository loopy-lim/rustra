import type { PackageSchema, JsonSchema } from './schema.js';

export type EngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

export type ValidateOptions = {
  schema: PackageSchema;
  engine: EngineClient;
  onViolation?: (type: 'input' | 'output', command: string, errors: string[]) => void;
};

export function createValidatedEngine(options: ValidateOptions): EngineClient {
  const commands = new Map(options.schema.commands.map((c) => [c.name, c]));

  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      const cmd = commands.get(command);
      if (!cmd) {
        console.warn(`[rustra:validate] Unknown command: ${command}`);
        return options.engine.invoke<T>(command, args);
      }

      if (args !== undefined) {
        const errors = validateAgainstSchema(args, cmd.inputSchema, 'root');
        if (errors.length > 0) {
          options.onViolation?.('input', command, errors);
        }
      }

      const result = await options.engine.invoke<T>(command, args);

      if (result !== undefined) {
        const errors = validateAgainstSchema(result, cmd.outputSchema, 'root');
        if (errors.length > 0) {
          options.onViolation?.('output', command, errors);
        }
      }

      return result;
    },
  };
}

function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  path: string,
): string[] {
  const errors: string[] = [];

  if (schema.$ref || schema.anyOf) return errors;

  const type = schema.type;
  if (!type) return errors;

  if (typeof type === 'string') {
    if (type === 'object' && typeof value === 'object' && value !== null) {
      const obj = value as Record<string, unknown>;
      const props = schema.properties || {};
      const required = new Set(schema.required || []);

      for (const field of required) {
        if (!(field in obj)) {
          errors.push(`${path}.${field}: required field missing`);
        }
      }

      for (const [key, propSchema] of Object.entries(props)) {
        if (key in obj) {
          errors.push(...validateAgainstSchema(obj[key], propSchema, `${path}.${key}`));
        }
      }
    }

    if (type === 'array' && Array.isArray(value) && schema.items) {
      value.forEach((item, i) => {
        errors.push(...validateAgainstSchema(item, schema.items as JsonSchema, `${path}[${i}]`));
      });
    }
  }

  return errors;
}

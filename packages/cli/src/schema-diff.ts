import type { PackageSchema } from './schema.js';
import {
  asRecord,
  isString,
  lastSegment,
  objectId,
  resolveDefinition,
  schemaShape,
} from './schema-diff-helpers.js';
export { formatDiffResult } from './schema-diff-format.js';
export type BreakingChange =
  | { type: 'field_removed'; command: string; field: string }
  | { type: 'field_type_changed'; command: string; field: string; from: string; to: string }
  | { type: 'required_field_added'; command: string; field: string }
  | { type: 'field_became_required'; command: string; field: string }
  | { type: 'field_became_optional'; command: string; field: string }
  | { type: 'definition_removed'; command: string; field: string }
  | { type: 'command_removed'; command: string };

export interface DiffResult {
  breaking: BreakingChange[];
  compatible: string[];
}
export function diffSchemas(oldSchema: PackageSchema, newSchema: PackageSchema): DiffResult {
  const breaking: BreakingChange[] = [];
  const compatible: string[] = [];

  const oldCommands = new Map(oldSchema.commands.map((c) => [c.name, c]));
  const newCommands = new Map(newSchema.commands.map((c) => [c.name, c]));

  for (const [name, oldCmd] of oldCommands) {
    if (!newCommands.has(name)) {
      breaking.push({ type: 'command_removed', command: name });
      continue;
    }

    const newCmd = newCommands.get(name)!;
    compareSchemas(
      oldCmd.inputSchema,
      newCmd.inputSchema,
      `${name}.input`,
      breaking,
      compatible,
      oldCmd.definitions,
      newCmd.definitions,
    );
    compareSchemas(
      oldCmd.outputSchema,
      newCmd.outputSchema,
      `${name}.output`,
      breaking,
      compatible,
      oldCmd.definitions,
      newCmd.definitions,
    );
  }

  return { breaking, compatible };
}
function compareSchemas(
  oldSchema: unknown,
  newSchema: unknown,
  path: string,
  breaking: BreakingChange[],
  compatible: string[],
  oldDefinitions: Record<string, unknown> | undefined = undefined,
  newDefinitions: Record<string, unknown> | undefined = undefined,
): void {
  const visited = new Set<string>();
  compareSchemaNodes(oldSchema, newSchema, path, breaking, compatible, visited, {
    old: { ...asRecord((oldSchema as Record<string, unknown>)?.definitions), ...oldDefinitions },
    new: { ...asRecord((newSchema as Record<string, unknown>)?.definitions), ...newDefinitions },
  });
}
type DefinitionContext = {
  old: Record<string, unknown>;
  new: Record<string, unknown>;
};
function compareSchemaNodes(
  oldSchema: unknown,
  newSchema: unknown,
  path: string,
  breaking: BreakingChange[],
  compatible: string[],
  visited: Set<string>,
  definitions: DefinitionContext,
): void {
  if (typeof oldSchema !== 'object' || typeof newSchema !== 'object') return;
  if (!oldSchema || !newSchema) return;
  const oldObj = oldSchema as Record<string, unknown>;
  const newObj = newSchema as Record<string, unknown>;
  const oldRef = typeof oldObj.$ref === 'string' ? oldObj.$ref : undefined;
  const newRef = typeof newObj.$ref === 'string' ? newObj.$ref : undefined;
  if (oldRef || newRef) {
    if (oldRef !== newRef) {
      breaking.push({
        type: 'field_type_changed',
        command: path,
        field: lastSegment(path),
        from: oldRef ?? schemaShape(oldObj),
        to: newRef ?? schemaShape(newObj),
      });
      return;
    }
    const oldResolved = oldRef ? resolveDefinition(oldRef, definitions.old) : oldSchema;
    const newResolved = newRef ? resolveDefinition(newRef, definitions.new) : newSchema;
    if (oldResolved && newResolved && (oldResolved !== oldSchema || newResolved !== newSchema)) {
      compareSchemaNodes(
        oldResolved,
        newResolved,
        path,
        breaking,
        compatible,
        visited,
        definitions,
      );
      return;
    }
  }
  const pairKey = `${objectId(oldSchema)}:${objectId(newSchema)}:${path}`;
  if (visited.has(pairKey)) return;
  visited.add(pairKey);

  const oldShape = schemaShape(oldObj);
  const newShape = schemaShape(newObj);
  if (oldShape !== newShape) {
    breaking.push({
      type: 'field_type_changed',
      command: path,
      field: lastSegment(path),
      from: oldShape,
      to: newShape,
    });
    return;
  }

  const oldProps = asRecord(oldObj.properties);
  const newProps = asRecord(newObj.properties);
  const oldRequired = new Set(
    Array.isArray(oldObj.required) ? oldObj.required.filter(isString) : [],
  );
  const newRequired = new Set(
    Array.isArray(newObj.required) ? newObj.required.filter(isString) : [],
  );

  for (const field of Object.keys(oldProps)) {
    if (!(field in newProps)) {
      breaking.push({ type: 'field_removed', command: path, field });
      continue;
    }
    if (!oldRequired.has(field) && newRequired.has(field)) {
      breaking.push({ type: 'field_became_required', command: path, field });
    } else if (oldRequired.has(field) && !newRequired.has(field)) {
      breaking.push({ type: 'field_became_optional', command: path, field });
    }
    compareSchemaNodes(
      oldProps[field],
      newProps[field],
      `${path}.${field}`,
      breaking,
      compatible,
      visited,
      definitions,
    );
  }

  for (const field of Object.keys(newProps)) {
    if (field in oldProps) continue;
    if (newRequired.has(field)) {
      breaking.push({ type: 'required_field_added', command: path, field });
    } else {
      compatible.push(`${path}: optional field '${field}' added`);
    }
  }

  compareSchemaArray(
    oldObj.items,
    newObj.items,
    `${path}[]`,
    breaking,
    compatible,
    visited,
    definitions,
  );
  const oldNestedDefinitions = asRecord(oldObj.definitions ?? oldObj.$defs);
  const newNestedDefinitions = asRecord(newObj.definitions ?? newObj.$defs);
  for (const name of Object.keys(oldNestedDefinitions)) {
    if (!(name in newNestedDefinitions)) {
      breaking.push({ type: 'definition_removed', command: path, field: name });
    } else {
      compareSchemaNodes(
        oldNestedDefinitions[name],
        newNestedDefinitions[name],
        `${path}.definitions.${name}`,
        breaking,
        compatible,
        visited,
        definitions,
      );
    }
  }
}
function compareSchemaArray(
  oldSchema: unknown,
  newSchema: unknown,
  path: string,
  breaking: BreakingChange[],
  compatible: string[],
  visited: Set<string>,
  definitions: DefinitionContext,
): void {
  if (oldSchema === undefined || newSchema === undefined) return;
  compareSchemaNodes(oldSchema, newSchema, path, breaking, compatible, visited, definitions);
}

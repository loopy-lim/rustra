import type { PackageSchema } from './schema.js';

export type BreakingChange =
  | { type: 'field_removed'; command: string; field: string }
  | { type: 'field_type_changed'; command: string; field: string; from: string; to: string }
  | { type: 'required_field_added'; command: string; field: string }
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
    compareSchemas(oldCmd.inputSchema, newCmd.inputSchema, `${name}.input`, breaking, compatible);
    compareSchemas(
      oldCmd.outputSchema,
      newCmd.outputSchema,
      `${name}.output`,
      breaking,
      compatible,
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
): void {
  if (typeof oldSchema !== 'object' || typeof newSchema !== 'object') return;
  if (!oldSchema || !newSchema) return;

  const oldObj = oldSchema as Record<string, unknown>;
  const newObj = newSchema as Record<string, unknown>;

  const oldProps = (oldObj.properties || {}) as Record<string, unknown>;
  const newProps = (newObj.properties || {}) as Record<string, unknown>;

  for (const field of Object.keys(oldProps)) {
    if (!(field in newProps)) {
      breaking.push({ type: 'field_removed', command: path, field });
    }
  }

  for (const field of Object.keys(newProps)) {
    const newField = newProps[field] as Record<string, unknown>;
    const oldField = oldProps[field] as Record<string, unknown> | undefined;

    if (!oldField) {
      const newRequired = (newObj.required as string[]) || [];
      if (newRequired.includes(field)) {
        breaking.push({ type: 'required_field_added', command: path, field });
      } else {
        compatible.push(`${path}: optional field '${field}' added`);
      }
      continue;
    }

    if (oldField.type && newField.type && oldField.type !== newField.type) {
      breaking.push({
        type: 'field_type_changed',
        command: path,
        field,
        from: String(oldField.type),
        to: String(newField.type),
      });
    }
  }
}

export function formatDiffResult(result: DiffResult): string {
  const lines: string[] = [];

  if (result.breaking.length === 0) {
    lines.push('No breaking changes detected.');
  } else {
    lines.push(`Breaking changes (${result.breaking.length}):`);
    for (const change of result.breaking) {
      switch (change.type) {
        case 'command_removed':
          lines.push(`  - Command removed: ${change.command}`);
          break;
        case 'field_removed':
          lines.push(`  - Field removed: ${change.command}.${change.field}`);
          break;
        case 'field_type_changed':
          lines.push(
            `  - Type changed: ${change.command}.${change.field} (${change.from} → ${change.to})`,
          );
          break;
        case 'required_field_added':
          lines.push(`  - Required field added: ${change.command}.${change.field}`);
          break;
      }
    }
  }

  if (result.compatible.length > 0) {
    lines.push(`Compatible changes (${result.compatible.length}):`);
    for (const note of result.compatible) {
      lines.push(`  + ${note}`);
    }
  }

  return lines.join('\n');
}

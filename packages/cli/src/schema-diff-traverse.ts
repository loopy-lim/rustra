import type { BreakingChange } from './schema-diff.js';
import {
  asRecord,
  isString,
  lastSegment,
  objectId,
  resolveDefinition,
  schemaShape,
  variantKeys,
} from './schema-diff-helpers.js';

export function compareSchemas(
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
    old: {
      ...asRecord(asRecord(oldSchema).$defs),
      ...asRecord(asRecord(oldSchema).definitions),
      ...oldDefinitions,
    },
    new: {
      ...asRecord(asRecord(newSchema).$defs),
      ...asRecord(asRecord(newSchema).definitions),
      ...newDefinitions,
    },
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
  if (oldSchema === newSchema && (typeof oldSchema !== 'object' || oldSchema === null)) return;
  if (typeof oldSchema !== 'object' || typeof newSchema !== 'object' || !oldSchema || !newSchema) {
    breaking.push({
      type: 'field_type_changed',
      command: path,
      field: lastSegment(path),
      from: JSON.stringify(oldSchema) ?? '(absent)',
      to: JSON.stringify(newSchema) ?? '(absent)',
    });
    return;
  }
  // Track the active pair, not the ever-growing diagnostic path. Removing it on
  // unwind still reports a shared definition under each independent field.
  const pairKey = `${objectId(oldSchema)}:${objectId(newSchema)}`;
  if (visited.has(pairKey)) return;
  visited.add(pairKey);
  try {
    compareSchemaValues(oldSchema, newSchema, path, breaking, compatible, visited, definitions);
  } finally {
    visited.delete(pairKey);
  }
}
function compareSchemaValues(
  oldSchema: object,
  newSchema: object,
  path: string,
  breaking: BreakingChange[],
  compatible: string[],
  visited: Set<string>,
  definitions: DefinitionContext,
): void {
  if (Array.isArray(oldSchema) || Array.isArray(newSchema)) {
    if (
      !Array.isArray(oldSchema) ||
      !Array.isArray(newSchema) ||
      oldSchema.length !== newSchema.length
    ) {
      breaking.push({
        type: 'field_type_changed',
        command: path,
        field: lastSegment(path),
        from: Array.isArray(oldSchema) ? `tuple[${oldSchema.length}]` : 'schema',
        to: Array.isArray(newSchema) ? `tuple[${newSchema.length}]` : 'schema',
      });
      return;
    }
    oldSchema.forEach((node, index) =>
      compareSchemaNodes(
        node,
        newSchema[index],
        `${path}[${index}]`,
        breaking,
        compatible,
        visited,
        definitions,
      ),
    );
    return;
  }
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
    if (oldResolved !== undefined && newResolved === undefined) {
      breaking.push({
        type: 'definition_removed',
        command: path,
        field: oldRef!.split('/').at(-1)!,
      });
      return;
    }
    if (
      oldResolved !== undefined &&
      newResolved !== undefined &&
      (oldResolved !== oldSchema || newResolved !== newSchema)
    ) {
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

  // These facets change positional encoding, discriminator values, or the set
  // of values a peer accepts even when the top-level JSON type stays the same.
  for (const facet of [
    'format',
    'enum',
    'const',
    'uniqueItems',
    'minItems',
    'maxItems',
    'x-rustra-variant-order',
  ]) {
    if (JSON.stringify(oldObj[facet]) !== JSON.stringify(newObj[facet])) {
      breaking.push({
        type: 'field_type_changed',
        command: `${path}.${facet}`,
        field: facet,
        from: JSON.stringify(oldObj[facet]) ?? '(absent)',
        to: JSON.stringify(newObj[facet]) ?? '(absent)',
      });
    }
  }
  const oldVariantKeys = variantKeys(oldObj);
  const newVariantKeys = variantKeys(newObj);
  if (JSON.stringify(oldVariantKeys) !== JSON.stringify(newVariantKeys)) {
    breaking.push({
      type: 'field_type_changed',
      command: `${path}.oneOf`,
      field: 'oneOf',
      from: `variant keys: ${JSON.stringify(oldVariantKeys)}`,
      to: `variant keys: ${JSON.stringify(newVariantKeys)}`,
    });
  }
  const oldProps = asRecord(oldObj.properties);
  const newProps = asRecord(newObj.properties);
  const oldOrder = Object.keys(oldProps).filter((field) => field in newProps);
  const newOrder = Object.keys(newProps).filter((field) => field in oldProps);
  if (oldOrder.some((field, index) => field !== newOrder[index])) {
    breaking.push({
      type: 'field_type_changed',
      command: path,
      field: lastSegment(path),
      from: `field order: ${oldOrder.join(', ')}`,
      to: `field order: ${newOrder.join(', ')}`,
    });
  }
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
      breaking.push({
        type: 'field_type_changed',
        command: `${path}.${field}`,
        field,
        from: '(absent)',
        to: '(optional field)',
      });
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
  for (const key of ['anyOf', 'oneOf', 'allOf', 'additionalProperties']) {
    if (oldObj[key] !== undefined || newObj[key] !== undefined) {
      compareSchemaNodes(
        oldObj[key],
        newObj[key],
        `${path}.${key}`,
        breaking,
        compatible,
        visited,
        definitions,
      );
    }
  }
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
  if (oldSchema === undefined && newSchema === undefined) return;
  compareSchemaNodes(oldSchema, newSchema, path, breaking, compatible, visited, definitions);
}

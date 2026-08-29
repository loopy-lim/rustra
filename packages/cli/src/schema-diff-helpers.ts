const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export const isString = (value: unknown): value is string => typeof value === 'string';
export function schemaShape(schema: Record<string, unknown>): string {
  if (typeof schema.$ref === 'string') return schema.$ref;
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type)) return schema.type.join('|');
  if (Array.isArray(schema.oneOf)) return 'oneOf';
  if (Array.isArray(schema.anyOf)) return 'anyOf';
  if (Array.isArray(schema.allOf)) return 'allOf';
  return 'schema';
}
export function objectId(value: object): number {
  const existing = objectIds.get(value);
  if (existing !== undefined) return existing;
  const id = nextObjectId++;
  objectIds.set(value, id);
  return id;
}
export const lastSegment = (path: string): string => path.split('.').at(-1) ?? path;
export function resolveDefinition(ref: string, definitions: Record<string, unknown>): unknown {
  const prefix = ref.startsWith('#/definitions/') ? '#/definitions/' : '#/$defs/';
  return ref.startsWith(prefix) ? definitions[ref.slice(prefix.length)] : undefined;
}

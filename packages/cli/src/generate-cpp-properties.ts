import { collectPostcardFields } from './generate-postcard-graph.js';
import type { PostcardField } from './generate-postcard-types.js';
import type { JsonSchema } from './schema.js';

export type CppProperty = (name: string) => string;
export const directCppProperty: CppProperty = (name) =>
  `jsi::PropNameID::forAscii(rt, ${JSON.stringify(name)})`;

/** Own finite schema names for this invocation; dynamic map keys stay local. */
export function cppProperties(fields: PostcardField[], definitions: Record<string, JsonSchema>) {
  const names = new Set<string>();
  const visited = new Set<string>();
  const visit = (field: PostcardField) => {
    names.add(field.name);
    if (field.refType && !visited.has(field.refType)) {
      visited.add(field.refType);
      const definition = definitions[field.refType];
      if (definition) collectPostcardFields(definition, definitions).fields.forEach(visit);
    }
    if (field.tupleItems) {
      names.add('value');
      field.tupleItems.forEach(visit);
    }
  };
  fields.forEach(visit);
  const indices = new Map([...names].map((name, i) => [name, `_prop_${i}`]));
  return {
    declarations: [...indices].map(
      ([name, id]) => `  const auto ${id} = ${directCppProperty(name)};`,
    ),
    property: ((name: string) => {
      const id = indices.get(name);
      if (!id) throw new Error(`Missing generated property: ${name}`);
      return id;
    }) satisfies CppProperty,
  };
}

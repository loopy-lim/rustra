export function resolveRef(ref: string): string {
  if (ref.startsWith('#/definitions/')) return ref.slice('#/definitions/'.length);
  if (ref.startsWith('#/$defs/')) return ref.slice('#/$defs/'.length);
  return ref;
}

export function escapeJsDoc(text: string): string {
  return text.replace(/\*\//g, '*\\/');
}
export function escapeStringLiteral(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

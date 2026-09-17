/** Flat arena fallback: links are array indices, IDs deliberately follow DFS order. */
export type Node = {
  id: number;
  name: string;
  tag: string;
  note?: string | null;
  metadata: Record<string, string>;
  children: number[];
};
export type Tree = { nodes: Node[] };
export type Search = { found: boolean; id: number; name: string; visited: number };
export const FIXTURES = [
  ['balanced', 255],
  ['balanced', 1023],
  ['balanced', 8191],
  ['wide', 1025],
] as const;
export function makeTree(shape: 'balanced' | 'wide', count: number): Tree {
  const nodes: Node[] = [];
  const append = (size: number): number => {
    const id = nodes.length;
    const node: Node = {
      id,
      name: `node-${id}`,
      tag: ['folder', 'file', 'link'][id % 3],
      note: id % 2 ? `note-${id}` : undefined,
      metadata: { owner: `owner-${id % 7}`, kind: 'bench' },
      children: [],
    };
    nodes.push(node);
    if (size > 1) {
      if (shape === 'wide') for (let i = 1; i < size; i++) node.children.push(append(1));
      else {
        const left = Math.floor((size - 1) / 2);
        if (left) node.children.push(append(left));
        node.children.push(append(size - 1 - left));
      }
    }
    return id;
  };
  append(count);
  return { nodes };
}
export function findTree(tree: Tree, id: number): Search {
  const stack = tree.nodes.length ? [0] : [];
  let visited = 0;
  while (stack.length) {
    const node = tree.nodes[stack.pop()!];
    visited++;
    if (node.id === id) return { found: true, id, name: node.name, visited };
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return { found: false, id, name: '', visited };
}
function canonical(value: unknown): unknown {
  if (value == null) return null;
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value))
    return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function assertSame(expected: unknown, actual: unknown): void {
  if (JSON.stringify(canonical(expected)) !== JSON.stringify(canonical(actual)))
    throw new Error('parity value mismatch');
}
export function assertFreshEcho(input: Tree, output: Tree): void {
  assertSame(input, output);
  if (
    input === output ||
    input.nodes === output.nodes ||
    input.nodes.some(
      (n, i) =>
        n === output.nodes[i] ||
        n.children === output.nodes[i].children ||
        n.metadata === output.nodes[i].metadata,
    )
  ) {
    throw new Error('echo must own fresh output');
  }
}

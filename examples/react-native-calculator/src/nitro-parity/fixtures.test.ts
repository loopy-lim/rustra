import { describe, expect, test } from 'bun:test';
import { makeTree, findTree, assertSame, assertFreshEcho, FIXTURES } from './fixtures';

describe('parity fixtures and preflight', () => {
  for (const [shape, count] of FIXTURES)
    test(`${shape} ${count}: every node visited for last and missing IDs`, () => {
      const tree = makeTree(shape, count);
      expect(tree.nodes.length).toBe(count);
      expect(findTree(tree, count - 1)).toEqual({
        found: true,
        id: count - 1,
        name: `node-${count - 1}`,
        visited: count,
      });
      expect(findTree(tree, -1)).toEqual({ found: false, id: -1, name: '', visited: count });
      expect(tree.nodes.some((n) => n.note == null)).toBe(true);
      expect(tree.nodes.some((n) => n.note != null)).toBe(true);
      expect(new Set(tree.nodes.map((n) => n.tag)).size).toBe(3);
      expect(Object.keys(tree.nodes[0].metadata).length).toBe(2);
      assertFreshEcho(tree, structuredClone(tree));
    });
  test('full comparison ignores map order and optional null/undefined, rejects deep corruption', () => {
    assertSame(
      { a: 1, m: { b: 'x', a: 'y' }, note: null },
      { note: undefined, m: { a: 'y', b: 'x' }, a: 1 },
    );
    expect(() => assertSame({ a: [1, 2] }, { a: [1, 3] })).toThrow();
    const tree = makeTree('balanced', 255);
    expect(() => assertFreshEcho(tree, tree)).toThrow();
    const alias = { ...tree, nodes: tree.nodes.map((n) => ({ ...n })) };
    expect(() => assertFreshEcho(tree, alias)).toThrow();
  });
});

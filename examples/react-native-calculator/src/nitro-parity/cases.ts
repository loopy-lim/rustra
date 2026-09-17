import type { RustraNative } from '@rustra/types';
import type { NitroBench } from 'nitro-bench';
import * as commands from '../../generated/commands';
import { frameRegistry } from '../../generated/frame-registry';
import { assertFreshEcho, assertSame, findTree, FIXTURES, makeTree, type Tree } from './fixtures';
export type Case = {
  id: string;
  nodes: number;
  inputBytes: number;
  byteMeaning: string;
  batch: number;
  rustra: () => unknown;
  rustraPublicSync: () => unknown;
  nitro: () => unknown;
  rustraAsync: () => Promise<unknown>;
  nitroAsync: () => Promise<unknown>;
  preflight: () => Promise<void>;
};
import { BUFFER_LIMIT } from './contract';
export function createCases(
  native: RustraNative,
  nitro: NitroBench,
  bindPublicSync?: (command: string) => (input: unknown) => unknown,
): Case[] {
  if (!native.invokeTypedById || !native.invokeTypedBuffer)
    throw new Error('required native diagnostic route unsupported');
  const diagnostic = (command: string, input: unknown) => () =>
    native.invokeTypedById!(frameRegistry.get(command)!.commandId, input);
  const bytes = (command: string, input: unknown) =>
    frameRegistry.get(command)!.encode(input).byteLength;
  const result: Case[] = [];
  const publicSync = (command: string, input: unknown) => {
    const bound = bindPublicSync?.(command);
    return () => {
      if (!bound) throw new Error('public sync binding unavailable');
      return bound(input);
    };
  };
  function add(
    id: string,
    command: string,
    input: unknown,
    expected: unknown,
    nitroSync: () => unknown,
    nitroAsync: () => Promise<unknown>,
    batch = 256,
    bufferBytes = 0,
  ) {
    const rustra = bufferBytes
      ? () =>
          native.invokeTypedBuffer!(
            frameRegistry.get(command)!.commandId,
            (input as { data: ArrayBuffer }).data,
          )
      : diagnostic(command, input);
    const publicCommand = (
      commands as unknown as Record<string, (input: unknown) => Promise<unknown>>
    )[command];
    const rustraAsync = () => publicCommand(input);
    const rustraPublicSync = publicSync(command, input);
    const check = (out: unknown) => {
      assertSame(expected, out);
      if (bufferBytes) {
        const a = (input as { data: ArrayBuffer }).data;
        const b = (out as { data: ArrayBuffer | Uint8Array }).data;
        if (a === b || (ArrayBuffer.isView(b) && b.buffer === a))
          throw new Error('buffer aliases input');
      }
      if (input && typeof input === 'object' && out === input)
        throw new Error('output aliases input');
    };
    result.push({
      id,
      nodes: 0,
      inputBytes: bytes(command, input),
      byteMeaning: 'encoded Rustra frame bytes (buffer payload size in case ID)',
      batch,
      rustra,
      rustraPublicSync,
      nitro: nitroSync,
      rustraAsync,
      nitroAsync,
      preflight: async () => {
        for (const out of [
          rustra(),
          nitroSync(),
          await rustraAsync(),
          await nitroAsync(),
          ...(bindPublicSync ? [rustraPublicSync()] : []),
        ])
          check(out);
      },
    });
  }
  const a = { a: 42, b: 58 },
    s = { value: 'Rustra ↔ Nitro: 문자열' },
    p = { name: 'pair', value: 123.5 };
  add(
    'add',
    'benchAdd',
    a,
    { value: 100 },
    () => nitro.benchAdd(a),
    () => nitro.benchAddAsync(a),
  );
  add(
    'string',
    'benchEchoString',
    s,
    s,
    () => nitro.echoString(s),
    () => nitro.echoStringAsync(s),
  );
  add(
    'pair',
    'benchEchoPair',
    p,
    p,
    () => nitro.echoPair(p),
    () => nitro.echoPairAsync(p),
  );
  for (const size of [64, 65536, BUFFER_LIMIT]) {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = (i * 17) % 251;
    const input = { data: data.buffer };
    add(
      `buffer${size}`,
      'benchEchoBytes',
      input,
      input,
      () => nitro.echoBuffer(input),
      () => nitro.echoBufferAsync(input),
      size === 64 ? 128 : size === 65536 ? 8 : 1,
      size,
    );
  }
  for (const [shape, count] of FIXTURES) {
    const tree = makeTree(shape, count);
    // Identical full replacement policy: both sides re-parse, retain and rebuild dense index.
    const updated = makeTree(shape, count);
    updated.nodes[count - 1].name = 'updated';
    const query = { id: count - 1 },
      find = { tree, id: query.id };
    const target = findTree(tree, query.id),
      indexed = { ...target, visited: 1 };
    const cast = (t: Tree) => t as Parameters<NitroBench['parityEcho']>[0];
    const entries: [string, string, unknown, unknown, () => unknown, () => Promise<unknown>][] = [
      [
        'echo',
        'parityEcho',
        tree,
        tree,
        () => nitro.parityEcho(cast(tree)),
        () => nitro.parityEchoAsync(cast(tree)),
      ],
      [
        'input-dfs',
        'parityFind',
        find,
        target,
        () => nitro.parityFind({ tree: cast(tree), id: query.id }),
        () => nitro.parityFindAsync({ tree: cast(tree), id: query.id }),
      ],
      [
        'resident-dfs',
        'parityResident',
        query,
        target,
        () => nitro.parityResident(query),
        () => nitro.parityResidentAsync(query),
      ],
      [
        'indexed',
        'parityIndexed',
        query,
        indexed,
        () => nitro.parityIndexed(query),
        () => nitro.parityIndexedAsync(query),
      ],
      [
        'setup',
        'parityStore',
        tree,
        { nodes: count },
        () => nitro.parityStore(cast(tree)),
        () => nitro.parityStoreAsync(cast(tree)),
      ],
      [
        'update',
        'parityStore',
        updated,
        { nodes: count },
        () => nitro.parityStore(cast(updated)),
        () => nitro.parityStoreAsync(cast(updated)),
      ],
    ];
    for (const [operation, command, input, expected, nitroSync, nitroAsync] of entries) {
      const rustra = diagnostic(command, input),
        rustraAsync = () =>
          (commands as unknown as Record<string, (v: unknown) => Promise<unknown>>)[command](input);
      const rustraPublicSync = publicSync(command, input);
      result.push({
        id: `${shape}${count}/${operation}`,
        nodes: count,
        inputBytes: bytes(command, input),
        byteMeaning: 'encoded Rustra frame bytes',
        batch: operation === 'indexed' ? 128 : operation === 'resident-dfs' ? 16 : 1,
        rustra,
        rustraPublicSync,
        nitro: nitroSync,
        rustraAsync,
        nitroAsync,
        preflight: async () => {
          diagnostic('parityStore', tree)();
          nitro.parityStore(cast(tree));
          for (const out of [
            rustra(),
            nitroSync(),
            await rustraAsync(),
            await nitroAsync(),
            ...(bindPublicSync ? [rustraPublicSync()] : []),
          ]) {
            assertSame(expected, out);
            if (operation === 'echo') assertFreshEcho(tree, out as Tree);
          }
          const stored = operation === 'update' ? updated : tree;
          if (operation === 'setup' || operation === 'update') {
            const wanted = findTree(stored, query.id);
            assertSame(wanted, diagnostic('parityResident', query)());
            assertSame(wanted, nitro.parityResident(query));
            assertSame({ ...wanted, visited: 1 }, diagnostic('parityIndexed', query)());
            assertSame({ ...wanted, visited: 1 }, nitro.parityIndexed(query));
          }
          const miss = { id: -1 },
            missing = { found: false, id: -1, name: '', visited: count };
          assertSame(missing, diagnostic('parityFind', { tree, id: -1 })());
          assertSame(missing, nitro.parityFind({ tree: cast(tree), id: -1 }));
          assertSame(missing, diagnostic('parityResident', miss)());
          assertSame(missing, nitro.parityResident(miss));
          assertSame({ ...missing, visited: 0 }, diagnostic('parityIndexed', miss)());
          assertSame({ ...missing, visited: 0 }, nitro.parityIndexed(miss));
        },
      });
    }
  }
  return result;
}

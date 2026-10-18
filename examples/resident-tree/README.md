# Resident tree example

Run from the repository root after `bun install --frozen-lockfile` and `bun run build`:

```bash
bun run test:app:resident-tree
```

The command builds the Rust example, renders TypeScript from its schema, and runs
the generated client over one persistent Node transport. No hand-written command
types are needed. It checks the schema hash before invoking.

`loadTree` validates and retains a tree; `findNode` sends a handle and target.
`updateNode` returns a new generation and invalidates previous handles.
`releaseTree` frees one tree and `clearTrees` frees all trees without reusing IDs.
Process disposal drops the whole store. The store allows 16 trees with at most
16,384 nodes each and depth 32; duplicate node IDs are rejected.

`receipt.json` records initial load time, 100 individual timings per route, and
request sizes. Both routes return the same result; whole-tree calls also pay for
validation. This is a debug-build example, not a release performance claim.
For an observed mean saving `d = mean(wholeUs) - mean(residentUs)`, the estimated
break-even number of queries is `ceil(loadMs * 1000 / d)` when `d > 0`; otherwise
this run has no measured break-even point. Startup and contract handshake are
outside `loadMs`. Account for storage, synchronization and update frequency in
your application before adopting this pattern.

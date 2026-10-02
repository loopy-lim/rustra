import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateBunEntryTs, generateNodeEntryTs } from './init-entries.js';
import ts from 'typescript';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function project() {
  const root = mkdtempSync(join(tmpdir(), 'rustra-host-entry-'));
  mkdirSync(join(root, 'generated'));
  mkdirSync(join(root, 'target/debug'), { recursive: true });
  symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'generated/commands.js'), 'export {};');
  writeFileSync(
    join(root, 'generated/contract.js'),
    "export const GENERATED_CONTRACT_HASH='valid-contract'; export const SCHEMA_VERSION=1;",
  );
  return root;
}

test('the generated Node event entry invokes and subscribes on one persistent runtime', () => {
  const root = project();
  const runtime = join(root, 'target/debug/event-host');
  const script = String.raw`
    import readline from 'node:readline';
    let count = 0;
    const events = [];
    const respond = (request) => {
      const { id, command } = request;
      let body;
      if (command === '__rustra_contract') body = { result: 'valid-contract' };
      else if (command === '__rustra_capabilities') body = { result: { events: 'polling' } };
      else if (command === '__drainEvents') body = { events: events.splice(0) };
      else { events.push({ name: 'tick', payload: ++count }); body = { result: count }; }
      return JSON.stringify({ id, ok: true, ...body });
    };
    if (process.argv[2] === 'invoke') {
      let input = '';
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => console.log(respond(JSON.parse(input))));
    } else {
      readline.createInterface({ input: process.stdin }).on('line', line => console.log(respond(JSON.parse(line))));
    }
  `;
  writeFileSync(runtime, `#!${process.execPath}\n${script}`);
  chmodSync(runtime, 0o755);
  writeFileSync(
    join(root, 'generated/node.js'),
    compileEntry(
      generateNodeEntryTs(
        { targetDirectoryUrl: '../target/', targetName: 'event-host' },
        { events: true },
      ),
    ),
  );
  const consumer = String.raw`
    import assert from 'node:assert/strict';
    const sets = [];
    const OriginalSet = globalThis.Set;
    globalThis.Set = class extends OriginalSet { constructor(...args) { super(...args); sets.push(this); } };
    const { rustra, events, subscribeEvent } = await import('./generated/node.js');
    globalThis.Set = OriginalSet;
    const seen = [];
    try {
      const unsubscribe = subscribeEvent('tick', payload => seen.push(payload));
      const facadeSubscriptions = sets.find(set => set.has(unsubscribe));
      assert.equal(facadeSubscriptions.size, 1);
      const engine = await rustra.ready();
      assert.equal(await engine.invoke('emit'), 1);
      assert.equal(await engine.invoke('emit'), 2);
      const deadline = Date.now() + 1000;
      while (seen.length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 1));
      assert.deepEqual(seen, [1, 2]);
      rustra.dispose();
      assert.equal(facadeSubscriptions.size, 0, 'bootstrap disposal releases facade callback closures');
    } finally { events.dispose(); rustra.dispose(); }
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', consumer], {
      cwd: root,
      encoding: 'utf8',
      timeout: 4000,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an opted-in generated Node CRUD client preserves records across create, read, update and delete', () => {
  const build = spawnSync(
    'cargo',
    ['build', '-p', 'rustra-crud-example', '--bin', 'rustra-crud-example'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  assert.equal(build.status, 0, build.stderr || String(build.error));
  const root = project();
  const config = JSON.parse(readFileSync(join(repoRoot, 'examples/crud/rustra.json'), 'utf8'));
  const entry = generateNodeEntryTs({
    targetDirectoryUrl: '../target/',
    targetName: 'rustra-crud-example',
    ...config.node,
  });
  symlinkSync(
    join(repoRoot, 'target/debug/rustra-crud-example'),
    join(root, 'target/debug/rustra-crud-example'),
  );
  for (const file of ['commands', 'contract']) {
    writeFileSync(
      join(root, 'generated', `${file}.js`),
      compileEntry(readFileSync(join(repoRoot, 'examples/crud/generated', `${file}.ts`), 'utf8')),
    );
  }
  writeFileSync(join(root, 'generated/node.js'), compileEntry(entry));
  const consumer = String.raw`
    import assert from 'node:assert/strict';
    import { createItem, getItem, updateItem, deleteItem, listItems, rustra } from './generated/node.js';
    try {
      const created = await createItem({name:'retained',value:7});
      const id = created.item.id;
      assert.deepEqual((await getItem({id})).item, created.item);
      assert.equal((await updateItem({id,name:'updated',value:9})).item.value, 9);
      const other = await createItem({name:'below the filter',value:0});
      assert.equal((await listItems({minValue:8})).items.length, 1);
      assert.equal((await deleteItem({id})).deleted, true);
      assert.equal((await getItem({id})).item, null);
      assert.equal((await deleteItem({id:other.item.id})).deleted, true);
    } finally { rustra.dispose(); }
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', consumer], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the generated Bun event entry binds subscribers to the compatible selected library', () => {
  const root = project();
  const extension =
    process.platform === 'darwin' ? 'dylib' : process.platform === 'win32' ? 'dll' : 'so';
  const library = `${process.platform === 'win32' ? '' : 'lib'}rustra_calculator_example.${extension}`;
  const source = join(repoRoot, 'target/debug', library);
  symlinkSync(source, join(root, 'target/debug', library));
  mkdirSync(join(root, 'target/release'));
  writeFileSync(join(root, 'target/release', library), 'incompatible native library');
  writeFileSync(
    join(root, 'generated/contract.js'),
    "export const GENERATED_CONTRACT_HASH=''; export const SCHEMA_VERSION=1;",
  );
  const entry = generateBunEntryTs(
    { targetDirectoryUrl: '../target/', targetName: 'rustra_calculator_example' },
    { events: true },
  ).replaceAll("contractVerification: 'strict'", "contractVerification: 'off'");
  writeFileSync(join(root, 'generated/bun.js'), compileEntry(entry));
  writeFileSync(
    join(root, 'generated/frame-registry.js'),
    'export const frameRegistry = new Map([["emitDemo", {commandId: 11, encode: () => Uint8Array.of(11,0,0,0).buffer, decode: () => ({ok:true,result:{emitted:1}})}]]);',
  );
  const consumer = String.raw`
    import assert from 'node:assert/strict';
    import { rustra, events, subscribeEvent } from './generated/bun.js';
    const seen = [];
    try {
      subscribeEvent('demo.done', payload => seen.push(payload));
      await (await rustra.ready()).invoke('emitDemo');
      assert.deepEqual(seen, [{ emitted: 1 }]);
    } finally { events.dispose(); rustra.dispose(); }
  `;
  try {
    const result = spawnSync('bun', ['-e', consumer], {
      cwd: root,
      encoding: 'utf8',
      timeout: 4000,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the generated Node streaming entry receives background events from its invoked runtime', () => {
  const build = spawnSync(
    'cargo',
    ['build', '-p', 'rustra-streaming-example', '--bin', 'rustra-streaming-invoke'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  assert.equal(build.status, 0, build.stderr || String(build.error));
  const root = project();
  const entry = generateNodeEntryTs(
    {
      targetDirectoryUrl: '../target/',
      targetName: 'rustra-streaming-invoke',
      args: ['--serve'],
    },
    { events: true },
  );
  symlinkSync(
    join(repoRoot, 'target/debug/rustra-streaming-invoke'),
    join(root, 'target/debug/rustra-streaming-invoke'),
  );
  for (const file of ['commands', 'contract', 'events']) {
    writeFileSync(
      join(root, 'generated', `${file}.js`),
      compileEntry(
        readFileSync(join(repoRoot, 'examples/streaming/generated', `${file}.ts`), 'utf8'),
      ),
    );
  }
  writeFileSync(join(root, 'generated/node.js'), compileEntry(entry));
  const consumer = String.raw`
    import assert from 'node:assert/strict';
    import {startJob, subscribeEvent, rustra} from './generated/node.js';
    import {onRustraEvent} from './generated/events.js';
    const ticks = [];
    const done = [];
    try {
      onRustraEvent(subscribeEvent, 'progress.tick', payload => ticks.push(payload.step));
      onRustraEvent(subscribeEvent, 'job.done', payload => done.push(payload));
      assert.equal((await startJob({jobId:'generated',totalSteps:3,stepDelayMs:0})).accepted, true);
      const deadline = Date.now() + 2000;
      while (!done.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
      assert.deepEqual(ticks, [1,2,3]);
      assert.deepEqual(done, [{jobId:'generated',steps:3}]);
    } finally { rustra.dispose(); }
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', consumer], {
      cwd: root,
      encoding: 'utf8',
      timeout: 4_000,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function compileEntry(source: string) {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
}

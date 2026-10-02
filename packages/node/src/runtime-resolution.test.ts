import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  RustraCommandError,
  createNodeBootstrap,
  nodeRuntimeCandidates,
  resolveNodeRuntime,
} from './index.js';

const processTest = process.versions.bun || process.platform === 'win32' ? test.skip : test;
const previousBinary = process.env.RUSTRA_NODE_BINARY;
test.beforeEach(() => {
  delete process.env.RUSTRA_NODE_BINARY;
});
test.afterEach(() => {
  if (previousBinary === undefined) delete process.env.RUSTRA_NODE_BINARY;
  else process.env.RUSTRA_NODE_BINARY = previousBinary;
});

function executable(path: string) {
  writeFileSync(
    path,
    `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({ok:true,result:{value:42,cwd:process.cwd()}})));\n`,
  );
  chmodSync(path, 0o755);
}

for (const kind of ['string', 'URL'] as const) {
  processTest(
    `relative runtime candidates invoke successfully with a ${kind} child cwd`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'rustra-node-runtime cwd-'));
      const candidate = join(root, 'runtime');
      executable(candidate);
      const cwd = kind === 'URL' ? pathToFileURL(root) : root;
      const options = { commandCandidates: ['./runtime'], spawnOptions: { cwd } };
      const bootstrap = createNodeBootstrap(options);
      try {
        assert.deepEqual(nodeRuntimeCandidates(options), [candidate]);
        const result = await (
          await bootstrap.ready()
        ).invoke<{ value: number; cwd: string }>('ping');
        assert.deepEqual(result, { value: 42, cwd: realpathSync(root) });
      } finally {
        bootstrap.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

test('inferred Cargo binaries are searched from the requested child directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-node-inferred-cwd-'));
  const cwd = join(root, 'apps/client space');
  const binaryName = 'rustra-cwd-example';
  const binary = join(
    root,
    'target/debug',
    binaryName + (process.platform === 'win32' ? '.exe' : ''),
  );
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(root, 'target/debug'), { recursive: true });
  writeFileSync(binary, 'runtime fixture');
  try {
    assert.deepEqual(
      nodeRuntimeCandidates({ binaryName, spawnOptions: { cwd: pathToFileURL(cwd) } }),
      [binary],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing-runtime diagnostics identify the requested cwd and exact checked candidate', () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-node-missing-cwd-'));
  try {
    assert.throws(
      () =>
        resolveNodeRuntime({
          commandCandidates: ['./missing-runtime'],
          spawnOptions: { cwd: root },
        }),
      (error: unknown) => {
        assert.ok(error instanceof RustraCommandError);
        assert.equal(error.code, 'transport.unavailable');
        assert.ok(error.message.includes(root), error.message);
        assert.ok(error.message.includes(join(root, 'missing-runtime')), error.message);
        assert.match(error.message, /RUSTRA_NODE_BINARY/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

processTest(
  'an explicit bare command still uses the child PATH rather than becoming a local filename',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'rustra-node-path-command-'));
    const bin = join(root, 'bin');
    const cwd = join(root, 'app');
    mkdirSync(bin);
    mkdirSync(cwd);
    executable(join(bin, 'rustra-path-command'));
    const options = {
      command: 'rustra-path-command',
      spawnOptions: { cwd, env: { ...process.env, PATH: bin + ':' + process.env.PATH } },
    };
    const bootstrap = createNodeBootstrap(options);
    try {
      assert.deepEqual(nodeRuntimeCandidates(options), ['rustra-path-command']);
      assert.deepEqual(await (await bootstrap.ready()).invoke('ping'), {
        value: 42,
        cwd: realpathSync(cwd),
      });
    } finally {
      bootstrap.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

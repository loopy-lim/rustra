import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { RustraCommandError, type FrameCodec } from '@rustra/types';
import { createNodeLoopTransport } from './index.js';

const processTest = process.versions.bun ? test.skip : test;
const adapterUrl = new URL('./index.js', import.meta.url).href;

processTest('a missing loop runtime rejects without crashing the host process', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { createNodeLoopTransport } from ${JSON.stringify(adapterUrl)};
    const transport = createNodeLoopTransport({ command: '/missing-rustra-loop-runtime' });
    await assert.rejects(transport.invoke('ping'), (error) => error.code === 'transport.error');
    transport.dispose();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 2_000,
  });
  assert.equal(result.status, 0, result.stderr);
});

for (const [name, response] of [
  ['null', 'null'],
  ['array', '[]'],
  ['missing-ok', JSON.stringify({ id: 1, result: 7 })],
  ['failed-error-object', JSON.stringify({ id: 1, ok: false, error: {} })],
]) {
  processTest(`a malformed JSON response (${name}) rejects without crashing the Node host`, () => {
    const producer = `process.stdin.once('data',()=>process.stdout.write(${JSON.stringify(response + '\n')}))`;
    const script = `
      import assert from 'node:assert/strict';
      import {createNodeLoopTransport} from ${JSON.stringify(adapterUrl)};
      const transport=createNodeLoopTransport({command:process.execPath,args:['-e',${JSON.stringify(producer)}]});
      try { await assert.rejects(async()=>await transport.invoke('ping'),error=>error.code==='invoke.malformed'); }
      finally {transport.dispose();}
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 2_000,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
  });
}

processTest('an early one-shot exit rejects a failed stdin write without crashing the host', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { createNodeProcessTransport } from ${JSON.stringify(adapterUrl)};
    const transport = createNodeProcessTransport({ command: process.execPath, args: ['-e', 'process.exit(0)'] });
    await assert.rejects(transport.invoke('ping', 'x'.repeat(1_000_000)), (error) => error.code === 'transport.error');
    transport.dispose();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 2_000,
  });
  assert.equal(result.status, 0, result.stderr);
});

processTest('NDJSON preserves a multibyte character split across stdout chunks', async () => {
  const script = String.raw`
    process.stdin.once('data', (request) => {
      const { id } = JSON.parse(request.toString());
      const bytes = Buffer.from(JSON.stringify({ id, ok: true, result: '안녕하세요' }) + '\n');
      const split = bytes.indexOf(Buffer.from('안')) + 1;
      process.stdout.write(bytes.subarray(0, split));
      setTimeout(() => process.stdout.write(bytes.subarray(split)), 15);
    });
  `;
  const transport = createNodeLoopTransport({ command: process.execPath, args: ['-e', script] });
  try {
    assert.equal(await transport.invoke('ping'), '안녕하세요');
  } finally {
    transport.dispose();
  }
});

processTest(
  'a runtime closing its inherited stdout is not replaced before teardown settles',
  async () => {
    const script = String.raw`
    process.stdin.once('data', (request) => {
      const { id } = JSON.parse(request.toString());
      require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 250)'], {
        stdio: ['ignore', process.stdout, 'ignore'],
      });
      process.stdout.write(JSON.stringify({id,ok:true,result:process.pid})+'\n', () => process.exit(0));
    });
  `;
    const transport = createNodeLoopTransport({ command: process.execPath, args: ['-e', script] });
    try {
      const first = await transport.invoke('first');
      await new Promise((resolve) => setTimeout(resolve, 30));
      await assert.rejects(
        async () => await transport.invoke('during-close'),
        /runtime process is closing/,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      const next = await transport.invoke('after-close');
      assert.notEqual(next, first);
    } finally {
      transport.dispose();
    }
  },
);

processTest('binary negotiation preserves a push frame in the same stdout chunk', async () => {
  const script = String.raw`
    process.stdin.once('data', (request) => {
      const { id } = JSON.parse(request.toString());
      const hello = Buffer.from(JSON.stringify({ id, ok: true, binary: true, events: 'push' }) + '\n');
      const payload = Buffer.from(JSON.stringify({ name: 'tick', payload: '42', seq: 0 }));
      const push = Buffer.alloc(6 + payload.length);
      push.writeUInt32LE(2 + payload.length, 0);
      push.writeUInt16LE(0xfffd, 4);
      payload.copy(push, 6);
      process.stdout.write(Buffer.concat([hello, push]));
    });
  `;
  const transport = createNodeLoopTransport({
    command: process.execPath,
    args: ['-e', script],
    codecs: new Map(),
  });
  const events: unknown[] = [];
  transport.onPushEvent?.((event) => events.push(event));
  try {
    await transport.ready();
    assert.deepEqual(events, [{ name: 'tick', payload: '42', seq: 0 }]);
  } finally {
    transport.dispose();
  }
});

const pingCodec: FrameCodec<unknown, unknown> = {
  commandId: 1,
  encode() {
    return Uint8Array.of(1, 0).buffer;
  },
  decode(frame) {
    const bytes =
      frame instanceof ArrayBuffer
        ? new Uint8Array(frame)
        : new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
    return { ok: true, result: bytes[8] };
  },
};

processTest('a restarted binary runtime renegotiates before the next invocation', async () => {
  const script = String.raw`
    let binary = false;
    process.stdin.on('data', (request) => {
      if (!binary) {
        const { id } = JSON.parse(request.toString());
        binary = true;
        process.stdout.write(JSON.stringify({ id, ok: true, binary: true }) + '\n');
      } else {
        process.stdout.write(Buffer.from([9, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 42]));
      }
    });
  `;
  const transport = createNodeLoopTransport({
    command: process.execPath,
    args: ['-e', script],
    codecs: new Map([['ping', pingCodec]]),
  });
  try {
    assert.equal(await transport.invoke('ping'), 42);
    const initialPid = transport.pid!;
    process.kill(initialPid, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(await transport.invoke('ping'), 42);
    assert.notEqual(transport.pid, initialPid);
  } finally {
    transport.dispose();
  }
});

processTest(
  'loop disposal prevents invocation and event drain from reviving the process',
  async () => {
    const transport = createNodeLoopTransport({
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
    });
    transport.dispose();
    for (const operation of [
      () => transport.invoke('ping'),
      () => transport.drainEvents(),
      () => transport.ready(),
    ]) {
      await assert.rejects(
        Promise.resolve().then(operation),
        (error: unknown) => error instanceof RustraCommandError && /disposed/.test(error.message),
      );
    }
    assert.equal(transport.pid, null);
  },
);

processTest(
  'a failed binary handshake rejects readiness instead of reporting success',
  async () => {
    const transport = createNodeLoopTransport({
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
      codecs: new Map(),
    });
    try {
      await assert.rejects(
        transport.ready(),
        (error: unknown) => error instanceof RustraCommandError && error.code === 'transport.error',
      );
    } finally {
      transport.dispose();
    }
  },
);

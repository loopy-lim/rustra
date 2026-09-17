/** Current-source generated client -> real Rust binary -> generated decoder. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  generateCommandsTs,
  generateTypesTs,
  generateFrameCodecsTs,
  generateFrameRegistryTs,
  generateFrameCodecsCpp,
  generateFrameCodecsHpp,
} from '../packages/cli/src/generate.ts';
import { parsePackageSchema } from '../packages/cli/src/schema-validation.ts';
import type { FrameCodec } from '../packages/types/src/public.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const target = process.env.CARGO_TARGET_DIR ?? join(root, 'target');
const fixture = join(resolve(root, target), 'debug/examples/function_fixture');
const scratch = mkdtempSync(join(tmpdir(), 'rustra-functions-'));
function run(command: string, args: string[], input?: string): string {
  const result = spawnSync(command, args, {
    cwd: root,
    input,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, `${command}: ${result.error}`);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}
type WireResponse = { hex: string; calls: number };
const wire = (hex: string, capacity?: number): WireResponse =>
  JSON.parse(run(fixture, [], JSON.stringify([{ hex, capacity }])))[0];
const hex = (buffer: ArrayBuffer | ArrayBufferView): string =>
  (ArrayBuffer.isView(buffer)
    ? Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : Buffer.from(buffer)
  ).toString('hex');
const buffer = (value: string): ArrayBuffer => Uint8Array.from(Buffer.from(value, 'hex')).buffer;

try {
  run('cargo', ['build', '--locked', '-p', 'rustra', '--example', 'function_fixture']);
  run('bun', ['run', '--cwd', 'packages/types', 'build']);
  const emitted = JSON.parse(run(fixture, ['schema']));
  const schema = parsePackageSchema(emitted.schema);
  mkdirSync(join(scratch, 'node_modules/@rustra'), { recursive: true });
  symlinkSync(join(root, 'packages/types'), join(scratch, 'node_modules/@rustra/types'));
  writeFileSync(join(scratch, 'package.json'), '{"type":"module"}\n');
  const files = {
    'types.ts': generateTypesTs(schema),
    'commands.ts': generateCommandsTs(schema),
    'rust-commands.ts': emitted.commands,
    'contract.ts': emitted.contract,
    'frame-codecs.ts': generateFrameCodecsTs(schema),
    'frame-registry.ts': generateFrameRegistryTs(schema),
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(scratch, name), text);
  if (process.argv.includes('--cpp')) {
    writeFileSync(join(scratch, 'rustra-generated-codecs.cpp'), generateFrameCodecsCpp(schema));
    writeFileSync(join(scratch, 'rustra-generated-codecs.hpp'), generateFrameCodecsHpp(schema));
    mkdirSync(join(scratch, 'jsi'));
    writeFileSync(join(scratch, 'jsi/jsi.h'), '#pragma once\n');
    writeFileSync(
      join(scratch, 'native-check.cpp'),
      `
#include "rustra-generated-codecs.hpp"
#include <cassert>
#include <cstring>
namespace rustra::generated {
facebook::jsi::Value make_array_buffer(facebook::jsi::Runtime& rt, const uint8_t* data, size_t size) {
  facebook::jsi::ArrayBuffer buffer(rt, size);
  if (size) std::memcpy(buffer.data(rt), data, size);
  return facebook::jsi::Value(rt, facebook::jsi::Object(rt, buffer));
}
}
int main() {
  namespace gen = rustra::generated;
  facebook::jsi::Runtime rt;
  ${schema.commands
    .map(
      (command) => `
  assert(!gen::has_static_codec(${JSON.stringify(command.name)}));
  assert(!gen::has_static_codec_id(${command.commandId}));
  assert(!gen::has_pos_codec(${command.commandId}));
  assert(!gen::has_raw_codec(${command.commandId}));
  assert(!gen::has_buffer_codec(${command.commandId}));
  `,
    )
    .join('')}
}
`,
    );
    run(process.env.CXX ?? 'clang++', [
      '-std=c++17',
      '-O2',
      '-DRUSTRA_TEST_JSI_SHIM=1',
      '-I',
      scratch,
      '-I',
      join(root, 'packages/react-native/native/cpp'),
      '-include',
      join(root, 'examples/react-native-calculator/modules/rustra-jsi/ios/test-jsi-shim.hpp'),
      join(scratch, 'native-check.cpp'),
      join(scratch, 'rustra-generated-codecs.cpp'),
      '-o',
      join(scratch, 'native-check'),
    ]);
    run(join(scratch, 'native-check'), []);
  }
  // Compile actual emitted signatures: tuple argument count/types, ordinary
  // return types, and the final optional InvokeOptions all belong to the API.
  writeFileSync(
    join(scratch, 'consumer.ts'),
    `
import { add, reset, greet, tuple, divide } from './commands.js';
const n: Promise<number> = add(2, 3);
const v: Promise<void> = reset({ timeoutMs: 100 });
const s: Promise<string> = greet('Ada');
tuple([4, 'x'], true); divide(8, 2, {});
// @ts-expect-error Missing second argument.
add(2);
// @ts-expect-error Wrong argument type.
add('2', 3);
// @ts-expect-error Unit return is not a number.
const wrong: Promise<number> = reset();
void [n, v, s, wrong];
`,
  );
  writeFileSync(
    join(scratch, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['*.ts'],
    }),
  );
  run('node', [require.resolve('typescript/bin/tsc'), '-p', join(scratch, 'tsconfig.json')]);
  const { frameRegistry } = await import(pathToFileURL(join(scratch, 'frame-registry.ts')).href);
  const commands = await import(pathToFileURL(join(scratch, 'commands.ts')).href);
  const rustCommands = await import(pathToFileURL(join(scratch, 'rust-commands.ts')).href);
  const { createFrameEngine, configure } = await import(
    pathToFileURL(join(root, 'packages/types/dist/index.js')).href
  );
  const cases: { name: string; args: unknown[]; expected: unknown; calls?: number }[] = [
    { name: 'add', args: [2, 3], expected: 5 },
    { name: 'reset', args: [], expected: undefined, calls: 1 },
    { name: 'greet', args: ['Ada 한글'], expected: 'Hello, Ada 한글!' },
    { name: 'tuple', args: [[4, 'x'], true], expected: [[4, 'x'], true] },
    { name: 'maybe', args: [true], expected: 42 },
    { name: 'maybe', args: [false], expected: null },
    { name: 'list', args: [3], expected: [0, 1, 2] },
    { name: 'user', args: [7, 'Ada'], expected: { id: 7, name: 'Ada' } },
    { name: 'map', args: [8], expected: { value: 8 } },
    { name: 'unitArg', args: [null], expected: 7 },
    { name: 'nan', args: [], expected: NaN, calls: 1 },
    { name: 'divide', args: [8, 2], expected: 4, calls: 1 },
    { name: 'status', args: [], expected: { Ready: { count: 9 } } },
    { name: 'fixed', args: [[8, 3]], expected: [11, 5] },
    { name: 'byte', args: [200], expected: 200 },
    { name: 'signedByte', args: [-128], expected: -128 },
    { name: 'signedByte', args: [127], expected: 127 },
    { name: 'floats', args: [[0.5, 1.25]], expected: [0.5, 1.25] },
    {
      name: 'optional',
      args: [{ child: { child: { n: 3 } } }],
      expected: { child: { child: { n: 3 } } },
    },
    { name: 'optional', args: [{ child: null }], expected: { child: null } },
  ];
  let checked = 0;
  for (const test of cases) {
    const codec: FrameCodec<unknown, unknown> = frameRegistry.get(test.name);
    assert.ok(codec, `${test.name}: generated binary codec missing`);
    const args = test.args.length === 0 ? undefined : test.args;
    const encoded = codec.encode(args);
    if (codec.encodeInto) {
      const reuse = new Uint8Array(64);
      const written = codec.encodeInto(args, reuse);
      assert.equal(hex(written), hex(encoded), `${test.name}: cursor wire differs`);
      assert.equal(written.buffer, reuse.buffer, `${test.name}: unexpectedly grew buffer`);
    }
    for (const capacity of [undefined, 8, 256]) {
      const response = wire(hex(encoded), capacity);
      const outcome = codec.decode(buffer(response.hex));
      assert.equal(outcome.ok, true, `${test.name}: ${JSON.stringify(outcome)}`);
      assert.deepEqual(outcome.result, test.expected, `${test.name}: return shape`);
      if (test.calls !== undefined)
        assert.equal(response.calls, test.calls, `${test.name}: executed twice`);
      checked++;
    }
  }
  assert.equal(hex(frameRegistry.get('add').encode([2, 3])), '01000406');
  assert.equal(wire('01000406').hex, '01000000000000000a');

  // Exercise real wrappers and engine routing, including new/legacy native hosts
  // that decline native static codecs, and live schema with no static JS registry.
  for (const mode of ['frame', 'capabilities', 'legacy-native', 'live'] as const) {
    let invocations = 0;
    const native = {
      invokeFrame(request: ArrayBuffer) {
        invocations++;
        return buffer(wire(hex(request)).hex);
      },
      getSchema: () => new TextEncoder().encode(JSON.stringify(schema)).buffer,
      ...(mode === 'capabilities' ? { getCodecCapabilities: () => 0 } : {}),
      ...(mode === 'legacy-native' ? { hasStaticCodec: () => false } : {}),
      ...(mode === 'capabilities' || mode === 'legacy-native'
        ? {
            invokeTyped: () => {
              throw new Error('unsupported native root route');
            },
            invokeTypedById: () => {
              throw new Error('unsupported native root route');
            },
            invokeTypedRaw: () => {
              throw new Error('unsafe raw root route');
            },
          }
        : {}),
    };
    const engine = createFrameEngine(native, mode === 'live' ? new Map() : frameRegistry);
    const release = configure(engine);
    try {
      for (const api of [commands, rustCommands]) {
        for (const test of cases) {
          const before = invocations;
          assert.deepEqual(
            await api[test.name](...test.args),
            test.expected,
            `${mode}/${test.name}`,
          );
          assert.equal(invocations - before, 1, `${mode}/${test.name}: duplicate bridge call`);
          checked++;
        }
        await assert.rejects(api.divide(1, 0), { code: 'math.zero' });
        assert.equal(await api.dynamic(), true, `${mode}: zero-argument JSON fallback`);
        checked++;
      }
    } finally {
      release();
    }
  }
  const { createNodeEngine, createNodeProcessTransport } =
    await import('../packages/node/src/node-core.ts');
  const transport = createNodeProcessTransport({ command: fixture, args: ['json'] });
  const { createTauriEngine } = await import('../packages/tauri/src/index.ts');
  const jsonEngines = {
    'node-process': createNodeEngine(transport),
    'tauri-json': createTauriEngine({
      invoke: async (_command: string, payload: unknown) => {
        const response = JSON.parse(run(fixture, ['json'], JSON.stringify(payload)));
        if (!response.ok) throw response.error;
        return response.result;
      },
    }),
  };
  try {
    for (const [mode, engine] of Object.entries(jsonEngines)) {
      const release = configure(engine);
      try {
        for (const api of [commands, rustCommands]) {
          // JSON cannot represent NaN. Its binary behavior is tested above.
          for (const test of cases.filter((test) => test.name !== 'nan')) {
            assert.deepEqual(
              await api[test.name](...test.args),
              test.expected,
              `${mode}/${test.name}`,
            );
            checked++;
          }
          assert.equal(await api.dynamic(), true);
          await assert.rejects(api.divide(1, 0), { code: 'math.zero' });
          checked++;
        }
      } finally {
        release();
      }
    }
  } finally {
    transport.dispose();
  }
  const errorCodec = frameRegistry.get('divide');
  const errorResponse = wire(hex(errorCodec.encode([1, 0])));
  assert.equal(errorResponse.calls, 1);
  assert.equal(errorCodec.decode(buffer(errorResponse.hex)).error?.code, 'math.zero');
  const malformed = frameRegistry.get('add').decode(buffer(wire('010004').hex));
  assert.equal(malformed.ok, false, 'missing binary argument must fail');
  let encodingBenchmark;
  if (process.argv.includes('--bench')) {
    const codec: FrameCodec<unknown, unknown> = frameRegistry.get('add');
    assert.ok(codec.encodeInto);
    const reuse = new Uint8Array(64);
    const args = [20, 22];
    let checksum = 0;
    const operations = {
      encode: () => new Uint8Array(codec.encode(args)),
      encodeInto: () => codec.encodeInto!(args, reuse),
    };
    const samples: Record<string, number[]> = { encode: [], encodeInto: [] };
    const iterations = 50_000;
    for (let round = 0; round < 22; round++) {
      // Alternate order to reduce warm-up/thermal bias. First two rounds warm up.
      for (const name of round % 2 ? ['encodeInto', 'encode'] : ['encode', 'encodeInto']) {
        const operation = operations[name as keyof typeof operations];
        const start = performance.now();
        for (let i = 0; i < iterations; i++) {
          args[0] = i & 31;
          const encoded = operation();
          checksum += encoded[2];
        }
        if (round >= 2) samples[name].push(((performance.now() - start) * 1e6) / iterations);
      }
    }
    encodingBenchmark = {
      scope: 'Generated request encoding only; excludes transport exact-buffer copy and Rust call',
      iterationsPerSample: iterations,
      samples: 20,
      checksum,
      nanoseconds: Object.fromEntries(
        Object.entries(samples).map(([name, values]) => {
          const sorted = values.toSorted((a, b) => a - b);
          return [name, { median: (sorted[9] + sorted[10]) / 2, min: sorted[0], max: sorted[19] }];
        }),
      ),
    };
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        commands: schema.commands.length,
        checked,
        routes: [
          'generated',
          'cursor',
          'caller-buffer',
          'live-schema',
          'native-declined',
          'node-process-json',
          'tauri-json-adapter',
        ],
        rustAndCliWrappers: true,
        cppShimCapabilityCheck: process.argv.includes('--cpp'),
        encodingBenchmark,
        source: root,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

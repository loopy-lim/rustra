import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateCommandsTs } from './generate-commands.js';
import { generateFrameCodecsTs, commandCodecSupported } from './generate-postcard-codec.js';
import { analyzeCppCommands } from './generate-cpp-analysis.js';
import { parsePackageSchema } from './schema-validation.js';
import type { CommandSchema, PackageSchema } from './schema.js';
const i32 = { type: 'integer', format: 'int32' };
const add = {
  name: 'add',
  commandId: 1,
  functionArgs: 2,
  inputType: 'Args',
  outputType: 'Out',
  inputSchema: { type: 'array', items: [i32, i32], minItems: 2, maxItems: 2 },
  outputSchema: i32,
} satisfies CommandSchema;
const schema: PackageSchema = { packageId: 'test', commands: [add] };
test('function tuple roots use postcard and positional helpers, with no native object codec', () => {
  assert.equal(commandCodecSupported(add, {}), true);
  assert.match(
    generateCommandsTs(schema),
    /add\(arg0: Args\[0\], arg1: Args\[1\], options\?: InvokeOptions\)/,
  );
  const source = generateFrameCodecsTs(schema);
  assert.match(source, /args\[0\]/);
  assert.match(source, /encodeInto/);
  const native = analyzeCppCommands(schema);
  for (const key of [
    'supported',
    'complexSupported',
    'staticCommands',
    'posCommands',
    'rawCommands',
    'bufferCommands',
    'bufferInputCommands',
  ] as const)
    assert.equal(native[key].length, 0, key);
});
test('function arity metadata requires a matching fixed tuple or unit', () => {
  parsePackageSchema(schema);
  for (const functionArgs of [-1, 13, 1.5, 0, 1, 3, '2'])
    assert.throws(
      () => parsePackageSchema({ ...schema, commands: [{ ...add, functionArgs }] }),
      /functionArgs/,
    );
});

test('function metadata differences are visible to schema diff', async () => {
  const { diffSchemas } = await import('./schema-diff.js');
  const legacy = { ...schema, commands: [{ ...add, functionArgs: undefined }] };
  assert.ok(
    diffSchemas(legacy, schema).breaking.some(
      (change) => change.type === 'field_type_changed' && change.field === 'functionArgs',
    ),
  );
});

test('native does not re-admit functions with complex output or unit roots', () => {
  for (const command of [
    {
      ...add,
      name: 'reset',
      functionArgs: 0,
      inputType: '()',
      outputType: '()',
      inputSchema: { type: 'null' },
      outputSchema: { type: 'null' },
    },
    {
      ...add,
      outputSchema: {
        oneOf: [
          { type: 'string', enum: ['Idle'] },
          {
            type: 'object',
            properties: { Ready: { type: 'integer' } },
            required: ['Ready'],
            additionalProperties: false,
          },
        ],
      },
    },
  ]) {
    const native = analyzeCppCommands({ ...schema, commands: [command] });
    assert.equal(native.staticCommands.length, 0);
    assert.equal(native.complexSupported.length, 0);
  }
});

test('legacy object fixed-array fields select the shared postcard codec and decline stale native vectors', () => {
  const fixed = { type: 'array', items: i32, minItems: 2, maxItems: 2 };
  const command = {
    ...add,
    functionArgs: undefined,
    inputSchema: { type: 'object', properties: { values: fixed } },
    outputSchema: { type: 'object', properties: { values: fixed } },
  };
  const pkg = { ...schema, commands: [command] };
  assert.equal(commandCodecSupported(command, {}), true);
  assert.match(generateFrameCodecsTs(pkg), /export const addCodec = createSchemaPostcardCodec/);
  assert.equal(analyzeCppCommands(pkg).staticCommands.length, 0);
});

test('generated closed-struct codecs retain actual postcard tuple bytes', async () => {
  const { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const tuple = { type: 'array', items: [i32, i32], minItems: 2, maxItems: 2 };
  const closed = {
    type: 'object',
    properties: { pair: tuple },
    required: ['pair'],
    additionalProperties: false,
  };
  const command = { ...add, functionArgs: undefined, inputSchema: closed, outputSchema: closed };
  assert.equal(commandCodecSupported(command, {}), true);
  for (const additionalProperties of [true, i32])
    assert.equal(
      commandCodecSupported({ ...command, inputSchema: { ...closed, additionalProperties } }, {}),
      false,
    );
  const dir = mkdtempSync(join(tmpdir(), 'rustra-closed-'));
  mkdirSync(join(dir, 'node_modules/@rustra'), { recursive: true });
  symlinkSync(
    fileURLToPath(new URL('../../types', import.meta.url)),
    join(dir, 'node_modules/@rustra/types'),
    'junction',
  );
  const path = join(dir, 'codecs.ts');
  writeFileSync(path, generateFrameCodecsTs({ ...schema, commands: [command] }));
  try {
    const { addCodec } = await import(pathToFileURL(path).href);
    assert.deepEqual([...new Uint8Array(addCodec.encode({ pair: [8, 3] }))], [1, 0, 16, 6]);
    assert.deepEqual(addCodec.decode(Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 22, 10)), {
      ok: true,
      result: { pair: [11, 5] },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('static legacy depth boundary agrees with live postcard and preserves existing bytes', async () => {
  const { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const { createSchemaPostcardCodec } = await import('@rustra/types');
  const ref = (name: string) => ({ $ref: `#/definitions/${name}` });
  const definitions = {
    L1: { type: 'object', properties: { child: ref('L2') } },
    L2: { type: 'object', properties: { child: ref('L3') } },
    L3: { type: 'object', properties: { child: ref('L4') } },
    L4: { type: 'object', properties: { n: i32 } },
  };
  const root = {
    type: 'object',
    properties: {
      child: ref('L1'),
      pair: { type: 'array', items: [i32, i32], minItems: 2, maxItems: 2 },
    },
  };
  const command = {
    ...add,
    functionArgs: undefined,
    inputSchema: root,
    outputSchema: root,
    definitions,
  };
  assert.equal(commandCodecSupported(command, definitions), true);
  const deeper = {
    ...definitions,
    L4: { type: 'object', properties: { child: ref('L5') } },
    L5: { type: 'object', properties: { n: i32 } },
  };
  assert.equal(commandCodecSupported({ ...command, definitions: deeper }, deeper), false);
  const live = createSchemaPostcardCodec(1, root, root, definitions, true)!;
  assert.notEqual(live, null);
  const dir = mkdtempSync(join(tmpdir(), 'rustra-depth-boundary-'));
  mkdirSync(join(dir, 'node_modules/@rustra'), { recursive: true });
  symlinkSync(
    fileURLToPath(new URL('../../types', import.meta.url)),
    join(dir, 'node_modules/@rustra/types'),
    'junction',
  );
  const path = join(dir, 'codecs.ts');
  writeFileSync(path, generateFrameCodecsTs({ ...schema, commands: [command] }));
  try {
    const { addCodec } = await import(pathToFileURL(path).href);
    const value = { child: { child: { child: { child: { n: 3 } } } }, pair: [4, 5] };
    for (const codec of [addCodec, live]) {
      assert.deepEqual([...new Uint8Array(codec.encode(value))], [1, 0, 6, 8, 10]);
      assert.deepEqual(codec.decode(Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 6, 8, 10)), {
        ok: true,
        result: value,
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

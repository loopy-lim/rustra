import assert from 'node:assert/strict';
import test from 'node:test';
import { generateFrameCodecsCpp, generateFrameCodecsHpp } from './generate.js';
import type { PackageSchema } from './schema.js';

const schema: PackageSchema = {
  packageId: 'bound.names',
  commands: [
    {
      name: 'transform',
      commandId: 417,
      inputType: 'Input',
      outputType: 'Output',
      inputSchema: {
        type: 'object',
        properties: { source: { type: 'string' } },
        required: ['source'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          caption: { type: 'string' },
          entries: { type: 'array', items: { $ref: '#/definitions/Entry' } },
        },
        required: ['caption', 'entries'],
        definitions: {
          Entry: {
            type: 'object',
            properties: { amount: { type: 'integer' }, caption: { type: 'string' } },
            required: ['amount', 'caption'],
          },
        },
      },
    },
    {
      name: 'scalar',
      commandId: 512,
      inputType: 'Input',
      outputType: 'Scalar',
      inputSchema: {
        type: 'object',
        properties: { operand: { type: 'integer' } },
        required: ['operand'],
      },
      outputSchema: {
        type: 'object',
        properties: { answer: { type: 'integer' } },
        required: ['answer'],
      },
    },
    {
      name: 'bytes',
      commandId: 513,
      inputType: 'Bytes',
      outputType: 'BytesOut',
      inputSchema: {
        type: 'object',
        properties: {
          payload: {
            type: 'array',
            items: { type: 'integer', format: 'uint8', minimum: 0, maximum: 255 },
          },
        },
        required: ['payload'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          copied: {
            type: 'array',
            items: { type: 'integer', format: 'uint8', minimum: 0, maximum: 255 },
          },
        },
        required: ['copied'],
      },
    },
  ],
};

test('bound codec retains only its command layout and dispatches by its own identity', () => {
  const hpp = generateFrameCodecsHpp(schema);
  const cpp = generateFrameCodecsCpp(schema);
  assert.ok(hpp.includes('#define RUSTRA_GENERATED_BOUND_CODEC_CONTEXT 1'));
  assert.ok(hpp.includes('struct BoundCodecContext;'));
  assert.ok(hpp.includes('std::shared_ptr<const BoundCodecContext> make_bound_codec_context'));
  assert.match(cpp, /const uint16_t commandId;/);
  assert.match(cpp, /const std::vector<jsi::PropNameID> input;/);
  assert.match(cpp, /const std::vector<jsi::PropNameID> output;/);
  assert.match(cpp, /case 417: return[^\n]+\{"source"\}, \{"caption", "entries", "amount"\}/);
  assert.match(cpp, /case 512: return[^\n]+\{"operand"\}, \{"answer"\}/);
  assert.match(cpp, /switch \(context.commandId\)/);
  assert.match(
    cpp,
    /encode_body_transform\(rt, argsObj, w, context.input\.data\(\)\); return true;/,
  );
  assert.match(cpp, /return decode_body_transform\(rt, resultObj, r, context.output\.data\(\)\);/);
  assert.equal(cpp.match(/static void encode_body_transform\(/g)?.length, 1);
  assert.equal(cpp.match(/static jsi::Value decode_body_transform\(/g)?.length, 1);
  assert.ok(!/NativeState|cachedProp|RuntimePropNameCache|Runtime\s*\*/.test(cpp));
  assert.equal(generateFrameCodecsCpp(schema), cpp);
});

test('raw and buffer bound results use their actual output field layout', () => {
  const cpp = generateFrameCodecsCpp(schema);
  const raw = cpp.slice(cpp.indexOf('Value decode_raw_bound('));
  const buffer = cpp.slice(
    cpp.indexOf('Value decode_buffer_bound('),
    cpp.indexOf('bool has_raw_codec('),
  );
  assert.ok(raw.includes('result.setProperty(rt, context.output[0], static_cast<double>(value))'));
  assert.ok(buffer.includes('result.setProperty(rt, context.output[0], std::move(buffer))'));
  assert.ok(!raw.includes('PropNameID::forAscii'));
  assert.ok(!buffer.includes('PropNameID::forAscii'));
  // Legacy entry points still create one actual result name for each call.
  assert.ok(cpp.includes('jsi::PropNameID::forAscii(rt, "answer")'));
  assert.ok(cpp.includes('jsi::PropNameID::forAscii(rt, "copied")'));
});

test('tuple synthetic names are retained once without command-specific logic', () => {
  const tuples: PackageSchema = {
    packageId: 'bound.tuple',
    commands: [
      {
        name: 'tuple',
        commandId: 71,
        inputType: 'Input',
        outputType: 'Output',
        inputSchema: { type: 'object', properties: {}, required: [] },
        outputSchema: {
          type: 'object',
          properties: {
            pair: {
              type: 'array',
              minItems: 2,
              maxItems: 2,
              items: [{ type: 'string' }, { type: 'integer' }],
            },
          },
          required: ['pair'],
        },
      },
    ],
  };
  const cpp = generateFrameCodecsCpp(tuples);
  assert.match(cpp, /case 71: return[^\n]+\{\}, \{"pair", "value", "_"\}/);
  assert.ok(!cpp.includes('benchEchoPair'));
  assert.ok(!cpp.includes('benchAdd'));
});

test('complex dispatch retains empty layouts and unit raw output stays undefined', () => {
  const extra: PackageSchema = {
    packageId: 'bound.routes',
    commands: [
      {
        name: 'nestedMap',
        commandId: 91,
        inputType: 'NestedInput',
        outputType: 'NestedOutput',
        inputSchema: {
          type: 'object',
          properties: {
            values: {
              type: 'object',
              additionalProperties: { type: 'array', items: { type: 'integer' } },
            },
          },
          required: ['values'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            values: {
              type: 'object',
              additionalProperties: { type: 'array', items: { type: 'integer' } },
            },
          },
          required: ['values'],
        },
      },
      {
        name: 'notify',
        commandId: 92,
        inputType: 'Input',
        outputType: '()',
        inputSchema: {
          type: 'object',
          properties: { token: { type: 'integer' } },
          required: ['token'],
        },
        outputSchema: { type: 'null' },
      },
    ],
  };
  const cpp = generateFrameCodecsCpp(extra);
  assert.match(cpp, /case 91: return[^\n]+BoundCodecContext\(rt, commandId, \{\}, \{\}\)/);
  assert.ok(cpp.includes('case 91: encode_complex_nestedMap(rt, args, w); return true;'));
  assert.ok(cpp.includes('case 91: return decode_complex_nestedMap(rt, r);'));
  assert.match(cpp, /case 92: return[^\n]+\{"token"\}, \{\}/);
  const raw = cpp.slice(cpp.indexOf('Value decode_raw_bound('));
  assert.match(raw, /case 92: \{\s+return Value::undefined\(\);/);
  assert.ok(!raw.includes('context.output['));
});

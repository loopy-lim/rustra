import assert from 'node:assert/strict';
import test from 'node:test';
import { generateTypesTs, generateCommandsTs, generateContractTs } from './generate.js';
import type { PackageSchema } from './schema.js';

const simpleSchema: PackageSchema = {
  packageId: 'test',
  commands: [
    {
      name: 'add',
      inputType: 'AddInput',
      outputType: 'AddOutput',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'integer' }, b: { type: 'integer' } },
        required: ['a', 'b'],
        title: 'AddInput',
      },
      outputSchema: {
        type: 'object',
        properties: { value: { type: 'integer' } },
        required: ['value'],
        title: 'AddOutput',
      },
    },
  ],
};

test('generateTypesTs produces EngineClient and RustraError', () => {
  const types = generateTypesTs(simpleSchema);
  assert.ok(types.includes('export type EngineClient'));
  assert.ok(types.includes('export type RustraError'));
  assert.ok(types.includes('readonly retryable?'));
});

test('generateTypesTs maps tuple types', () => {
  const schema: PackageSchema = {
    packageId: 'test',
    commands: [
      {
        name: 'pair',
        inputType: 'PairInput',
        outputType: 'PairOutput',
        inputSchema: {
          type: 'object',
          properties: { data: { type: 'array', items: [{ type: 'string' }, { type: 'integer' }] } },
          required: ['data'],
          title: 'PairInput',
        },
        outputSchema: { type: 'object', properties: {}, required: [], title: 'PairOutput' },
      },
    ],
  };
  const types = generateTypesTs(schema);
  assert.ok(types.includes('[string, number]'));
});

test('generateTypesTs maps Record types', () => {
  const schema: PackageSchema = {
    packageId: 'test',
    commands: [
      {
        name: 'lookup',
        inputType: 'LookupInput',
        outputType: 'LookupOutput',
        inputSchema: {
          type: 'object',
          properties: { map: { type: 'object', additionalProperties: { type: 'integer' } } },
          required: ['map'],
          title: 'LookupInput',
        },
        outputSchema: { type: 'object', properties: {}, required: [], title: 'LookupOutput' },
      },
    ],
  };
  const types = generateTypesTs(schema);
  assert.ok(types.includes('Record<string, number>'));
});

test('generateCommandsTs produces command function', () => {
  const commands = generateCommandsTs(simpleSchema);
  assert.ok(commands.includes('export function add('));
  assert.ok(commands.includes("engine.invoke<AddOutput>('add'"));
});

test('generateContractTs produces hash constant', () => {
  const contract = generateContractTs('{"test": true}');
  assert.ok(contract.includes('GENERATED_CONTRACT_HASH'));
  assert.ok(contract.includes("'"));
});

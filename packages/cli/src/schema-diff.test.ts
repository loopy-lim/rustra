import assert from 'node:assert/strict';
import test from 'node:test';
import { diffSchemas, formatDiffResult } from './schema-diff.js';
import type { PackageSchema } from './schema.js';

const baseSchema: PackageSchema = {
  packageId: 'test',
  commands: [
    {
      name: 'add',
      commandId: 1,
      inputType: 'AddInput',
      outputType: 'AddOutput',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'integer' }, b: { type: 'integer' } },
        required: ['a', 'b'],
      },
      outputSchema: {
        type: 'object',
        properties: { value: { type: 'integer' } },
        required: ['value'],
      },
    },
  ],
};

test('detects no changes for identical schemas', () => {
  const result = diffSchemas(baseSchema, baseSchema);
  assert.equal(result.breaking.length, 0);
});

test('detects removed command', () => {
  const newSchema: PackageSchema = { packageId: 'test', commands: [] };
  const result = diffSchemas(baseSchema, newSchema);
  assert.equal(result.breaking.length, 1);
  assert.equal(result.breaking[0].type, 'command_removed');
});

test('detects removed field', () => {
  const newSchema: PackageSchema = {
    packageId: 'test',
    commands: [
      {
        name: 'add',
        commandId: 1,
        inputType: 'AddInput',
        outputType: 'AddOutput',
        inputSchema: { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'] },
        outputSchema: {
          type: 'object',
          properties: { value: { type: 'integer' } },
          required: ['value'],
        },
      },
    ],
  };
  const result = diffSchemas(baseSchema, newSchema);
  assert.ok(result.breaking.some((c) => c.type === 'field_removed'));
});

test('detects type change', () => {
  const newSchema: PackageSchema = {
    packageId: 'test',
    commands: [
      {
        name: 'add',
        commandId: 1,
        inputType: 'AddInput',
        outputType: 'AddOutput',
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'string' }, b: { type: 'integer' } },
          required: ['a', 'b'],
        },
        outputSchema: {
          type: 'object',
          properties: { value: { type: 'integer' } },
          required: ['value'],
        },
      },
    ],
  };
  const result = diffSchemas(baseSchema, newSchema);
  assert.ok(result.breaking.some((c) => c.type === 'field_type_changed'));
});

test('detects required field added', () => {
  const newSchema: PackageSchema = {
    packageId: 'test',
    commands: [
      {
        name: 'add',
        commandId: 1,
        inputType: 'AddInput',
        outputType: 'AddOutput',
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'integer' }, b: { type: 'integer' }, c: { type: 'integer' } },
          required: ['a', 'b', 'c'],
        },
        outputSchema: {
          type: 'object',
          properties: { value: { type: 'integer' } },
          required: ['value'],
        },
      },
    ],
  };
  const result = diffSchemas(baseSchema, newSchema);
  assert.ok(result.breaking.some((c) => c.type === 'required_field_added'));
});

test('detects an existing optional field becoming required', () => {
  const oldSchema = structuredClone(baseSchema) as PackageSchema;
  const next = structuredClone(baseSchema) as PackageSchema;
  oldSchema.commands[0].inputSchema.required = ['a'];
  next.commands[0].inputSchema.required = ['a', 'b'];
  const result = diffSchemas(oldSchema, next);
  assert.ok(result.breaking.some((change) => change.type === 'field_became_required'));
});

test('detects nested referenced schema changes', () => {
  const oldSchema = structuredClone(baseSchema) as PackageSchema;
  const nextSchema = structuredClone(baseSchema) as PackageSchema;
  oldSchema.commands[0].inputSchema = {
    type: 'object',
    properties: { payload: { $ref: '#/definitions/Payload' } },
    required: ['payload'],
    definitions: {
      Payload: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  };
  nextSchema.commands[0].inputSchema = {
    type: 'object',
    properties: { payload: { $ref: '#/definitions/Payload' } },
    required: ['payload'],
    definitions: {
      Payload: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    },
  };
  const result = diffSchemas(oldSchema, nextSchema);
  assert.ok(result.breaking.some((change) => change.type === 'field_type_changed'));
});

test('resolves command-level nested refs instead of treating them as opaque', () => {
  const oldSchema = structuredClone(baseSchema) as PackageSchema;
  const nextSchema = structuredClone(baseSchema) as PackageSchema;
  oldSchema.commands[0].inputSchema = {
    type: 'object',
    properties: { payload: { $ref: '#/$defs/Payload' } },
    required: ['payload'],
  };
  nextSchema.commands[0].inputSchema = structuredClone(oldSchema.commands[0].inputSchema);
  oldSchema.commands[0].definitions = {
    Payload: {
      type: 'object',
      properties: { child: { $ref: '#/$defs/Child' } },
      required: ['child'],
    },
    Child: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  };
  nextSchema.commands[0].definitions = {
    Payload: {
      type: 'object',
      properties: { child: { $ref: '#/$defs/Child' } },
      required: ['child'],
    },
    Child: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  };
  const result = diffSchemas(oldSchema, nextSchema);
  assert.ok(result.breaking.some((change) => change.type === 'field_type_changed'));
});

test('formatDiffResult shows breaking changes', () => {
  const newSchema: PackageSchema = { packageId: 'test', commands: [] };
  const result = diffSchemas(baseSchema, newSchema);
  const formatted = formatDiffResult(result);
  assert.ok(formatted.includes('Breaking changes'));
  assert.ok(formatted.includes('Command removed'));
});

test('formatDiffResult shows no breaking for clean diff', () => {
  const result = diffSchemas(baseSchema, baseSchema);
  const formatted = formatDiffResult(result);
  assert.ok(formatted.includes('No breaking changes'));
});

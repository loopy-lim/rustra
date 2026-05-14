import assert from 'node:assert/strict';
import test from 'node:test';
import { diffSchemas, formatDiffResult } from './schema-diff.js';
import type { PackageSchema } from './schema.js';

const baseSchema: PackageSchema = {
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
        inputType: 'AddInput',
        outputType: 'AddOutput',
        inputSchema: { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'] },
        outputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] },
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
        inputType: 'AddInput',
        outputType: 'AddOutput',
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'string' }, b: { type: 'integer' } },
          required: ['a', 'b'],
        },
        outputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] },
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
        inputType: 'AddInput',
        outputType: 'AddOutput',
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'integer' }, b: { type: 'integer' }, c: { type: 'integer' } },
          required: ['a', 'b', 'c'],
        },
        outputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] },
      },
    ],
  };
  const result = diffSchemas(baseSchema, newSchema);
  assert.ok(result.breaking.some((c) => c.type === 'required_field_added'));
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

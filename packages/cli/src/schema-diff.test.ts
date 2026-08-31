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

test('formatDiffResult rendering is byte-identical when no diagnoses exist', () => {
  // 진단이 없는 기존 출력은 정확히 동일해야 한다 (no-regression pin).
  const removed = diffSchemas(baseSchema, { packageId: 'test', commands: [] });
  assert.equal(formatDiffResult(removed), 'Breaking changes (1):\n  - Command removed: add');
  const clean = diffSchemas(baseSchema, baseSchema);
  assert.equal(formatDiffResult(clean), 'No breaking changes detected.');
});

test('diagnoses command id displacement: same name, changed id', () => {
  const oldSchema = structuredClone(baseSchema) as PackageSchema;
  const nextSchema = structuredClone(baseSchema) as PackageSchema;
  // 새 명령이 앞에 삽입돼 add 의 id 가 1 → 2 로 밀렸다 (OTA 스키마 성장 시나리오).
  nextSchema.commands.unshift({
    name: 'ping',
    commandId: 3,
    inputType: 'PingInput',
    outputType: 'PingOutput',
    inputSchema: { type: 'object', properties: {}, required: [] },
    outputSchema: { type: 'object', properties: {}, required: [] },
  });
  nextSchema.commands[1].commandId = 2;
  const result = diffSchemas(oldSchema, nextSchema);
  assert.ok(result.breaking.some((c) => c.type === 'command_id_changed'));
  const diagnosis = result.diagnoses?.find((d) => d.code === 'command_id_displaced');
  assert.ok(diagnosis, 'id displacement must produce a diagnosis');
  assert.equal(diagnosis.command, 'add');
  assert.equal(diagnosis.oldId, 1);
  assert.equal(diagnosis.newId, 2);
  const formatted = formatDiffResult(result);
  assert.ok(
    formatted.includes("command 'add' kept its name but its command id changed from 1 to 2"),
    `formatted output must name the cause, got:\n${formatted}`,
  );
  assert.ok(
    formatted.includes("old clients dispatching by the old id will no longer reach 'add'"),
    `formatted output must state the wire consequence, got:\n${formatted}`,
  );
});

test('diagnoses missing alias: old id is consumed by a different command', () => {
  const oldSchema = structuredClone(baseSchema) as PackageSchema;
  const nextSchema = structuredClone(baseSchema) as PackageSchema;
  // 신규 명령이 구 id 1 을 점유하고 add 는 fresh id 로 밀렸다 — 네이티브에
  // alias_command_id("add", 1) 선언이 없으면 구 클라이언트의 id 1 호출이
  // ping 으로 라우팅된다.
  nextSchema.commands[0].commandId = 2;
  nextSchema.commands.unshift({
    name: 'ping',
    commandId: 1,
    inputType: 'PingInput',
    outputType: 'PingOutput',
    inputSchema: { type: 'object', properties: {}, required: [] },
    outputSchema: { type: 'object', properties: {}, required: [] },
  });
  const result = diffSchemas(oldSchema, nextSchema);
  assert.ok(result.breaking.some((c) => c.type === 'command_id_changed'));
  const diagnosis = result.diagnoses?.find((d) => d.code === 'alias_missing');
  assert.ok(diagnosis, 'consumed legacy id must produce an alias diagnosis');
  assert.equal(diagnosis.command, 'add');
  const formatted = formatDiffResult(result);
  assert.ok(
    formatted.includes(
      "legacy command id 1 (used by 'add' in the old schema) now dispatches 'ping'",
    ),
    `formatted output must name the consumed id and its new target, got:\n${formatted}`,
  );
  assert.ok(
    formatted.includes('declare alias_command_id("add", 1) on the native side'),
    `formatted output must name the fix, got:\n${formatted}`,
  );
});

test('diagnoses wire-incompatible type change with cause sentence', () => {
  const oldSchema = structuredClone(baseSchema) as PackageSchema;
  const nextSchema = structuredClone(baseSchema) as PackageSchema;
  oldSchema.commands[0].inputSchema = {
    type: 'object',
    properties: { a: { type: 'integer' }, b: { type: 'integer' } },
    required: ['a', 'b'],
  };
  nextSchema.commands[0].inputSchema = {
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'integer' } },
    required: ['a', 'b'],
  };
  const result = diffSchemas(oldSchema, nextSchema);
  const diagnosis = result.diagnoses?.find((d) => d.code === 'wire_type_changed');
  assert.ok(diagnosis, 'wire-incompatible type change must produce a diagnosis');
  assert.equal(diagnosis.command, 'add.input.a');
  assert.equal(diagnosis.field, 'a');
  const formatted = formatDiffResult(result);
  assert.ok(
    formatted.includes("'add.input.a' changed from integer to string"),
    `formatted output must name the field and both types, got:\n${formatted}`,
  );
  assert.ok(
    formatted.includes('the postcard wire encoding changes shape'),
    `formatted output must explain the wire consequence, got:\n${formatted}`,
  );
});

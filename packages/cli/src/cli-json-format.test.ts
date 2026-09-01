// codegen/diff --format json 표면 (doctor formatDoctorJson 패턴 준거).
//
// CI 통합 표면 통일 — doctor 의 { schemaVersion: 1, ... } 관례를 codegen/diff 가
// 따른다. 포매터는 순수 함수로 직접 호출해 검증하고(formatDoctorJson 패턴),
// 러너(runCodegen/runDiff)는 포매터 출력을 stdout 에 실어 exit 코드 계약
// (diff 의 breaking → exit 1)은 그대로 유지한다.
//
// diff 의 breaking 배열은 Task 3의 이벤트 게이트(event_removed /
// event_payload_changed fold)와 정합해야 한다 — fold된 SchemaLevelFinding 구조를
// 그대로 실어야 하므로 fold 결과를 고정하는 회귀 게이트가 이 파일에 있다.

import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCodegenJson, formatDiffJson } from './cli-json-format.js';
import { diffSchemas, type BreakingChange } from './schema-diff.js';
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
        properties: { a: { type: 'integer' } },
        required: ['a'],
      },
      outputSchema: { type: 'object', properties: {}, required: [] },
    },
  ],
};

function eventSchema(events: PackageSchema['events']): PackageSchema {
  return { ...structuredClone(baseSchema), events };
}

// ── codegen ─────────────────────────────────────────────────────────────────

test('formatCodegenJson renders the schemaVersion:1 report shape', () => {
  const json = JSON.parse(
    formatCodegenJson({ written: ['generated/types.ts'], drift: false, durationMs: 12 }),
  );
  assert.deepEqual(json, {
    schemaVersion: 1,
    written: ['generated/types.ts'],
    drift: false,
    durationMs: 12,
  });
});

test('formatCodegenJson reports drift when check mode detected stale files', () => {
  const json = JSON.parse(
    formatCodegenJson({ written: ['generated/types.ts (verified)'], drift: true, durationMs: 3 }),
  );
  assert.equal(json.schemaVersion, 1);
  assert.equal(json.drift, true);
  assert.equal(json.written.length, 1);
  assert.equal(json.durationMs, 3);
});

// ── diff ────────────────────────────────────────────────────────────────────

test('formatDiffJson renders the schemaVersion:1 report shape for a clean diff', () => {
  const result = diffSchemas(baseSchema, structuredClone(baseSchema));
  const json = JSON.parse(formatDiffJson(result));
  assert.deepEqual(json, {
    schemaVersion: 1,
    breaking: [],
    clean: true,
  });
});

test('formatDiffJson carries breaking changes verbatim with a clean:false flag', () => {
  const next = structuredClone(baseSchema);
  next.commands[0].inputSchema = {
    type: 'object',
    properties: { a: { type: 'string' } },
    required: ['a'],
  };
  const json = JSON.parse(formatDiffJson(diffSchemas(baseSchema, next)));
  assert.equal(json.schemaVersion, 1);
  assert.equal(json.clean, false);
  assert.equal(json.breaking.length, 1);
  assert.equal(json.breaking[0].type, 'field_type_changed');
  assert.equal(json.breaking[0].command, 'add.input.a');
  assert.equal(json.breaking[0].from, 'integer');
  assert.equal(json.breaking[0].to, 'string');
});

// Task 3 정합 게이트 — 이벤트 계약은 fold된 event_payload_changed 구조 그대로
// JSON 에 실린다(명령 필드 진단으로 되접히지 않는다).
test('formatDiffJson carries eventRemoved and folded payload findings verbatim', () => {
  const oldSchema = eventSchema([
    { name: 'progress.tick', payload: { type: 'object', properties: { pct: { type: 'number' } } } },
  ]);
  const nextSchema = eventSchema([
    { name: 'progress.tick', payload: { type: 'object', properties: { pct: { type: 'string' } } } },
  ]);
  const result = diffSchemas(oldSchema, nextSchema);
  const json = JSON.parse(formatDiffJson(result));
  assert.equal(json.clean, false);
  const payload = json.breaking.find(
    (change: BreakingChange) => change.type === 'event_payload_changed',
  );
  assert.ok(payload, 'folded payload finding must survive JSON rendering');
  assert.equal(payload.event, 'progress.tick');
  assert.equal(payload.path, 'events.progress.tick.payload.pct');
  assert.equal(payload.before, 'number');
  assert.equal(payload.after, 'string');

  const removed = JSON.parse(
    formatDiffJson(
      diffSchemas(
        eventSchema([{ name: 'job.done', payload: { type: 'object' } }]),
        eventSchema([]),
      ),
    ),
  );
  const removedChange = removed.breaking.find(
    (change: BreakingChange) => change.type === 'event_removed',
  );
  assert.ok(removedChange, 'event_removed must survive JSON rendering');
  assert.equal(removedChange.event, 'job.done');
  assert.equal(removed.clean, false);
});

test('formatDiffJson never leaks diagnoses into the schemaVersion:1 shape', () => {
  // 계약 — JSON 표면은 breaking/clean 만 운반한다(diagnoses 는 텍스트 렌더러
  // 전용). shape 드리프트를 이 테스트가 고정한다.
  const next = structuredClone(baseSchema);
  next.commands[0].inputSchema = {
    type: 'object',
    properties: { a: { type: 'string' } },
    required: ['a'],
  };
  const json = JSON.parse(formatDiffJson(diffSchemas(baseSchema, next)));
  assert.deepEqual(Object.keys(json).sort(), ['breaking', 'clean', 'schemaVersion']);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { configure } from '@rustra/types';
import { startJob, jobStatus } from '../generated/commands.js';
import type { EngineClient } from '../generated/types.js';

function mockEngine(responses: Map<string, unknown>): EngineClient {
  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      const response = responses.get(command);
      if (response === undefined) throw new Error(`unexpected command: ${command}`);
      return response as T;
    },
  };
}

test('startJob returns accepted with typed input', async () => {
  const responses = new Map([['startJob', { accepted: true }]]);
  configure(mockEngine(responses));
  const result = await startJob({ jobId: 'job-1', totalSteps: 5, stepDelayMs: 10 });
  assert.equal(result.accepted, true);
});

test('jobStatus reports pending event counts', async () => {
  const responses = new Map([['jobStatus', { pendingEvents: 3, droppedEvents: 0 }]]);
  configure(mockEngine(responses));
  const result = await jobStatus({ jobId: 'job-1' });
  assert.equal(result.pendingEvents, 3);
  assert.equal(result.droppedEvents, 0);
});

test('generated types map streaming inputs correctly', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  // 컴파일 위치(dist-ts/...)에서 소스 트리의 generated/types.ts 로 —
  // dist-ts 루트에서 2단계 상위가 repo 루트다.
  const here = fileURLToPath(new URL('.', import.meta.url));
  const srcDir = `${here.split('/dist-ts/')[0]}/examples/streaming/generated/`;
  const types = await readFile(`${srcDir}/types.ts`, 'utf8');
  assert.ok(types.includes('export type StartJobInput = {'));
  assert.ok(types.includes('totalSteps: number;'));
  assert.ok(types.includes('export type JobStatusOutput = {'));
});

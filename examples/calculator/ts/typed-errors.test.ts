import assert from 'node:assert/strict';
import test from 'node:test';
import { configure, RustraCommandError } from '@rustra/types';
import { divide } from '../generated/commands.js';
import {
  DivideErrorCode,
  isDivideError,
  isResourceReadError,
  ResourceReadErrorCode,
} from '../generated/errors.js';

/** 선언된 코드로 거부하는 목 엔진 — 와이어 에러 프레임과 동일한 표면. */
function rejectingEngine(code: string, message: string): Parameters<typeof configure>[0] {
  return {
    async invoke(): Promise<never> {
      throw new RustraCommandError(code, message);
    },
  };
}

test('isDivideError narrows a declared domain error code', async () => {
  configure(rejectingEngine('math.divide_by_zero', 'cannot divide by zero'));

  await assert.rejects(
    () => divide({ a: 10, b: 0 }),
    (error: unknown) => {
      if (!isDivideError(error)) return false;
      // 가드 통과 후 code 는 리터럴 유니언으로 좁혀진다 — 오타는 컴파일 타임에 잡힌다.
      assert.equal(error.code, DivideErrorCode.MathDivideByZero);
      assert.equal(error.code, 'math.divide_by_zero');
      return true;
    },
  );
});

test('isDivideError rejects undeclared codes — the runtime contract stays open', async () => {
  configure(rejectingEngine('math.future_code', 'declared after this JS was generated'));

  await assert.rejects(
    () => divide({ a: 1, b: 1 }),
    (error: unknown) => {
      assert.equal(isDivideError(error), false);
      // 미선언 코드 폴백 — 기존 문자열 분기 패턴이 그대로 동작한다.
      assert.ok(error instanceof RustraCommandError && error.code === 'math.future_code');
      return true;
    },
  );
});

test('isDivideError rejects non-RustraCommandError values', () => {
  assert.equal(isDivideError(new Error('plain')), false);
  assert.equal(isDivideError('math.divide_by_zero'), false);
  assert.equal(isDivideError(null), false);
});

test('resource guards cover the declared resource.not_found code', async () => {
  configure(rejectingEngine('resource.not_found', 'unknown or closed handle'));

  await assert.rejects(
    () => import('../generated/commands.js').then((m) => m.resourceRead({ handle: 999, key: 'k' })),
    (error: unknown) => {
      if (!isResourceReadError(error)) return false;
      assert.equal(error.code, ResourceReadErrorCode.ResourceNotFound);
      return true;
    },
  );
});

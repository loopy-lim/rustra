import { expect, test } from 'bun:test';
import { validateProfileWindow } from './profile-window';

const active = '2026-09-16T14:07:17.414Z';
const complete = { activeAt: active, finishedAt: '2026-09-16T14:07:32.418Z' };
const start = '2026-09-16T14:07:17.468Z';
const end = '2026-09-16T14:07:30.155Z';

test('accepts the completed pilot window', () => {
  expect(() => validateProfileWindow(complete, active, start, end)).not.toThrow();
});
test('rejects missing and invalid timestamps instead of accepting NaN comparisons', () => {
  for (const value of [undefined, '', 'invalid']) {
    expect(() =>
      validateProfileWindow({ ...complete, activeAt: value }, active, start, end),
    ).toThrow();
    expect(() =>
      validateProfileWindow({ ...complete, finishedAt: value }, active, start, end),
    ).toThrow();
  }
});
test('requires the completion to match the observed active phase', () => {
  expect(() => validateProfileWindow(complete, '2026-09-16T14:07:16.000Z', start, end)).toThrow();
});
test('rejects capture before, after, reversed or empty within the workload', () => {
  expect(() => validateProfileWindow(complete, active, '2026-09-16T14:07:17.000Z', end)).toThrow();
  expect(() =>
    validateProfileWindow(complete, active, start, '2026-09-16T14:07:33.000Z'),
  ).toThrow();
  expect(() => validateProfileWindow(complete, active, end, start)).toThrow();
  expect(() => validateProfileWindow(complete, active, start, start)).toThrow();
});

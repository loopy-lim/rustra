import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDevArgs, planPipeline } from './dev.js';

test('parseDevArgs parses backend dir and app dir', () => {
  const opts = parseDevArgs(['--backend', './backend', '--app', './app']);
  assert.equal(opts.backendDir, './backend');
  assert.equal(opts.appDir, './app');
});

test('parseDevArgs defaults to conventional layout', () => {
  const opts = parseDevArgs([]);
  assert.equal(opts.backendDir, 'backend');
  assert.equal(opts.appDir, 'app');
});

test('planPipeline reports which stages are dirty after a rust-only change', () => {
  // rust 소스가 schema.json 보다 새면: rust_codegen 필요 → schema 변경 → ts_codegen 필요
  const plan = planPipeline({
    rustNewerThanSchema: true,
    codecsStaleAgainstSchema: false,
  });
  assert.equal(plan.rustBin, true);
  assert.equal(plan.tsCli, true);
});

test('planPipeline skips rust bin when only codecs are stale', () => {
  const plan = planPipeline({ rustNewerThanSchema: false, codecsStaleAgainstSchema: true });
  assert.equal(plan.rustBin, false);
  assert.equal(plan.tsCli, true);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  judgeContractMismatch,
  judgeDoctorSdkMissing,
  judgeInvalidPayload,
  judgeNativeMissing,
  judgeStaleGeneratedCheck,
} from './registry-consumer-diagnostics.mjs';

test('stale-generated judge requires loud drift rejection with identification', () => {
  const pass = judgeStaleGeneratedCheck({
    status: 1,
    stdout: 'src/generated/types.ts is stale (schema changed); re-run codegen',
    stderr: '',
  });
  assert.equal(pass.rejected, true);
  assert.equal(pass.identifiesDrift, true);
  const silent = judgeStaleGeneratedCheck({ status: 0, stdout: 'all verified', stderr: '' });
  assert.equal(silent.rejected, false);
});

test('contract-mismatch judge rejects silent success and requires contract wording', () => {
  const pass = judgeContractMismatch({
    status: 1,
    stdout: 'Error: contract.mismatch: generated client hash a1 != runtime b2',
    stderr: '',
  });
  assert.equal(pass.failedLoudly, true);
  assert.equal(pass.mentionsContract, true);
  assert.equal(pass.noSilentSuccess, true);
  const silent = judgeContractMismatch({
    status: 0,
    stdout: '__RUSTRA_DIAG_RESULT__{"rejected":false,"value":{"message":"registry-node-result"}}',
    stderr: '',
  });
  assert.equal(silent.noSilentSuccess, false);
});

test('native-missing judge accepts marker-reported guidance and rejects quiet success', () => {
  const binary = '/tmp/does-not-exist/rustra-app';
  // 프로브 경로 — rejected 결과가 마커로 보고되고 안내를 담는다.
  const marker = judgeNativeMissing({
    status: 0,
    stdout: `__RUSTRA_DIAG_RESULT__{"rejected":true,"code":"contract.unenforceable","message":"Tried 1 runtime candidate (newest first): ${binary} — rebuild the Rust host"}`,
    stderr: '',
    binary,
  });
  assert.equal(marker.failedLoudly, true);
  assert.equal(marker.mentionsTarget, true);
  assert.equal(marker.actionable, true);
  // 프로세스 경로 — stderr 안내.
  const processFailure = judgeNativeMissing({
    status: 1,
    stdout: '',
    stderr: `failed to start ${binary}: ENOENT — check RUSTRA_NODE_BINARY and build first`,
    binary,
  });
  assert.equal(processFailure.actionable, true);
  // 조용한 성공은 실패.
  assert.equal(
    judgeNativeMissing({
      status: 0,
      stdout: `__RUSTRA_DIAG_RESULT__{"rejected":false,"value":{"message":"diag"}}`,
      stderr: '',
      binary,
    }).failedLoudly,
    false,
  );
  assert.equal(
    judgeNativeMissing({ status: 1, stdout: '', stderr: 'some unrelated crash', binary }).mentionsTarget,
    false,
  );
});

test('doctor-sdk-missing judge requires structured fail checks with fix arrays', () => {
  const report = {
    checks: [
      { id: 'rustc.present', status: 'fail', detail: 'rustc is unavailable', fix: ['Install Rust with https://rustup.rs'] },
      { id: 'cargo.present', status: 'fail', detail: 'cargo is unavailable', fix: ['Install Cargo with https://rustup.rs'] },
      { id: 'js.runtime', status: 'pass', detail: 'Node.js is available', fix: [] },
    ],
  };
  const pass = judgeDoctorSdkMissing({ status: 1, stdout: JSON.stringify(report) });
  assert.equal(pass.parsed, true);
  assert.equal(pass.allConditionsMet, true);
  const noFix = judgeDoctorSdkMissing({
    status: 1,
    stdout: JSON.stringify({
      checks: [
        { id: 'rustc.present', status: 'fail', fix: [] },
        { id: 'cargo.present', status: 'fail', fix: [] },
      ],
    }),
  });
  assert.equal(noFix.allConditionsMet, false);
  const unparsed = judgeDoctorSdkMissing({ status: 1, stdout: 'not json' });
  assert.equal(unparsed.parsed, false);
});

test('invalid-payload judge verifies wire cleanliness of the input whitelist', () => {
  const clean = judgeInvalidPayload({
    stdout: '__RUSTRA_DIAG_RESULT__{"rejected":false,"value":{"message":"diag"}}',
  });
  assert.equal(clean.reported, true);
  assert.equal(clean.wireStaysClean, true);
  assert.equal(clean.loudlyRejected, false);
  // 결과가 선언된 필드 외 키를 실으면 와이어가 오염된 것이다.
  const dirty = judgeInvalidPayload({
    stdout: '__RUSTRA_DIAG_RESULT__{"rejected":false,"value":{"message":"diag","surpriseField":true}}',
  });
  assert.equal(dirty.wireStaysClean, false);
  // 서버가 invalid_args 로 거부해도 유효한 대안 관측으로 인정한다.
  const rejected = judgeInvalidPayload({
    stdout: '__RUSTRA_DIAG_RESULT__{"rejected":true,"code":"command.invalid_args"}',
  });
  assert.equal(rejected.loudlyRejected, true);
  assert.equal(judgeInvalidPayload({ stdout: 'nothing' }).reported, false);
});

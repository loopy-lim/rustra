// 계약 검증 기반 cdylib 후보 선택(감사 A1) — stale release 함정의 Bun 측.
//
// release→debug 순 "첫 존재 후보" 채택은 target/release 에 오래된 cdylib 이 남으면
// 방금 debug 빌드한 사용자를 contract.mismatch 로 죽인다(Node 측 재현과 동일).
// 여기서는 (1) bunLibraryCandidates 의 mtime 최신 우선 정렬과 (2) 선택 루프
// selectVerifiedLibrary 의 기각/폴백/최종 보고 계약을 dlopen 없이 주입
// attempt 로 검증한다. 실 dylib 종단(최종 보고 메시지)은 마지막 통합 테스트가
// 담당한다 — 저장소 target 의 calculator cdylib 을 그대로 쓴다(index.test.ts 관례).

import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suffix } from 'bun:ffi';
import { RustraCommandError } from '@rustra/types';
import { bunLibraryCandidates, selectVerifiedLibrary } from './bun-ffi-library.js';
import { createBunFfiEngine } from './bun-ffi.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** cdylib 후보 2개 픽스처 — 첫 후보가 stale release(오래된 mtime), 둘째가 최신 debug. */
function seedStaleReleaseFixture(prefix: string): { root: string; stale: string; fresh: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const stale = join(root, 'release', `libfixture_app.${suffix}`);
  const fresh = join(root, 'debug', `libfixture_app.${suffix}`);
  mkdirSync(join(root, 'release'), { recursive: true });
  mkdirSync(join(root, 'debug'), { recursive: true });
  writeFileSync(stale, 'stale release artifact');
  writeFileSync(fresh, 'fresh debug artifact');
  const older = new Date(Date.now() - 60_000);
  utimesSync(stale, older, older);
  return { root, stale, fresh };
}

test('bunLibraryCandidates orders existing candidates newest-build-first', () => {
  const { root, stale, fresh } = seedStaleReleaseFixture('rustra-bun-candidates-');
  const previous = process.env.RUSTRA_BUN_LIBRARY;
  delete process.env.RUSTRA_BUN_LIBRARY;
  try {
    // 최신 빌드(debug) 우선 + 부재 후보 제거 — stale release 가 첫 존재 후보로
    // 잡히는 함정이 후보 열거 단계에서부터 해소된다.
    assert.deepEqual(
      bunLibraryCandidates({
        libraryCandidates: [stale, fresh, join(root, 'missing.dylib')],
      }),
      [fresh, stale],
    );
    // 명시 지정은 존재 검사·정렬 없이 단일 후보.
    assert.deepEqual(bunLibraryCandidates({ library: './anywhere.dylib' }), ['./anywhere.dylib']);
    process.env.RUSTRA_BUN_LIBRARY = fresh;
    assert.deepEqual(bunLibraryCandidates({}), [fresh]);
  } finally {
    if (previous === undefined) delete process.env.RUSTRA_BUN_LIBRARY;
    else process.env.RUSTRA_BUN_LIBRARY = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('selectVerifiedLibrary falls back past a contract-mismatched candidate', async () => {
  const { root, stale, fresh } = seedStaleReleaseFixture('rustra-bun-select-');
  try {
    const attempts: string[] = [];
    const selection = await selectVerifiedLibrary([stale, fresh], async (candidate) => {
      attempts.push(candidate);
      if (candidate === stale)
        throw new RustraCommandError('contract.mismatch', 'contract hash mismatch: stale');
      return `engine@${candidate}`;
    });
    assert.ok('runtime' in selection, 'fresh 후보에서 성공해야 한다');
    assert.equal((selection as { runtime: string }).runtime, `engine@${fresh}`);
    assert.equal((selection as { library: string }).library, fresh);
    assert.deepEqual(attempts, [stale, fresh], 'stale 기각 후 다음 후보를 시도한다');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('selectVerifiedLibrary records probe failures and keeps scanning', async () => {
  // dlopen/rustra_mobile_init 실패(plain Error)는 후보 기각 — 기존 ABI probe
  // 건너뛰기와 동일하게 다음 후보로 진행한다.
  const { root, stale, fresh } = seedStaleReleaseFixture('rustra-bun-probe-');
  try {
    const attempts: string[] = [];
    const selection = await selectVerifiedLibrary([stale, fresh], async (candidate) => {
      attempts.push(candidate);
      if (candidate === stale) throw new Error('dlopen failed: invalid header');
      return `engine@${candidate}`;
    });
    assert.ok('runtime' in selection);
    assert.deepEqual(attempts, [stale, fresh]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('selectVerifiedLibrary rethrows non-contract engine failures without fallback', async () => {
  const { root, stale, fresh } = seedStaleReleaseFixture('rustra-bun-fatal-');
  try {
    const attempts: string[] = [];
    await assert.rejects(
      selectVerifiedLibrary([stale, fresh], async (candidate) => {
        attempts.push(candidate);
        throw new RustraCommandError('invoke.failed', 'codec registry broken');
      }),
      (error: unknown) => {
        assert.ok(error instanceof RustraCommandError);
        assert.equal(error.code, 'invoke.failed');
        return true;
      },
    );
    assert.deepEqual(attempts, [stale], '폴백은 계약 기각에만 — 그 외 실패는 즉시 전파');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('selectVerifiedLibrary reports all candidate paths with mtime when every library is stale', async () => {
  const { root, stale, fresh } = seedStaleReleaseFixture('rustra-bun-allstale-');
  try {
    await assert.rejects(
      selectVerifiedLibrary([stale, fresh], async () => {
        throw new RustraCommandError('contract.mismatch', 'contract hash mismatch: stale');
      }),
      (error: unknown) => {
        if (!(error instanceof RustraCommandError)) return false;
        assert.equal(error.code, 'contract.mismatch');
        assert.match(error.message, /Tried 2 cdylib candidates \(newest first\)/);
        assert.ok(error.message.includes(stale), `보고에 stale 경로 포함: ${error.message}`);
        assert.ok(error.message.includes(fresh), `보고에 fresh 경로 포함: ${error.message}`);
        assert.match(error.message, /\(modified [^)]+\): contract\.mismatch/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('selectVerifiedLibrary surfaces probe-only failures for the TransportUnavailable path', async () => {
  const { root, stale, fresh } = seedStaleReleaseFixture('rustra-bun-probeonly-');
  try {
    const selection = await selectVerifiedLibrary([stale, fresh], async (candidate) => {
      throw new Error(`dlopen failed at ${candidate}`);
    });
    assert.ok(!('runtime' in selection));
    assert.deepEqual(
      (selection as { probeFailures: string[] }).probeFailures.map((entry) => entry.split(': ')[0]),
      [stale, fresh],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 실 dylib 종단 — 최종 실패 보고가 실제 경로·mtime 을 나열한다 ────────────

test('createBunFfiEngine reports all attempted cdylib paths when the contract matches none', async () => {
  const release = resolve(repoRoot, `target/release/librustra_calculator_example.${suffix}`);
  const debug = resolve(repoRoot, `target/debug/librustra_calculator_example.${suffix}`);
  if (!existsSync(release) || !existsSync(debug)) return; // 빌드되지 않은 트리 — 스킵
  const runtime = createBunFfiEngine({
    libraryCandidates: [release, debug],
    rkyvV2Codecs: new Map(),
    contractHash: '0'.repeat(64),
  });
  await assert.rejects(runtime, (error: unknown) => {
    if (!(error instanceof RustraCommandError)) return false;
    assert.equal(error.code, 'contract.mismatch');
    // A1 — 어느 후보를 시도했는지 경로+mtime 으로 보고한다.
    assert.match(error.message, /Tried 2 cdylib candidates \(newest first\)/);
    assert.ok(error.message.includes(release));
    assert.ok(error.message.includes(debug));
    // 공유 mismatch 문구(rkyv-engine-contract)의 fix 안내가 그대로 살아있다.
    assert.match(error.message, /regenerate the TypeScript and native codecs/);
    return true;
  });
});

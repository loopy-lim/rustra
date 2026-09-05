import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { describeCargoMetadataError, readCargoMetadata } from './cargo-metadata.js';

// ── cargo 부재 ENOENT 힌트 (감사 #9 후반) ─────────────────────────────────────
//
// codegen/dev 가 readCargoMetadata 로 곧장 들어오는 경로에서 cargo 가 PATH 에
// 없으면 원문 ENOENT 메시지("spawnSync cargo ENOENT")만 보여서 다음 행동을
// 알 수 없다 — rustup 설치 안내를 덧붙여 한 번에 수정 행동으로 연결한다.

test('describeCargoMetadataError appends the rustup hint only for missing cargo binary', () => {
  const enoent = Object.assign(new Error('spawnSync cargo ENOENT'), {
    code: 'ENOENT',
    path: 'cargo',
  }) as NodeJS.ErrnoException;
  const message = describeCargoMetadataError('/tmp/app/Cargo.toml', enoent);
  assert.match(message, /Could not inspect \/tmp\/app\/Cargo\.toml with cargo metadata/);
  assert.match(message, /cargo was not found on PATH/);
  assert.match(message, /https:\/\/rustup\.rs/);
});

test('describeCargoMetadataError keeps other failures hint-free', () => {
  // fs ENOENT(매니페스트 없음)는 cargo 부재가 아니므로 힌트가 붙으면 오안내다.
  const fsError = Object.assign(new Error("ENOENT: no such file '/x/Cargo.toml'"), {
    code: 'ENOENT',
    path: '/x/Cargo.toml',
    syscall: 'realpathSync',
  }) as NodeJS.ErrnoException;
  const fsMessage = describeCargoMetadataError('/x/Cargo.toml', fsError);
  assert.doesNotMatch(fsMessage, /rustup\.rs/);

  // cargo 가 있지만 매니페스트가 깨진 경우 등 — 원인 문맥은 그대로 남는다.
  const broken = new Error('cargo metadata failed: parse error');
  assert.doesNotMatch(describeCargoMetadataError('/x/Cargo.toml', broken), /rustup\.rs/);
  assert.match(describeCargoMetadataError('/x/Cargo.toml', broken), /parse error/);
});

test('readCargoMetadata surfaces the rustup hint when cargo is missing from PATH', () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-cargo-metadata-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "app"\n');
  try {
    // PATH 를 비워 cargo 해석을 확실히 실패시킨다 — execFileSync 의 lookup 이
    // 실제로 실패하는 실제 ENOENT 다(모킹 없음). 캐시는 realpath 키라 여기 영향 없다.
    const previousPath = process.env.PATH;
    process.env.PATH = '';
    try {
      assert.throws(
        () => readCargoMetadata(join(root, 'Cargo.toml')),
        /cargo was not found on PATH[\s\S]*rustup\.rs/,
      );
    } finally {
      process.env.PATH = previousPath;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

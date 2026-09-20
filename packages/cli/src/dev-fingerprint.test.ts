import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rustInputFingerprint } from './dev-fingerprint.js';

// ── rustInputFingerprint — 코드젠 대상 Rust 입력 지문 (warm-loop Stage 1) ────
//
// 지문 계약: 같은 트리는 같은 지문(결정적), 내용이 바뀌면 반드시 다른 지문,
// mtime 만의 변화는 지문을 움직이지 않는다(build 도구의 재쓰기 오탐 방지),
// 감시자와 같은 제외 규칙(target/node_modules/.git), 불확실한 fs 상태는
// 삼키지 않고 throw(호출자가 전체 파이프라인 fail-safe 로 번역).

/** 오염 시나리오의 원본 — derive·attribute·필드를 모두 가진 모양. */
const LIB_RS_V1 = [
  '#[derive(Debug, Clone)]',
  '#[serde(rename_all = "camelCase")]',
  'pub struct EchoInput {',
  '    pub message: String,',
  '}',
  '',
].join('\n');

function seedCrate(dir: string): string {
  const project = join(dir, 'proj');
  mkdirSync(join(project, 'src', 'bin'), { recursive: true });
  writeFileSync(join(project, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n');
  writeFileSync(join(project, 'Cargo.lock'), 'version = 3\n');
  writeFileSync(join(project, 'src', 'lib.rs'), LIB_RS_V1);
  writeFileSync(join(project, 'src', 'bin', 'generate.rs'), 'fn main() {}\n');
  return project;
}

/** dev.ts 와 같은 루트 구성 — src 트리 + Cargo.toml + Cargo.lock. */
function fingerprintOf(project: string): string {
  return rustInputFingerprint([
    join(project, 'src'),
    join(project, 'Cargo.toml'),
    join(project, 'Cargo.lock'),
  ]);
}

test('rustInputFingerprint is deterministic and ignores mtime-only changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-fp-det-'));
  try {
    const project = seedCrate(dir);
    const first = fingerprintOf(project);
    assert.equal(fingerprintOf(project), first, 'the same tree must hash identically');
    // 내용 불변 재시점화(빌드 도구의 touch) — mtime 이 움직여도 지문은 그대로다.
    utimesSync(join(project, 'src', 'lib.rs'), new Date(), new Date('2020-01-01T00:00:00Z'));
    utimesSync(join(project, 'Cargo.toml'), new Date(), new Date('2020-01-01T00:00:00Z'));
    assert.equal(fingerprintOf(project), first, 'mtime-only changes must not move the fingerprint');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rustInputFingerprint walks nested source trees', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-fp-nested-'));
  try {
    const project = seedCrate(dir);
    const before = fingerprintOf(project);
    writeFileSync(join(project, 'src', 'bin', 'generate.rs'), 'fn main() { /* c */ }\n');
    assert.notEqual(
      fingerprintOf(project),
      before,
      'a nested module edit is part of the codegen inputs',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('all five schema-contamination edits change the fingerprint', () => {
  // 계획 Stage 1 의 오염 시나리오 5종 — 스키마는 컴파일된 Rust 에서만 나오므로
  // 지문은 토큰 수준이 아니라 **내용** 수준에서 틀린다. 어떤 편집도 지문 불변으로
  // 지나가면 스킵이 스키마 드리프트를 삼키는 false-negative 다.
  const mutations: Array<[string, string]> = [
    [
      'a field addition',
      LIB_RS_V1.replace('pub message: String,', 'pub message: String,\n    pub count: i64,'),
    ],
    ['a field rename', LIB_RS_V1.replace('pub message:', 'pub text:')],
    ['a field type change', LIB_RS_V1.replace('message: String', 'message: i64')],
    ['an attribute removal', LIB_RS_V1.replace('#[serde(rename_all = "camelCase")]\n', '')],
    ['a derive change', LIB_RS_V1.replace('#[derive(Debug, Clone)]', '#[derive(Debug)]')],
  ];
  const dir = mkdtempSync(join(tmpdir(), 'rustra-fp-contam-'));
  try {
    const project = seedCrate(dir);
    const lib = join(project, 'src', 'lib.rs');
    for (const [what, mutated] of mutations) {
      const base = fingerprintOf(project);
      writeFileSync(lib, mutated);
      assert.notEqual(fingerprintOf(project), base, `${what} must change the fingerprint`);
      writeFileSync(lib, LIB_RS_V1);
      assert.equal(fingerprintOf(project), base, `undoing ${what} must restore the fingerprint`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rustInputFingerprint covers Cargo.toml and Cargo.lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-fp-manifest-'));
  try {
    const project = seedCrate(dir);
    const base = fingerprintOf(project);
    writeFileSync(join(project, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.2.0"\n');
    assert.notEqual(fingerprintOf(project), base, 'a manifest edit is a codegen input');
    writeFileSync(join(project, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n');
    const afterManifest = fingerprintOf(project);
    writeFileSync(join(project, 'Cargo.lock'), 'version = 4\n');
    assert.notEqual(fingerprintOf(project), afterManifest, 'a lockfile edit is a codegen input');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rustInputFingerprint excludes target, node_modules, and .git at any depth', () => {
  // 감시자(watch.ts snapshotPath)와 같은 제외 규칙 — 빌드·캐시 트리의 쓰기는
  // 코드젠 입력이 아니므로 지문도 움직여서는 안 된다(그렇지 않으면 스킵이 없다).
  const dir = mkdtempSync(join(tmpdir(), 'rustra-fp-exclude-'));
  try {
    const project = seedCrate(dir);
    const base = fingerprintOf(project);
    for (const excluded of ['target', 'node_modules', '.git']) {
      mkdirSync(join(project, 'src', excluded), { recursive: true });
      writeFileSync(join(project, 'src', excluded, 'noise.rs'), 'pub struct Noise;');
    }
    assert.equal(fingerprintOf(project), base, 'build/cache trees must not enter the fingerprint');
    // 대조 — 같은 자리의 실제 소스 파일은 지문을 움직인다.
    writeFileSync(join(project, 'src', 'noise.rs'), 'pub struct Noise;');
    assert.notEqual(fingerprintOf(project), base, 'a real source addition must be seen');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rustInputFingerprint hashes symlink entries without following them', () => {
  // 감시자의 no-follow 규약 — 링크된 트리 밖 내용은 지문에 들어가지 않고, 링크
  // 자체의 유무·대상 텍스트가 지문이다(트리 밖 추종·사이클 진입 방지).
  const dir = mkdtempSync(join(tmpdir(), 'rustra-fp-symlink-'));
  try {
    const project = seedCrate(dir);
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'leak.rs'), 'pub struct Leak;');
    symlinkSync(outside, join(project, 'src', 'vendor'));
    const withLink = fingerprintOf(project);
    writeFileSync(join(outside, 'leak.rs'), 'pub struct Leak2;');
    assert.equal(
      fingerprintOf(project),
      withLink,
      'content behind a symlink must not enter the fingerprint',
    );
    rmSync(join(project, 'src', 'vendor'));
    assert.notEqual(fingerprintOf(project), withLink, 'removing the link must be seen');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rustInputFingerprint throws on uncertain filesystem state instead of guessing', () => {
  // fail-safe 계약 — 없는 루트(ENOENT)·파일 아래의 경로(ENOTDIR) 같은 불확실성은
  // "빈 기여"로 삼키지 않고 전파한다. dev 루프는 throw 를 스킵 금지로 번역한다.
  const dir = mkdtempSync(join(tmpdir(), 'rustra-fp-error-'));
  try {
    const project = seedCrate(dir);
    assert.throws(
      () => rustInputFingerprint([join(dir, 'missing-crate')]),
      /ENOENT/,
      'a missing root is uncertainty, not an empty input',
    );
    rmSync(join(project, 'Cargo.lock'));
    assert.throws(
      () => fingerprintOf(project),
      /ENOENT/,
      'a vanished input file is uncertainty too',
    );
    assert.throws(
      () => rustInputFingerprint([join(project, 'Cargo.toml', 'nested')]),
      /ENOTDIR/,
      'a path below a regular file cannot be walked',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

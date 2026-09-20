/**
 * 코드젠 대상 Rust 입력의 내용 지문 — 웜 루프 계획(2026-09-20) §(b) Stage 1.
 *
 * mtime 만 보면 두 방향으로 모두 틀린다: 내용 불변인 재쓰기는 과트리거(불필요한
 * 전체 파이프라인), 같은 mtime 안의 연속 쓰기는 과소트리거(스킵이어야 할 틱에
 * stale 코드젠)다. 그래서 파일 **내용**을 해시한다. 해시 대상 트리는 감시자가
 * 걷는 것과 같다(watch.ts snapshotPath) — 빌드·캐시·VCS 디렉터리(target,
 * node_modules, .git)는 제외하고, 심볼릭 링크는 따라가지 않고 링크 텍스트를
 * 기록한다(트리 밖 추종과 디렉터리 사이클 진입을 막는 감시자의 no-follow 규약).
 *
 * 오래 계약 — 이 함수는 불확실성을 삼키지 않는다: 루트가 없거나(ENOENT) 걷는
 * 도중 어떤 fs 오류가 나면 그대로 throw 한다. dev 루프의 호출자는 throw 를
 * "스킵 금지"로 번역한다(전체 파이프라인 fail-safe — 판단 불가 시 스킵 없음).
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/** 감시자와 같은 제외 규칙 — 빌드·캐시 트리는 지문에서도 소음일 뿐이다. */
const EXCLUDED_DIRECTORIES = new Set(['target', 'node_modules', '.git']);

/** 디렉터리 항목 순서는 readdir 규약상 무정의다 — 로캘 독립 비교로 정규화한다. */
function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function hashPath(hash: ReturnType<typeof createHash>, path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    // no-follow — 지문의 대상은 링크 텍스트다. 링크 대상 교체는 지문을 바꾸지만,
    // 대상 파일 내용의 변화는 감시 범위 밖이다(감시자도 같은 한계를 두었다).
    hash.update(`${path}\0`);
    hash.update(readlinkSync(path));
    return;
  }
  if (!stat.isDirectory()) {
    // 경로 프레이밍 — 내용만으로는 "어느 파일이 담겼는지"가 사라지므로 경로와
    // 내용을 NUL 로 구해 해시한다(경로·내용 접기 모호성 제거). 디렉터리 이름은
    // 자식 경로에 흡수되므로 따로 기록하지 않는다(빈 디렉터리는 cargo 입력이
    // 아니라 감시 소음).
    hash.update(`${path}\0`);
    hash.update(readFileSync(path));
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true }).sort(byName)) {
    if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    hashPath(hash, join(path, entry.name));
  }
}

/**
 * roots 에 담긴 파일·디렉터리 트리의 내용 지문(SHA-256 hex). 디렉터리는 재귀로
 * 걷되 감시자와 같은 제외 규칙을 적용한다. 순회 순서는 항목명 정규화로
 * 결정적이다 — 같은 트리는 항상 같은 지문을 낸다. fs 오류는 삼키지 않고
 * 전파한다(호출자의 fail-safe 계약 — 모듈 상단 주석).
 */
export function rustInputFingerprint(roots: string[]): string {
  const hash = createHash('sha256');
  for (const root of roots) hashPath(hash, root);
  return hash.digest('hex');
}

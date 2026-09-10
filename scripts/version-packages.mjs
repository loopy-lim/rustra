#!/usr/bin/env node
/**
 * changesets version 스텝의 래퍼 — `changeset version` 이 패키지 버전을 올린
 * 뒤, @rustra/cli 의 rustraTemplate.reactNativeRange 를 새 @rustra/react-native
 * 버전에 맞춘다. 어댑터 버전은 version PR 이 올리지만 범위는 아무도 안 올렸다 —
 * 범위가 뒤처지면 코드젠의 어댑터 버전 게이트가 새 버전을 거부해 main CI 가
 * 깨진다(2026-09-10 첫 RN 마이너 발행에서 실발). 범위와 버전은 같은 커밋에서
 * 움직여야 하고, 그 커밋은 version PR 이다.
 *
 * cargoRange 는 여기서 건드리지 않는다 — Rust 크레이트 라인은 changesets 가
 * 아니라 기능 커밋의 Cargo.toml 워크스페이스 버전으로 움직이므로, 범위도 그
 * 커밋에서 함께 올린다(check-release-coherence 가 불변식을 지킨다).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PUBLISHED_PACKAGES } from './check-release-coherence.mjs';

/** caret 마이너 범위 — 0.x 에서는 ^0.N.0 (0.N.x 허용). */
export function caretMinorRange(version) {
  const match = /^(\d+)\.(\d+)\.\d+/.exec(String(version).trim());
  if (!match) throw new Error(`not a released x.y.z version: ${version}`);
  const [, major, minor] = match;
  return `^${major}.${minor}.0`;
}

/**
 * cli manifest 의 reactNativeRange 를 어댑터 버전에서 다시 계산해 반영한다.
 * 키 순서·들여쓰기가 바뀌면 version PR diff 가 필요하게 커지므로 정확한 문자열
 * 치환만 한다.
 */
export function syncReactNativeRange(cliManifestPath, reactNativeVersion) {
  const expected = caretMinorRange(reactNativeVersion);
  const text = readFileSync(cliManifestPath, 'utf8');
  const pattern = /("reactNativeRange"\s*:\s*")([^"]+)(")/;
  const match = pattern.exec(text);
  if (!match) throw new Error(`reactNativeRange key not found in ${cliManifestPath}`);
  if (match[2] === expected) return false;
  writeFileSync(cliManifestPath, text.replace(pattern, `$1${expected}$3`));
  return true;
}

/**
 * bun.lock 워크스페이스 블록의 메타데이터(version, @rustra/* 내부 의존 범위)를
 * manifest 로 맞춘다. bun install 은 이 필드들을 다시 쓰지 않는다(2026-09-10
 * 실측 — workspace 패키지의 version 이 올라가도 잠금은 그대로다) 그래서
 * changeset version 직후엔 manifest=0.9.0 / lock=0.8.0 어긋남이 남고
 * test:release-coherence 가 version PR CI 를 깨뜨린다. 워크스페이스 블록
 * 안의 두 종류 값만 치환한다 — 레지스트리 패키지 해석 영역은 건드리지 않는다.
 */
export function syncLockWorkspaceMetadata(lockPath, manifests) {
  let text = readFileSync(lockPath, 'utf8');
  let changed = false;
  for (const [packageDir, manifest] of Object.entries(manifests)) {
    const blockPattern = new RegExp(`("${packageDir.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}"\\s*:\\s*\\{)([\\s\\S]*?)(\\n    \\},)`);
    const blockMatch = blockPattern.exec(text);
    if (!blockMatch) continue;
    let block = blockMatch[2];
    const rewritten = block.replace(
      /("(?<depKey>@rustra\/[a-z-]+)"\s*:\s*")(?<depRange>[^"]+)(")|("version"\s*:\s*")(?<versionValue>[^"]+)(")/g,
      (whole, ...groups) => {
        const named = groups[groups.length - 1];
        if (named.depKey !== undefined) {
          const range = manifest.dependencies?.[named.depKey];
          return range !== undefined && range !== named.depRange
            ? `${groups[0]}${range}${groups[3]}`
            : whole;
        }
        return manifest.version !== undefined && manifest.version !== named.versionValue
          ? `${groups[4]}${manifest.version}${groups[6]}`
          : whole;
      },
    );
    if (rewritten !== block) {
      text = text.replace(blockMatch[0], `${blockMatch[1]}${rewritten}${blockMatch[3]}`);
      changed = true;
    }
  }
  if (changed) writeFileSync(lockPath, text);
  return changed;
}

function main() {
  const args = process.argv.slice(2);
  const root = join(import.meta.dirname, '..');
  execFileSync(
    process.platform === 'win32' ? 'bunx.cmd' : 'bunx',
    ['changeset', 'version', ...args],
    { stdio: 'inherit', cwd: root },
  );
  const reactNativeVersion = JSON.parse(
    readFileSync(join(root, 'packages/react-native/package.json'), 'utf8'),
  ).version;
  if (syncReactNativeRange(join(root, 'packages/cli/package.json'), reactNativeVersion)) {
    console.log(`[version] rustraTemplate.reactNativeRange synced to ${reactNativeVersion}`);
  }
  // 버전이 오른 manifest 와 bun.lock 워크스페이스 메타데이터가 어긋나면
  // release-coherence 가 version PR CI 를 깨뜨린다(manifest=0.9.0, lock=0.8.0 —
  // 2026-09-10 첫 버전 PR 실측). bun install 은 이 필드들을 안 고치므로
  // 직접 맞춘다.
  const manifests = {};
  for (const name of PUBLISHED_PACKAGES) {
    manifests[`packages/${name}`] = JSON.parse(
      readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'),
    );
  }
  if (syncLockWorkspaceMetadata(join(root, 'bun.lock'), manifests)) {
    console.log('[version] bun.lock workspace metadata synced to manifests');
  }
}

if (process.argv[1] === import.meta.filename || process.argv[1]?.endsWith('version-packages.mjs')) {
  main();
}

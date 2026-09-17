#!/usr/bin/env node
// 모노레포 예제 전용: bun의 file: 의존성은 소스를 캐시 스냅샷으로 '복사'한다.
// node_modules/@rustra/{react-native,types} 가 설치 시점 고정이 되면 어댑터
// 수정(예: RustraJSIBridge.cpp)이 재설치 전까지 예제 네이티브 빌드에
// 반영되지 않는다. 설치 직후 두 패키지를 라이브 소스 심볼릭으로 교체한다 —
// 생성물(build.gradle/podspec)의 node_modules 기준 경로는 실사용자 앱과
// 동일하게 유지된다.
import { existsSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packages = {
  '@rustra/react-native': 'packages/react-native',
  '@rustra/types': 'packages/types',
};

for (const [name, relative] of Object.entries(packages)) {
  const link = resolve(exampleRoot, 'node_modules', name);
  const target = resolve(exampleRoot, '..', '..', relative);
  if (!existsSync(resolve(exampleRoot, 'node_modules'))) continue;
  let linkedTo = null;
  try {
    linkedTo = resolve(dirname(link), readlinkSync(link));
  } catch {
    linkedTo = null;
  }
  if (linkedTo === target) continue;
  rmSync(link, { recursive: true, force: true });
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

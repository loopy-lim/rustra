import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { RkyvV2Codec, RkyvV2EngineOptions } from '@rustra/types';

/** cdylib 후보 해상에 필요한 필드 — 이벤트 구독 팩토리(bun-event-subscription)가
 * 부트스트랩과 동일한 해상을 재사용할 수 있게 분리한 하위 집합이다. */
export type BunLibraryOptions = {
  library?: string;
  libraryCandidates?: readonly string[];
  libraryName?: string;
};

export type BunFfiEngineOptions = Omit<RkyvV2EngineOptions, 'rkyvV2Codecs'> & {
  rkyvV2Codecs: Map<string, RkyvV2Codec<unknown, unknown>>;
} & BunLibraryOptions;

export type BunFfiRuntime = {
  engine: import('@rustra/types').RkyvV2Engine;
  library: string;
  usesCallerBufferInto: boolean;
  close(): void;
};

export function bunLibraryCandidates(options: BunLibraryOptions): string[] {
  const explicit = process.env.RUSTRA_BUN_LIBRARY ?? options.library;
  if (explicit) return [explicit];
  const candidates = [...(options.libraryCandidates ?? [])];
  if (options.libraryName) {
    const extension =
      process.platform === 'darwin' ? 'dylib' : process.platform === 'win32' ? 'dll' : 'so';
    const prefix = process.platform === 'win32' ? '' : 'lib';
    const filename = `${prefix}${options.libraryName}.${extension}`;
    let current = resolve(process.cwd());
    while (true) {
      candidates.push(resolve(current, 'target', 'release', filename));
      candidates.push(resolve(current, 'target', 'debug', filename));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...new Set(candidates)].filter((candidate) => existsSync(candidate));
}

import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { RustraCommandError, type FrameCodec, type FrameEngineOptions } from '@rustra/types';

/** cdylib 후보 해상에 필요한 필드 — 이벤트 구독 팩토리(bun-event-subscription)가
 * 부트스트랩과 동일한 해상을 재사용할 수 있게 분리한 하위 집합이다. */
export type BunLibraryOptions = {
  library?: string;
  libraryCandidates?: readonly string[];
  libraryName?: string;
};

export type BunFfiEngineOptions = Omit<FrameEngineOptions, 'frameCodecs'> & {
  frameCodecs: Map<string, FrameCodec<unknown, unknown>>;
} & BunLibraryOptions;

export type BunFfiRuntime = {
  engine: import('@rustra/types').FrameEngine;
  library: string;
  usesCallerBufferInto: boolean;
  close(): void;
};

/** 계약 검증 기각 코드(감사 A1) — 다른 코드의 실패는 후보 폴백 없이 즉시 전파. */
const CONTRACT_REJECTION_CODES = ['contract.mismatch', 'contract.unenforceable'];

function isContractRejection(error: unknown): error is RustraCommandError {
  return error instanceof RustraCommandError && CONTRACT_REJECTION_CODES.includes(error.code);
}

function libraryMtime(candidate: string): string {
  try {
    return statSync(candidate).mtime.toISOString();
  } catch {
    return 'unknown';
  }
}

function mtimeMs(candidate: string): number {
  try {
    return statSync(candidate).mtimeMs;
  } catch {
    return -1;
  }
}

/** 후보를 mtime 최신 빌드 우선으로 안정 정렬 — release 디렉터리에 오래된 cdylib 이
 * 남은 함정(감사 A1)에서 "방금 빌드한" 쪽을 먼저 시도한다. 부트스트랩뿐 아니라
 * 계약 검증 없이 해상하는 이벤트 구독 팩토리도 같은 후보를 잡게 하는 정렬이다. */
function orderCandidatesNewestFirst(candidates: string[]): string[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, mtime: mtimeMs(candidate) }))
    .sort((left, right) => right.mtime - left.mtime || left.index - right.index)
    .map((entry) => entry.candidate);
}

export function bunLibraryCandidates(options: BunLibraryOptions): string[] {
  const explicit = process.env.RUSTRA_BUN_LIBRARY ?? options.library;
  if (explicit) return [explicit];
  const candidates = [...(options.libraryCandidates ?? [])];
  if (options.libraryName) {
    let extension: string;
    if (process.platform === 'darwin') {
      extension = 'dylib';
    } else if (process.platform === 'win32') {
      extension = 'dll';
    } else {
      extension = 'so';
    }
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
  return orderCandidatesNewestFirst([...new Set(candidates)].filter((c) => existsSync(c)));
}

/**
 * 계약 검증 기반 cdylib 후보 선택(감사 A1) — attempt 는 후보 하나를
 * dlopen→init→엔진 생성(계약 handshake 포함)까지 수행한다. 실패 분류:
 * - plain Error(dlopen/init 실패) → probe 기각, 다음 후보 계속 스캔.
 * - contract.mismatch/unenforceable → 계약 기각, 다음 후보 폴백.
 * - 그 외 RustraCommandError → 엔진 수준 실패, 즉시 전파(폴백 대상 아님).
 * 전부 기각되면 마지막 계약 오류에 "시도한 전체 후보 경로+mtime" 보고를 붙여
 * 다시 던진다. dlopen 을 직접 모르므로 주입 attempt 로 단위 테스트한다.
 */
export async function selectVerifiedLibrary<T>(
  candidates: readonly string[],
  attempt: (candidate: string) => T | Promise<T>,
): Promise<{ runtime: T; library: string } | { probeFailures: string[] }> {
  const probeFailures: string[] = [];
  const contractRejections: Array<{ candidate: string; reason: string }> = [];
  let lastRejection: RustraCommandError | undefined;
  for (const candidate of candidates) {
    try {
      const runtime = await attempt(candidate);
      return { runtime, library: candidate };
    } catch (error) {
      if (isContractRejection(error)) {
        contractRejections.push({ candidate, reason: error.code });
        lastRejection = error;
        continue;
      }
      if (error instanceof RustraCommandError) throw error;
      probeFailures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (lastRejection) {
    const described = [
      ...probeFailures,
      ...contractRejections.map(
        ({ candidate, reason }) => `${candidate} (modified ${libraryMtime(candidate)}): ${reason}`,
      ),
    ].join('; ');
    throw new RustraCommandError(
      lastRejection.code,
      `${lastRejection.message} Tried ${contractRejections.length + probeFailures.length} ` +
        `cdylib candidates (newest first): ${described}.`,
      lastRejection.retryable,
      lastRejection,
    );
  }
  return { probeFailures };
}

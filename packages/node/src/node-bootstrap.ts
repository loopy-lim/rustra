import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  configureLazy,
  disposedBootstrapError,
  ensureConfigured,
  RustraCommandError,
  RustraErrorCode,
  type BootstrapState,
  type EngineClientWithBatch,
} from '@rustra/types';
import {
  createNodeEngine,
  createNodeProcessTransport,
  type NodeBootstrap,
  type NodeBootstrapOptions,
  type NodeProcessTransport,
} from './node-core.js';

/** 계약 검증 기각 코드(감사 A1) — 다른 코드의 실패는 후보 폴백 없이 즉시 전파. */
const CONTRACT_REJECTION_CODES = ['contract.mismatch', 'contract.unenforceable'];

function isContractRejection(error: unknown): error is RustraCommandError {
  return error instanceof RustraCommandError && CONTRACT_REJECTION_CODES.includes(error.code);
}

function noNodeRuntimeError(): RustraCommandError {
  return new RustraCommandError(
    RustraErrorCode.TransportUnavailable,
    'No Rustra Node runtime was found. Build the inferred Cargo binary, or set RUSTRA_NODE_BINARY to its absolute path.',
  );
}

function runtimeMtime(candidate: string): string {
  try {
    return statSync(candidate).mtime.toISOString();
  } catch {
    return 'unknown';
  }
}

/** 후보를 mtime 최신 빌드 우선으로 안정 정렬 — release 디렉터리에 오래된 산출물이
 * 남은 함정(감사 A1)에서 "방금 빌드한" 쪽을 먼저 시도한다. 부트스트랩뿐 아니라
 * 계약 검증 없이 해상하는 이벤트 구독 팩토리도 같은 후보를 잡게 하는 정렬이다. */
function orderCandidatesNewestFirst(candidates: string[]): string[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, mtime: mtimeMs(candidate) }))
    .sort((left, right) => right.mtime - left.mtime || left.index - right.index)
    .map((entry) => entry.candidate);
}

function mtimeMs(candidate: string): number {
  try {
    return statSync(candidate).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * 런타임 실행 파일 후보 전체 — `command` → `RUSTRA_NODE_BINARY` → 후보/이름 추론,
 * 존재하는 것만 최신 빌드 순. 명시 지정은 존재 검사·정렬 없이 단일 후보다.
 * 이벤트 구독 팩토리(node-event-subscription.ts)도 같은 해상을 재사용한다 —
 * 부트스트랩과 이벤트 transport 가 서로 다른 런타임을 가리키지 않게.
 */
export function nodeRuntimeCandidates(options: NodeBootstrapOptions): string[] {
  const explicit = process.env.RUSTRA_NODE_BINARY ?? options.command;
  if (explicit) return [explicit];
  const candidates = [...(options.commandCandidates ?? [])];
  if (options.binaryName) {
    const executable = options.binaryName + (process.platform === 'win32' ? '.exe' : '');
    let current = resolve(process.cwd());
    while (true) {
      candidates.push(resolve(current, 'target', 'release', executable));
      candidates.push(resolve(current, 'target', 'debug', executable));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return orderCandidatesNewestFirst([...new Set(candidates)].filter((c) => existsSync(c)));
}

export function resolveNodeRuntime(options: NodeBootstrapOptions): string {
  const first = nodeRuntimeCandidates(options)[0];
  if (first !== undefined) return first;
  throw noNodeRuntimeError();
}

/** (A6) Node 계약 불일치 — Bun 구현(frame-engine-contract)과 동일한 fix 안내. */
function nodeContractMismatchError(nativeHash: string, expectedHash: string): RustraCommandError {
  return new RustraCommandError(
    'contract.mismatch',
    `contract hash mismatch: native="${nativeHash.slice(0, 16)}…" vs ` +
      `expected="${expectedHash.slice(0, 16)}…" — generated client and native binary are ` +
      `out of sync; regenerate the TypeScript and native codecs, rebuild the Rust archive, ` +
      `then rebuild the native app`,
  );
}

/**
 * 계약 검증 기반 후보 선택(감사 A1) — attempt 의 mismatch/unenforceable 은 fatal 이
 * 아니라 후보 기각 사유다. 다음 후보를 시도해 첫 번째로 검증을 통과한 값을 돌려주고,
 * 전부 기각되면 마지막 계약 오류에 "시도한 전체 후보 경로+mtime" 보고를 붙여
 * 다시 던진다. 계약 외 실패는 어느 후보에서 나왔는지와 무관하게 즉시 전파.
 */
export async function selectVerifiedRuntime<T>(
  candidates: readonly string[],
  attempt: (candidate: string) => Promise<T> | T,
): Promise<{ value: T; candidate: string }> {
  const rejections: Array<{ candidate: string; reason: string }> = [];
  let lastRejection: RustraCommandError | undefined;
  for (const candidate of candidates) {
    try {
      return { value: await attempt(candidate), candidate };
    } catch (error) {
      if (!isContractRejection(error)) throw error;
      rejections.push({ candidate, reason: error.code });
      lastRejection = error;
    }
  }
  if (!lastRejection) throw noNodeRuntimeError();
  const described = rejections
    .map(({ candidate, reason }) => `${candidate} (modified ${runtimeMtime(candidate)}): ${reason}`)
    .join('; ');
  throw new RustraCommandError(
    lastRejection.code,
    `${lastRejection.message} Tried ${rejections.length} runtime candidate${
      rejections.length === 1 ? '' : 's'
    } (newest first): ${described}.`,
    lastRejection.retryable,
    lastRejection,
  );
}

export type { BootstrapState } from '@rustra/types';

/** (A05) bootstrap 수명 상태 3종 — 상태 모델 계약은 @rustra/types 참고. */

export function createNodeBootstrap(options: NodeBootstrapOptions = {}): NodeBootstrap {
  // await 경계 재검사용 — 클로저 변수를 직접 비교하면 TS 제어 흐름 분석이
  // dispose() 의 부수 효과를 추적하지 못해 비교를 데드 코드로 지워버린다.
  const readState = (): BootstrapState => state;
  let transport: NodeProcessTransport | undefined;
  let state: BootstrapState = 'initializing';
  // 계약 검증 — mismatch 는 이 스폰의 기각 사유(후보 선택으로 승격, 감사 A1).
  // (A2) 정책: 'warn' 은 기각 대신 warn 후 채택(degraded), 'off' 는 검증 생략 —
  // 두 탈출구 모두 해시 기반 후보 선택도 함께 풀린다(열거 순서 첫 후보).
  const verifyContract = async (spawned: NodeProcessTransport): Promise<void> => {
    if (options.contractHash === undefined) return;
    if (options.contractVerification === 'off') return;
    const nativeHash = await spawned.getContractHash();
    if (nativeHash !== options.contractHash) {
      if (options.contractVerification === 'warn') {
        console.warn(
          `[rustra] contract hash mismatch: native="${nativeHash.slice(0, 16)}…" vs ` +
            `expected="${options.contractHash.slice(0, 16)}…" — continuing in degraded mode ` +
            `(contractVerification: 'warn'); regenerate the client or rebuild the Rust host`,
        );
        return;
      }
      throw nodeContractMismatchError(nativeHash, options.contractHash);
    }
  };
  // handshake 중 비계약 실패(spawn 오류 등)의 기존 래핑 — 엔드포인트 자체가 없는
  // stale 바이너리도 unenforceable 기각으로 취급해 다음 후보를 시도한다.
  const wrapUnenforceable = (error: unknown): RustraCommandError =>
    isContractRejection(error)
      ? error
      : new RustraCommandError(
          'contract.unenforceable',
          'Node runtime does not expose the __rustra_contract endpoint; rebuild the Rust host with the current Rustra scaffold.',
          false,
          error,
        );
  let closeResource: (() => void) | undefined;
  let reloadPromise: Promise<void> | undefined;
  const assertActive = () => {
    if (readState() === 'disposed') throw disposedBootstrapError('Node');
    if (!registration.isCurrent())
      throw new RustraCommandError(
        'transport.unavailable',
        'Node bootstrap registration was replaced',
      );
  };
  const adopt = async (spawned: NodeProcessTransport): Promise<EngineClientWithBatch> => {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      spawned.dispose();
    };
    try {
      assertActive();
      transport = spawned;
      closeResource = close;
      await verifyContract(spawned);
      assertActive();
      const engine = createNodeEngine({
        invoke(command, args) {
          if (closed) throw disposedBootstrapError('Node');
          return spawned.invoke(command, args);
        },
      });
      const invokeBatch = engine.invokeBatch.bind(engine);
      engine.invokeBatch = (entries) =>
        closed ? Promise.reject(disposedBootstrapError('Node')) : invokeBatch(entries);
      return engine;
    } catch (error) {
      close();
      if (closeResource === close) {
        closeResource = undefined;
        transport = undefined;
      }
      assertActive();
      throw wrapUnenforceable(error);
    }
  };
  const bootstrap = async (): Promise<EngineClientWithBatch> => {
    assertActive();
    if (options.createTransport) {
      // Keep the late resource local: disposal may already have cleared shared state.
      const spawned = await options.createTransport();
      return adopt(spawned);
    }
    const candidates = nodeRuntimeCandidates(options);
    if (candidates.length === 0) throw noNodeRuntimeError();
    const { value } = await selectVerifiedRuntime(candidates, (candidate) =>
      adopt(
        createNodeProcessTransport({
          command: candidate,
          args: options.args,
          spawnOptions: options.spawnOptions,
        }),
      ),
    );
    return value;
  };
  let registration = configureLazy(bootstrap, { ownerId: 'node' });
  const ready = async (): Promise<EngineClientWithBatch> => {
    assertActive();
    const requestedRegistration = registration;
    try {
      const engine = (await ensureConfigured()) as EngineClientWithBatch;
      assertActive();
      if (requestedRegistration !== registration)
        throw new RustraCommandError(
          'transport.unavailable',
          'Node readiness was superseded by reload; call ready() again',
        );
      state = 'ready';
      return engine;
    } catch (error) {
      if (!registration.isCurrent()) {
        closeResource?.();
        closeResource = undefined;
        transport = undefined;
      }
      throw error;
    }
  };
  return {
    get state() {
      return state;
    },
    ready,
    dispose() {
      if (state === 'disposed') return;
      state = 'disposed';
      registration();
      closeResource?.();
      closeResource = undefined;
      transport = undefined;
    },
    reload() {
      if (readState() === 'disposed') return Promise.reject(disposedBootstrapError('Node'));
      if (reloadPromise) return reloadPromise;
      const operation = async () => {
        // Finish any initial ready/global invoke before replacing its owned resource.
        assertActive();
        if (state !== 'ready') await ready();
        await (transport as { drain?: (timeoutMs?: number) => Promise<void> } | undefined)?.drain?.(
          5_000,
        );
        assertActive();
        state = 'initializing';
        closeResource?.();
        closeResource = undefined;
        transport = undefined;
        registration = configureLazy(bootstrap, { ownerId: 'node' });
        await ready();
      };
      reloadPromise = operation().finally(() => {
        reloadPromise = undefined;
      });
      return reloadPromise;
    },
  };
}

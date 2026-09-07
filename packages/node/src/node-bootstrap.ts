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

/** (A6) Node 계약 불일치 — Bun 구현(rkyv-engine-contract)과 동일한 fix 안내. */
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
  const verifyContract = async (spawned: NodeProcessTransport): Promise<void> => {
    if (options.contractHash === undefined) return;
    const nativeHash = await spawned.getContractHash();
    if (nativeHash !== options.contractHash)
      throw nodeContractMismatchError(nativeHash, options.contractHash);
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
  const bootstrap = async (): Promise<EngineClientWithBatch> => {
    // 주입 transport(테스트 seam)은 후보 열거 없이 단일 스폰 — 기각 폴백도 없다.
    if (options.createTransport) {
      transport = await options.createTransport();
      // (I-NEW) 재초기화 클로저의 dispose 경계 — transport 주입 await 중 dispose
      // 되면 이 클로저의 엔진은 전역 슬롯에 설치되면 안 된다. ensureConfigured 의
      // catch(initialization 비움)가 configure(engine) 기록을 막아 dispose 후
      // 글로벌 invoke() 는 disposed loud-fail 로 귀결된다.
      if (readState() === 'disposed') throw disposedBootstrapError('Node');
      if (options.contractHash !== undefined) {
        try {
          await verifyContract(transport);
        } catch (error) {
          transport.dispose();
          transport = undefined;
          throw wrapUnenforceable(error);
        }
      }
      if (readState() === 'disposed') throw disposedBootstrapError('Node');
      return createNodeEngine(transport);
    }
    // 추론 후보 — 계약 검증으로 선택한다(감사 A1). stale release 가 앞에 있으면
    // 기각되고 다음(방금 빌드한) 후보가 채택된다.
    const candidates = nodeRuntimeCandidates(options);
    if (candidates.length === 0) throw noNodeRuntimeError();
    const { value: verified } = await selectVerifiedRuntime(candidates, async (candidate) => {
      const spawned = createNodeProcessTransport({
        command: candidate,
        args: options.args,
        spawnOptions: options.spawnOptions,
      });
      try {
        if (readState() === 'disposed') throw disposedBootstrapError('Node');
        await verifyContract(spawned);
        return spawned;
      } catch (error) {
        spawned.dispose();
        // await 중 dispose 가 원인이면 unenforceable 래핑 대신 disposed 로 알린다.
        if (readState() === 'disposed') throw disposedBootstrapError('Node');
        throw wrapUnenforceable(error);
      }
    });
    transport = verified;
    // (I-NEW) 반환 직전 dispose 경계 — 계약 해시 검증 await 중 dispose 되면
    // 이 엔진(죽은 transport 를 참조)을 전역 슬롯에 설치하지 않는다.
    if (readState() === 'disposed') {
      transport.dispose();
      transport = undefined;
      throw disposedBootstrapError('Node');
    }
    return createNodeEngine(transport);
  };
  // R08 — 글로벌 슬롯은 단일 엔진 전용. ownerId 는 소비 전 경쟁 등록이
  // 일어나면 registry.frozen loud-fail 의 진단 메시지에 양쪽 주체를 보고한다.
  // 같은 bootstrap 클로저의 재등록(reload)은 참조 동일성으로 언제나 허용된다.
  configureLazy(bootstrap, { ownerId: 'node' });
  const dispose = () => {
    if (state === 'disposed') return; // dispose-once 멱등 — 두 번째는 no-op
    state = 'disposed';
    transport?.dispose();
    transport = undefined;
  };
  // (I-1/I-2) reload 내부 리셋 — 사용자 dispose 와 다른 상태 의미를 갖는다:
  // 재초기화가 곧 진행되므로 'initializing' 을 유지한다. 'disposed' 로
  // 놓으면 두 번째 await 경계 재검사가 reload 자신의 리셋을 "사용자 dispose"
  // 로 오판하고(I-1), 실패 시 벽돌 상태가 남는다(I-2).
  const resetForRespawn = () => {
    state = 'initializing';
    transport?.dispose();
    transport = undefined;
  };
  return {
    get state() {
      return state;
    },
    ready: () => {
      if (state === 'disposed') return Promise.reject(disposedBootstrapError('Node'));
      return (ensureConfigured() as Promise<EngineClientWithBatch>).then((engine) => {
        if (state === 'disposed') throw disposedBootstrapError('Node');
        state = 'ready';
        return engine;
      });
    },
    dispose,
    async reload() {
      // 재초기화 계약(A1): 자식 dispose → 같은 런타임 해상으로 재스폰 + (설정 시)
      // 계약 해시 재검증. 새 바이너리 이미지는 스폰 시점에 읽히므로 cargo 재빌드 후
      // reload 만으로 반영된다.
      if (state === 'disposed') return Promise.reject(disposedBootstrapError('Node'));
      // (A05) drain 연결 — reload 는 부트스트랩이 소유한 transport 를 duck-typing
      // 으로 drain 한다(기본 5초, 타임아웃 후 진행). drain 이 없는 원샷 트랜스포트
      // (NodeProcessTransport)는 즉시 진행 — dispose 시 진행 중 invocation 은
      // 얕은 취소(re-dispose reject)로 정리된다. drain 은 타임아웃 후 항상
      // 해소하므로(transport 계약) reload 는 여기서 멈추지 않는다.
      // drain reject 는 reload 도 중단시킨다 — dispose 는 하지 않은 상태.
      await (transport as { drain?: (timeoutMs?: number) => Promise<void> } | undefined)?.drain?.(
        5_000,
      );
      // (I-1) await 경계 재검사 — drain 중 dispose 되면 reload 는 중단한다.
      // 재개해 state='ready' 로 부활하는 좀비 bootstrap 을 만들지 않는다.
      if (readState() === 'disposed') throw disposedBootstrapError('Node');
      // (I-2) 재초기화 실패는 벽돌이 아니라 'initializing'(재시도 가능)으로
      // 남는다 — resetForRespawn 이 이미 'initializing' 을 유지하므로 다음
      // ready() 가 재시도한다. 원본 에러는 그대로 전파된다(N-2: rethrow 만
      // 하던 try/catch 는 제거 — 삼키면 false success 가 된다).
      resetForRespawn();
      configureLazy(bootstrap, { ownerId: 'node' });
      await (ensureConfigured() as Promise<EngineClientWithBatch>);
      // (I-1) 두 번째 await 경계 — 재초기화 중 dispose 되면 'ready' 기록을 금지.
      // resetForRespawn 이 'initializing' 을 유지하므로 disposed 는 사용자
      // dispose 뿐이다.
      if (readState() === 'disposed') throw disposedBootstrapError('Node');
      state = 'ready';
    },
  };
}

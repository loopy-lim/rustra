import { existsSync } from 'node:fs';
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

/**
 * 런타임 실행 파일 해상 — `command` → `RUSTRA_NODE_BINARY` → 후보/이름 추론.
 * 이벤트 구독 팩토리(node-event-subscription.ts)도 같은 해상을 재사용한다 —
 * 부트스트랩과 이벤트 transport 가 서로 다른 런타임을 가리키지 않게.
 */
export function resolveNodeRuntime(options: NodeBootstrapOptions): string {
  const explicit = process.env.RUSTRA_NODE_BINARY ?? options.command;
  if (explicit) return explicit;
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
  const inferred = candidates.find((candidate) => existsSync(candidate));
  if (inferred) return inferred;
  throw new RustraCommandError(
    RustraErrorCode.TransportUnavailable,
    'No Rustra Node runtime was found. Build the inferred Cargo binary, or set RUSTRA_NODE_BINARY to its absolute path.',
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
  const bootstrap = async (): Promise<EngineClientWithBatch> => {
    const spawnTransport =
      options.createTransport ??
      (() =>
        createNodeProcessTransport({
          command: resolveNodeRuntime(options),
          args: options.args,
          spawnOptions: options.spawnOptions,
        }));
    transport = await spawnTransport();
    if (options.contractHash !== undefined) {
      try {
        const nativeHash = await transport.getContractHash();
        if (nativeHash !== options.contractHash)
          throw new RustraCommandError(
            'contract.mismatch',
            `contract hash mismatch: native="${nativeHash.slice(0, 16)}…" vs expected="${options.contractHash.slice(0, 16)}…"`,
          );
      } catch (error) {
        transport.dispose();
        transport = undefined;
        if (
          error instanceof RustraCommandError &&
          ['contract.mismatch', 'contract.unenforceable'].includes(error.code)
        )
          throw error;
        throw new RustraCommandError(
          'contract.unenforceable',
          'Node runtime does not expose the __rustra_contract endpoint; rebuild the Rust host with the current Rustra scaffold.',
          false,
          error,
        );
      }
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
      try {
        resetForRespawn();
        configureLazy(bootstrap, { ownerId: 'node' });
        await (ensureConfigured() as Promise<EngineClientWithBatch>);
      } catch (error) {
        // (I-2) 재초기화 실패는 벽돌이 아니라 'initializing'(재시도 가능)으로
        // 남는다 — 원본 에러를 그대로 reject. resetForRespawn 이 이미
        // 'initializing' 을 유지하므로 다음 ready() 가 재시도한다.
        throw error;
      }
      // (I-1) 두 번째 await 경계 — 재초기화 중 dispose 되면 'ready' 기록을 금지.
      // resetForRespawn 이 'initializing' 을 유지하므로 disposed 는 사용자
      // dispose 뿐이다.
      if (readState() === 'disposed') throw disposedBootstrapError('Node');
      state = 'ready';
    },
  };
}

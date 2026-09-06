import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  configureLazy,
  ensureConfigured,
  RustraCommandError,
  RustraErrorCode,
  type EngineClientWithBatch,
} from '@rustra/types';
import {
  createNodeEngine,
  createNodeProcessTransport,
  type NodeBootstrap,
  type NodeBootstrapOptions,
  type NodeProcessTransport,
} from './node-core.js';
import { disposedBootstrapError, type BootstrapState } from './bootstrap-lifecycle.js';

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

export type { BootstrapState } from './bootstrap-lifecycle.js';

/** (A05) bootstrap 수명 상태 3종 — 상태 모델 계약은 bootstrap-lifecycle.ts 참고. */

export function createNodeBootstrap(options: NodeBootstrapOptions = {}): NodeBootstrap {
  let transport: NodeProcessTransport | undefined;
  let state: BootstrapState = 'initializing';
  const bootstrap = async (): Promise<EngineClientWithBatch> => {
    transport = createNodeProcessTransport({
      command: resolveNodeRuntime(options),
      args: options.args,
      spawnOptions: options.spawnOptions,
    });
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
      // reload 만으로 반영된다. 원샷 트랜스포트에는 drain 이 없다(루프 호스트의
      // NodeLoopTransport.drain 과 다름): dispose 시 진행 중 invocation 은
      // 얕은 취소(re-dispose reject)로 정리된다 — 문서화된 동작.
      if (state === 'disposed') return Promise.reject(disposedBootstrapError('Node'));
      // (A05) drain 연결 — 루프 호스트는 onReloadDrain 훅으로 자기 transport 의
      // drain 을 reload 에 연결한다(기본 5초, 타임아웃 후 진행). drain 자체가
      // 타임아웃 후 항상 해소하므로(transport 계약) reload 는 여기서 멈추지 않는다.
      await options.onReloadDrain?.(5_000);
      dispose();
      configureLazy(bootstrap, { ownerId: 'node' });
      await (ensureConfigured() as Promise<EngineClientWithBatch>);
      state = 'ready';
    },
  };
}

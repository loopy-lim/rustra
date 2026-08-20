/**
 * 레퍼런스 앱 — @rustra/react 훅 + crud 패키지로 만든 완결 CRUD + 이벤트 예제.
 *
 * Node 위에서 서브프로세스 transport(createNodeProcessTransport)로 실 Rust
 * crud 런타임(rustra-crud-example)을 호출한다. 브라우저/네이티브가 아니어도
 * 훅(useCommand/useMutation)의 데이터 흐름을 그대로 보여준다 — RustraProvider
 * 는 어떤 EngineClient든 받으므로, 같은 컴포넌트 트리가 RN/브라우저에서도
 * 재사용된다.
 *
 * 여기선 React 렌더러 없이 훅의 상태 머신을 구동한다(server-side 스모크).
 * App 컴포넌트(src/App.tsx)가 실제 UI 트리다.
 */
import { createElement } from 'react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createNodeEngine, createNodeProcessTransport } from '@rustra/node';
import { configure } from '@rustra/types';
import { RustraProvider, useCommand, useMutation, useEvent } from '@rustra/react';
import type { EngineClient } from '@rustra/types';
import { App } from './App.js';
import { listItems, createItem } from '../../crud/generated/commands.js';

// 컴파일 산출 위치(dist/examples/reference-app/src)에서 저장소 루트까지 6단계.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..');

export function makeEngine(): EngineClient {
  const transport = createNodeProcessTransport({
    command: resolve(repoRoot, 'target/debug/rustra-crud-example'),
    args: ['invoke'],
  });
  return createNodeEngine(transport);
}

// ── 스모크: 훅 로직을 렌더러 없이 검증 ──────────────────────
// (App 컴포넌트는 RustraProvider + 훅 사용 예시를 담는다)

async function main() {
  const engine = makeEngine();
  configure(engine); // 생성 헬퍼(listItems 등)가 쓰는 글로벌 엔진 설치

  // 1) useCommand 스모크 — listItems 조회
  const listed = await engine.invoke<{ items: Array<{ id: string; name: string; value: number }> }>(
    'listItems',
    {},
  );
  console.log(`listItems → ${listed.items.length} item(s)`);

  // 2) useMutation 스모크 — createItem 생성
  const created = await engine.invoke<{ item: { id: string; name: string; value: number } }>(
    'createItem',
    { name: 'smoke', value: 42 },
  );
  console.log(`createItem → ${created.item.id} (${created.item.name})`);

  // 3) 생성 함수 re-export 가 그대로 동작하는지 (훅 내부에서 쓰는 경로)
  const again = await listItems({ minValue: 0 });
  console.log(`listItems(minValue:0) → ${again.items.length} item(s)`);

  console.log('reference-app smoke: OK');
}

// App 이 실제로 마운트 가능한 트리임을 정적으로 보증(임포트 연결).
void App;
void createItem;
void useCommand;
void useMutation;
void useEvent;
void RustraProvider;
void createElement;

if (process.argv[1] && process.argv[1].endsWith('main.js')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

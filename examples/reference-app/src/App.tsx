/**
 * 레퍼런스 앱 UI 트리 — @rustra/react 훅 사용 예시.
 *
 * RustraProvider 로 스코프된 EngineClient 를 받아 CRUD + 이벤트 흐름을
 * useCommand/useMutation/useEvent 로 구성한다. RN/웹 어디서든 같은 트리를
 * 렌더할 수 있다(엔진만 플랫폼별로 주입).
 */
import React from 'react';
import { RustraProvider, useCommand, useMutation, useEvent } from '@rustra/react';
import type { EngineClient } from '@rustra/types';
import { listItems, createItem, updateItem, deleteItem } from '../../crud/generated/commands.js';

type Item = { id: string; name: string; value: number };

/** 조회 — useCommand: 마운트 시 자동 실행, input 변경 시 재실행. */
function ItemList({ minValue }: { minValue?: number }) {
  const query = React.useMemo(() => ({ minValue }), [minValue]);
  const { data, loading, error } = useCommand(listItems, query);
  if (loading) return <p>불러오는 중…</p>;
  if (error) return <p>에러: {error.message}</p>;
  const items = data?.items ?? [];
  return (
    <ul>
      {items.map((it: Item) => (
        <li key={it.id}>
          {it.name} = {it.value}
        </li>
      ))}
    </ul>
  );
}

/** 생성/수정/삭제 — useMutation: 수동 실행 + pending 상태. */
function ItemActions({ onDone }: { onDone: () => void }) {
  const mutationOptions = React.useMemo(() => ({ onSuccess: onDone }), [onDone]);
  const create = useMutation(createItem, mutationOptions);
  const update = useMutation(updateItem, mutationOptions);
  const remove = useMutation(deleteItem, mutationOptions);

  return (
    <div>
      <button disabled={create.loading} onClick={() => create.mutate({ name: 'New', value: 1 })}>
        생성
      </button>
      <button
        disabled={update.loading}
        onClick={() => update.mutate({ id: 'first', name: 'Renamed', value: null })}
      >
        수정
      </button>
      <button disabled={remove.loading} onClick={() => remove.mutate({ id: 'first' })}>
        삭제
      </button>
    </div>
  );
}

/** 이벤트 — useEvent: Rust emit 을 구독(RN rkyv V2 엔진에서 활성화). */
function LiveFeed() {
  const [last, setLast] = React.useState<string>('(대기 중)');
  useEvent('item.created', (payload: unknown) => {
    setLast(JSON.stringify(payload));
  });
  return <p>마지막 이벤트: {last}</p>;
}

export function App({ engine }: { engine: EngineClient }): React.ReactElement {
  const [tick, setTick] = React.useState(0);
  return (
    <RustraProvider engine={engine}>
      <h1>rustra 레퍼런스 앱</h1>
      <ItemList minValue={0} />
      <ItemActions onDone={() => setTick((t) => t + 1)} />
      <LiveFeed />
      <p key={tick}>갱신 #{tick}</p>
    </RustraProvider>
  );
}

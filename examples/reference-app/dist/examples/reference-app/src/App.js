/**
 * 레퍼런스 앱 UI 트리 — @rustra/react 훅 사용 예시.
 *
 * RustraProvider 로 스코프된 EngineClient 를 받아 CRUD + 이벤트 흐름을
 * useCommand/useMutation/useEvent 로 구성한다. RN/웹 어디서든 같은 트리를
 * 렌더할 수 있다(엔진만 플랫폼별로 주입).
 */
import React from 'react';
import { RustraProvider, useCommand, useMutation, useEvent } from '@rustra/react';
import { listItems, createItem, updateItem, deleteItem } from '../../crud/generated/commands.js';
/** 조회 — useCommand: 마운트 시 자동 실행, input 변경 시 재실행. */
function ItemList({ minValue }) {
    const { data, loading, error } = useCommand(listItems, { minValue });
    if (loading)
        return React.createElement("p", null, "\uBD88\uB7EC\uC624\uB294 \uC911\u2026");
    if (error)
        return React.createElement("p", null,
            "\uC5D0\uB7EC: ",
            error.message);
    const items = data?.items ?? [];
    return (React.createElement("ul", null, items.map((it) => (React.createElement("li", { key: it.id },
        it.name,
        " = ",
        it.value)))));
}
/** 생성/수정/삭제 — useMutation: 수동 실행 + pending 상태. */
function ItemActions({ onDone }) {
    const create = useMutation(createItem);
    const update = useMutation(updateItem);
    const remove = useMutation(deleteItem);
    return (React.createElement("div", null,
        React.createElement("button", { disabled: create.loading, onClick: () => create.mutateAsync({ name: 'New', value: 1 }).then(onDone) }, "\uC0DD\uC131"),
        React.createElement("button", { disabled: update.loading, onClick: () => update.mutateAsync({ id: 'first', name: 'Renamed', value: null }).then(onDone) }, "\uC218\uC815"),
        React.createElement("button", { disabled: remove.loading, onClick: () => remove.mutateAsync({ id: 'first' }).then(onDone) }, "\uC0AD\uC81C")));
}
/** 이벤트 — useEvent: Rust emit 을 구독(RN rkyv V2 엔진에서 활성화). */
function LiveFeed() {
    const [last, setLast] = React.useState('(대기 중)');
    useEvent('item.created', (payload) => {
        setLast(JSON.stringify(payload));
    });
    return React.createElement("p", null,
        "\uB9C8\uC9C0\uB9C9 \uC774\uBCA4\uD2B8: ",
        last);
}
export function App({ engine }) {
    const [tick, setTick] = React.useState(0);
    return (React.createElement(RustraProvider, { engine: engine },
        React.createElement("h1", null, "rustra \uB808\uD37C\uB7F0\uC2A4 \uC571"),
        React.createElement(ItemList, { minValue: 0 }),
        React.createElement(ItemActions, { onDone: () => setTick((t) => t + 1) }),
        React.createElement(LiveFeed, null),
        React.createElement("p", { key: tick },
            "\uAC31\uC2E0 #",
            tick)));
}

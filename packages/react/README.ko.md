[English](./README.md) | 한국어

# @rustra/react

Rustra 명령 클라이언트를 위한 React 훅과 컨텍스트다. `RustraProvider`,
`useRustraEngine`, `useCommand`, `useMutation`, `useEvent`, `useSuspenseCommand`,
`invalidateCommands`, `configureSuspenseCache`를 제공한다. React는 peer dependency이며,
Provider를 렌더링하기 전에 플랫폼별 엔진을 설정한다.

```tsx
import { RustraProvider, useCommand } from '@rustra/react';
import { getItem } from './generated/commands.js';

function Item({ id }: { id: string }) {
  const { data, loading, error } = useCommand(getItem, { id });
  if (loading) return <span>Loading...</span>;
  if (error) return <span>{error.message}</span>;
  return <span>{data?.name}</span>;
}

<RustraProvider engine={engine}>
  <Item id="item-1" />
</RustraProvider>;
```

`useSuspenseCommand(commandFn, input?, options?)`는 대기 중 Promise를 던지고 완료 값을
직접 반환한다. 실패는 가장 가까운 오류 경계로 전달한다. 캐시는 Provider의
`EngineClient` 객체, 명령 이름, 구조화된 입력을 키로 삼는다. SSR 요청이나 계정마다
별도 Provider 엔진을 사용한다. 하나의 엔진을 공유하면 캐시도 의도적으로 공유한다.
Provider가 없으면 현재 전역 등록 범위를 공유하며, 등록 교체·해제 후 다음 렌더링은
새 범위를 사용한다. 이전 콜백은 교체된 엔진을 호출할 수 없다. 동시 SSR 사용자에게는
요청별 Provider가 필요하다.

엔진당 최대 **256개** 항목을 유지한다. 완료 후 **5분**이 지나면 만료하고, 용량에
도달하면 완료 항목 중 가장 오래 접근하지 않은 항목을 제거한다. 대기 Promise는
Suspense 재시도를 위해 유지한다. 모든 슬롯이 대기 중이면 새 키 요청은 용량 오류를
오류 경계로 전달한다. 대기 항목은 **30초** 후 reject되어 제거·만료할 수 있다.
대기 제한은 엔진 작업 자체를 취소하지 않는다. 호출 옵션은 항목을 생성할 때만 적용한다.

`configureSuspenseCache({ maxEntries, ttlMs, pendingTimeoutMs }, engine?)`는 한 엔진의
정책을 바꾸고 기존 항목을 비운다. 엔진을 생략하면 전역 기본 범위를 설정한다. 값은
양의 안전한 정수여야 하며, 시간 값은 2,147,483,647 ms 이하여야 한다. 대기 중 항목을
무효화해도 기존 호출자의 Promise는 유지되지만, 늦은 완료가 캐시를 다시 채우지 않는다.

- `invalidateCommands('getItem', engine)`: 해당 엔진의 정확한 명령 이름만 비운다.
- `invalidateCommands(undefined, engine)`: 해당 엔진의 전체 캐시를 비운다.
- `invalidateCommands('getItem')`: 살아 있는 모든 엔진에서 해당 명령을 비운다.
- `invalidateCommands()`: 살아 있는 모든 캐시를 비운다.

무효화와 만료는 다음 렌더링에 반영되며 스스로 렌더링을 발생시키지 않는다. 엔진은 약한
참조로 유지하고, 캐시 결과에도 유한 보관 기간을 적용한다.

```tsx
import { Suspense } from 'react';
import { invalidateCommands, useSuspenseCommand } from '@rustra/react';
import { getItem, saveItem } from './generated/commands.js';

function Item({ id }: { id: string }) {
  const item = useSuspenseCommand(getItem, { id });
  return <span>{item.name}</span>;
}

async function rename(id: string, name: string) {
  await saveItem({ id, name });
  invalidateCommands('getItem'); // 다음 렌더링에서 다시 조회
}

<Suspense fallback={<span>Loading...</span>}>
  <Item id="item-1" />
</Suspense>;
```

`useCommand`와 `useSuspenseCommand`는 일반 객체, 배열, bigint, Set, Map, Date,
ArrayBuffer, 타입 지정 바이너리 뷰를 포함한 구조화된 입력을 지원한다. 키는 값의 타입과
바이너리 내용을 구분한다. 일반 객체의 필드 순서는 무시하지만 Set/Map 반복 순서와
바이너리 뷰 타입은 보존한다. 함수·symbol·순환 참조·미지원 클래스 인스턴스는
TypeError로 거부한다. 엔진에는 원래 입력을 전달한다.

`useMutation`은 엔진 또는 결정된 명령이 바뀌면 표시 상태를 초기화한다. 진행 중 호출은
호출자에게 결과를 반환할 수 있지만 교체된 범위나 초기화·언마운트된 훅의 상태는
갱신하지 않는다. 성공·오류·완료 콜백은 호출 시작 시 캡처하고, 초기화나 범위 변경 후
완료하더라도 해당 호출에 귀속되어 실행한다. 중첩 호출은 현재 범위의 모든 호출이
끝날 때까지 `loading`을 유지하고, 마지막 호출만 data/error를 갱신한다.

`useEvent`는 동기·비동기 구독 해제 등록을 지원한다. 이벤트·구독자 교체 또는 언마운트 시
이전 구독의 전달을 즉시 차단하며, 늦게 도착한 정리 함수는 한 번 실행한다.

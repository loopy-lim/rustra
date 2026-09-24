---
'@rustra/cli': minor
---

M9(호스트 엔트리 계약 검증 옵션 기본값 정합화)과 S1(코드젠 타입명 정화)을 적용한다.
두 항목 모두 코드젠 **생성기** 변경이며, 버전이 올라가는 npm 패키지는
`@rustra/cli`뿐이다. Rust 크레이트 `rustra`(매크로 측 시그니처 정화)도 함께
바뀌었지만 changesets 관리 대상이 아니므로 워크스페이스 Cargo 버전으로 올린다.

**무엇이 바뀌었나** — `rustra codegen`/`generate`가 생성하는 4개 호스트
엔트리(node/bun/tauri/react-native)가 동일한 계약 검증 기본값과 옵션명을
명시하고, 명령 시그니처가 Rust 내부 타입명 누출(`String`, `int32`,
`Tuple_of_*` 등) 대신 인라인 타입으로 렌더링된다. 생성 `commands.ts`에는
호출 규약 혼재(positional vs struct) 안내 헤더, `InvokeOptions` 로컬 alias,
얕은 취소(shallow cancellation)·retryable 재실행 비안전 경고 JSDoc이 추가된다.

**기본값 정합** — 어댑터 런타임 기본값이 달라진 플랫폼은 없다(미설정은 원래
`'strict'`와 동일). 달라진 것은 생성 엔트리의 명시 여부다: 재생성하면
react-native 엔트리에 `contractVerification: 'strict'`가 명시적으로 추가되고
(이전에는 생략), node·bun은 기존 명시를 유지한다. tauri는 JSON 엔진 경로라
`contractVerification`/`schemaVersion` 옵션을 받지 않으며 계약 드리프트는
네이티브 `rustra_dispatch` 실행 오류로 표면화된다. 옵션명 변경·제거는 없다.

**마이그레이션** — 기존에 커밋된 generated 파일은 그대로 동작하고, 재생성해도
정화된 시그니처 타입은 기존 alias와 동일한 타입(`type int32 = number` 등)이라
소스 호환이다. 다음 경우에만 손이 간다: (1) generated 아티팩트를 체크인하는
저장소는 CLI 업그레이드 후 `rustra codegen` 재실행으로 생성물을 갱신하고
`rustra codegen --check`로 드리프트를 해소해야 한다. (2) deprecated
alias(`int32`, `String`, `Tuple_of_int32_and_int32` 등)를 타입 import로 직접
쓰던 코드는 계속 컴파일되지만 `@deprecated` 경고가 뜬다 — 특히 `String`은 JS
내장 타입과 충돌하므로 직접 import를 피하고, 명령 시그니처의 인라인 타입
(`number`, `string`, `[number, number]`)이나 자체 도메인 타입으로 교체한다.
(3) `contractVerification`을 `'warn'`/`'off'`로 바꿔 쓰는 OTA 롤백 등 의도적
드리프트 운영은 재생성된 엔트리의 해당 한 줄에서 그대로 설정한다.

**deprecated alias 유지 범위** — schemars 원시/합성 이름 집합(`String`,
`Boolean`, `int8`–`int128`/`uint8`–`uint128`, `float`, `double`, `Uuid`,
`Tuple_of_*`, `Array_of_*`, `Array_size_*`, `Set_of_*`, `Map_of_*`,
`Nullable_*`, `Result_of_*`, `Bound_of_*`, `Range_of_*`, `Either_*` 계열)에
해당하는 기존 export는 types.ts에 `@deprecated` JSDoc과 함께 유지된다. 제거는
별도 major 릴리스에서만 검토한다.

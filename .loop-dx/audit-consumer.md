# 컨슈머(라이브러리 소비자) 관점 API/문서 DX 감사 — rustra-bridge

- 작업: `audit-consumer` (kind=research)
- 관점: Rust 패키지를 정의하고 생성된 TS 클라이언트를 소비하는 앱 개발자
- 근거 범위: `examples/calculator`, `examples/crud`, `packages/{types,react,react-native,tauri}`, `docs/compatibility-matrix.md`, `docs/function-registration.md`, `docs/getting-started.md`, `docs/README.md`, `api-surface/`, `typedoc.json`
- 심각도: **상**(소비자가 잘못된 분기/에러 처리를 하거나 첫 성공까지 못 감) / **중**(추가 학습·우회 비용) / **하(低)**(품질 신호, 낮은 마찰)

---

## 1. 타입 추론 / 에러 처리 인체공학

### 1.1 [상] `engine.supports` 값이 호환성 매트릭스 셀과 표면상 모순 (events/channels)

`docs/compatibility-matrix.md:120-124`는 `supports` 객체를 "this matrix's cells transcribed 1:1 — no new claims"라고 선언한다. 그러나:

- `supports` 테이블(L128): RN JSON `events: 'none'` — 반면 같은 문서 매트릭스 본문(L27)은 `createReactNativeEngine` 열의 Events 셀이 "✅ JSI sink push; `pollMs` option adds a JS polling-drain loop"이다.
- `supports` 테이블(L129): Node/Bun/Tauri `channels: false` — 반면 매트릭스 본문(L27-28)은 Node "✅ `createNodeChannel(transport, cb)` — loop-stdio reservation frames", Tauri "✅ `createChannel(cb)`"이다.

즉 `supports`는 **엔진 팩토리 기준**이고 매트릭스 행은 **어댑터/transport 기준**인데, 이 구분이 소비자에게 노출되지 않는다. Node 컨슈머가 `engine.supports?.channels === false`를 보고 채널을 포기하면, 실제로는 loop-stdio 바이너리 transport에서 `createNodeChannel`이 동작하므로 잘못된 분기를 한다. 문서 스스로의 "1:1 transcription" 주장과 충돌하므로, 게이트 분기의 신뢰 자체가 흔들린다.

**개선 제안**: `supports` 테이블에 "engine-level 한정. transport-level API(`createNodeChannel` 등)는 본문 행 참조" 각주를 명시하거나, `channels`/`events`를 engine 값과 host API 값으로 분리 표기.

### 1.2 [상] Rust 내부 타입명이 생성 TS 표면으로 누출 + 호출 규약 혼재

`examples/calculator/generated/types.ts`:

- L49 `Tuple_of_int32_and_int32`, L51 `int32`, L185 `Tuple_of_String`, L187 **`export type String = string`**, L255 `Tuple_of_int32`, L303 `Tuple_of_double_and_double`, L305 `double`.
- `commands.ts`(L12-15): `export function add(arg0: Tuple_of_int32_and_int32[0], arg1: ...): Promise<int32>`, `greetPerson(arg0: Tuple_of_String[0]): Promise<String>`.

`String`/`double`/`int32`는 타입 공간에서 안전해도 전역 래퍼 타입과 이름이 겹쳐 가독성을 해치고, `Tuple_of_*`는 코드젠 내부 명명 규칙이 그대로 API 표면이 된다. 또한 **같은 generated 파일 안에서** struct 기반 명령(`addNumbers({ a: 20, b: 22 })`)과 positional 명령(`add(a, b)`)이 혼재한다. `docs/function-registration.md:73-74`는 "Generated parameter names are `arg0`, `arg1`" 한계를 문서화하지만, 소비자는 명령마다 호출 스타일을 외워야 한다.

**개선 제안**: positional 명령에 최소한 타입 별칭 정화(`TupleOfString` → `[string]` 인라인, `String` 예약어 회피)를 적용하고, 두 호출 규약이 섞일 때 생성 헤더에 경고 주석 삽입.

### 1.3 [중] i64 표면 전반의 `number | bigint` 유니언 부담

`examples/calculator/generated/types.ts:54-55`(`a: number | bigint; b: number | bigint`) 등 i64 필드마다 유니언이 강제된다. 안전한 설계이고 `development-hurdles.md` "Rust 타입 경계"에 문서화돼 있으나, 호출부마다 bigint 혼용/정규화를 고민하는 상시 마찰이다. 런타임 좁힘 헬퍼(예: `asNumber()`)가 코드젠에 동반 생성되면 마찰이 줄 것이다.

### 1.4 [중] React `useCommand`가 `InvokeOptions`(signal/timeoutMs)를 전달 불가

`packages/react/src/useCommand.ts:15-18`:

```ts
export interface UseCommandOptions {
  /** If false, query will not run automatically. Default: true */
  enabled?: boolean;
}
```

코어의 `InvokeOptions`(`packages/types/src/public.ts:95-114`)는 `signal`, `timeoutMs`를 제공하는 것이 핵심 계약인데, React 바인딩이 이를 우회할 통로가 없다. 언마운트 시 내부 AbortController는 있지만(`useCommand.ts:32` `abortControllerRef`), 컨슈머가 타임아웃이나 외부 취소 신호를 걸려면 hook을 포기하고 `useEffect`+직접 invoke로 내려가야 한다. 또한 `error: Error | null`(L23)이라 `RustraCommandError` 좁히기(§1.5의 타입 가드)를 catch가 아닌 상태 값에서 수동으로 해야 한다.

### 1.5 [하] 에러 처리 인체공학은 전반적으로 우수 — 단 타입 가드는 옵트인

`RustraCommandError` 단일 `instanceof` 분기, `TimeoutError`/`CancelledError` 서브클래스(`packages/types/src/errors.ts:24-42`), `#[command(error(...))]` 선언 시 명령별 가드 생성(`docs/getting-started.md:1226-1240`, `examples/calculator/generated/errors.ts`의 `isDivideError` 등)은 훌륭하다. 단, 가드는 Rust 측 에러 코드 선언이 있어야 생성되므로 미선언 패키지는 문자열 `code` 비교로 폴백한다. `errors.ts`의 한글 주석(예: "catch 분기용 타입 가드 — 미선언 코드(신규 네이티브 등)는 false")은 국제 컨슈머가 생성 코드에서 마주하는 내용이며, §4.3과 연결된다.

---

## 2. 보일러플레이트 / 어댑터별 초기화

### 2.1 [중] 어댑터별 부트스트랩 옵션 표면이 제각각

생성 호스트 엔트리 4종의 시그니처 비교(`examples/calculator/generated/`):

| 파일                   | 팩토리                   | 주요 옵션                                                                                                      |
| ---------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `node.ts:19-27`        | `createNodeBootstrap`    | `binaryName`, `commandCandidates`, `args`, `contractHash`, **`contractVerification: 'strict'`**                |
| `bun.ts:16-29`         | `createBunBootstrap`     | `libraryName`, `libraryCandidates`, `frameCodecs`, `contractHash`, `contractVerification`, **`schemaVersion`** |
| `tauri.ts:15-16`       | `createTauriBootstrap()` | **인자 없음**                                                                                                  |
| `react-native.ts:9-16` | `createRustraBootstrap`  | `install`, `getNative`, `frameCodecs`, `contractHash`, `schemaVersion` — **`contractVerification` 없음**       |

"zero-config bootstrap per host"(calculator README L59)를 표방하지만, 계약 검증 옵션명과 기본값이 플랫폼마다 달라 "내 플랫폼에서 contract mismatch가 strict인가?"를 판단하려면 어댑터별 소스/문서를 열어봐야 한다. Rust 측도 각각 다르다: node=바이너리+stdio probe, bun=cdylib, tauri=`withGlobalTauri`+`register_with_events`, RN=staticlib+`native_entry!`+모듈 스캐폴딩(`packages/react-native/README.md:8-30`).

### 2.2 [중] crud 예제가 "엔진 없이" 끝난다 — 첫 호출 직전에 수동 공백

`examples/crud/README.md:47-53`:

```ts
import { createItem, getItem, listItems } from './generated/commands.js';

const engine = /* EngineClient */;
const { item } = await createItem(engine, { name: 'Widget', value: 42 });
```

- `rustra.json`(crud)에는 `schema`/`output`만 있고 `node: {}` 같은 호스트 키가 없어 `node.ts` 등 호스트 엔트리가 생성되지 않는다(calculator는 4개 전부 생성).
- `package.json`이 없어 예제 디렉터리 자체가 설치/실행 단위가 아니다.
- 스니펫 자체가 미완성 플레이스홀더이고, `createItem(engine, ...)` 형태는 실제 생성 함수(`createItem(input, options?)`, 전역 엔진 사용)와도 불일치한다 — `examples/crud/generated/commands.ts:14-16` 참조.

calculator는 반대로 완결돼 있다(`import { addNumbers, rustra } from '../generated/node.js'` 후 `rustra.dispose()`). 두 예제의 완성도 격차 때문에, 두 번째 예제(crud)로 넘어온 컨슈머가 정작 부트스트랩을 스스로 조립해야 하는 지점이 된다.

### 2.3 [중] 매크로 경로의 입/출력 래퍼 구조체 보일러플레이트

`examples/crud/src/lib.rs:5-46`: 5개 명령에 입력/출력 구조체 10개 + `#[bridge_type]` 10회. `#[command]`+`build!` 자체는 간결하지만 명령당 2구조체가 관례다. 대안인 `PackageBuilder::function`(`docs/function-registration.md:18-31`)은 래퍼 불필요·0~12 인자 positional이라 마찰이 적으나, 두 저작 모델이 기능 분화돼 있다(RN 네이티브 스칼라 숏컷 미지용 L92-95, async/상태 주입은 매크로 전용 L77). "내 명령은 어느 쪽으로 쓰지?" 결정 비용이 문서 두 곳을 오가게 만든다.

### 2.4 [하] 두 소비 스타일(생성 bootstrap vs 수동 `configure()`)의 공존

calculator는 생성 엔트리 경로(`apps/node-app.ts`)와 수동 경로(`apps/bun-app.ts`의 `createBunEngine`+`configure()`, `apps/react-native-app.ts`의 `createReactNativeEngine`+`configure()`)를 함께 시연한다. README가 "manual `configure()` is only needed when injecting a custom transport"(L104-106)로 정답 경로를 명시한 점은 좋다. 다만 앱 변주가 7종(node/bun/node-napi/bun-ffi/tauri/rn/performance)이라 신규 사용자가 어느 파일이 "정답"인지 탐색해야 한다.

---

## 3. 호환성 매트릭스 — 취소/이벤트/채널 미지원이 주는 혼란

### 3.1 [상] shallow cancellation: API 이름의 기대와 관측의 간극이 산문에만 존재

`options.signal`이라는 이름은 "실행 중단"을 암시하지만, 매트릭스 L23 기준 **Node/Bun/Tauri/RN JSON 전부 shallow**(JS 프라미스만 거부, Rust 실행 계속), RN Frame만 조건부 전파다. 핵심 경고는 문서화돼 있다:

- 매트릭스 L39: "shallow cancellation/timeout ≠ the command did not run ... `retryable: true` therefore means ... never 're-running the command is safe'"
- `packages/types/src/public.ts:92-95`(InvokeOptions JSDoc): "retryable: true ≠ 재실행 안전"

그러나 이 내용은 (a) 매트릭스의 산문 한 절, (b) TS 소스 주석에만 존재하고, **컨슈머가 코드에서 처음 마주하는 지점(생성 `commands.ts`의 `InvokeOptions`, 에디터 툴팁)에는 요약 경고가 없다**. 비멱등 명령을 얕은 취소 뒤 무심코 재시도하는 사고는 이 간극에서 나온다. 채널도 유사하다: Bun은 "JS-thread send only — `threadsafe:false` contract", Node는 NDJSON에서 `channel.unavailable` loud-fail, Tauri는 "issuing physical WebView" 한정(L27-28, L43-47) — 전부 매트릭스 산문 딥다이브를 읽어야 하는 배치다.

### 3.2 [중] 플랫폼 미지원 기능의 발견 가능성

- 이벤트/채널/취소가 어댑터마다 다르게 지원되는데, 런타임 게이트(`engine.supports`)의 모순(§1.1)과 맞물려 "문서를 읽어야만 아는" 상태다.
- UniFFI(Kotlin/Swift)는 취소·배치·이벤트·채널 **전부 미지원**(매트릭스 L183-191, "— Phase 2")인데, 이 사실은 본문 매트릭스 열이 아니라 문서 하단 별도 섹션에 있다. 모바일 네이티브 측 컨슈머가 상단 매트릭스만 보면 TS 어댑터와 동급으로 오해할 여지가 있다.
- Linux "Alpha", 런타임 증거 없는 플랫폼 명시(L99-112)는 정직하고 훌륭하다.

### 3.3 [하] 버전 파편화와 문서 내 하드코딩 버전

`docs/compatibility-matrix.md:57-68`: types 0.12.0 / cli 0.11.3 / rust 0.11.0 / node·bun 0.10.2 / react-native 0.9.2 / tauri 0.9.3 / react 0.8.3 / devtools·testing 0.7.2. 어댑터 독립 릴리스 라인 자체는 정책이지만, `docs/getting-started.md:74-78`이 `bun add @rustra/node@0.10.2` 식의 하드코딩 설치 명령을 제공해 문서가 stale해질수록 구버전을 안내한다. `registry-onboarding.md`의 "compatible host pins"이 보완재지만 소비자는 매 설치마다 매트릭스 표를 대조해야 한다.

---

## 4. 문서 탐색 구조 / ko-en 동기화

### 4.1 [중] 브라우징 가능한 API 레퍼런스 부재

`typedoc.json`이 존재하고(`packages/{types,node,bun,tauri,react-native,react,testing,devtools}/src/index.ts` 엔트리), `package.json:69`에 `docs:api: typedoc` 스크립트가 있으나, **출력 디렉터리 `docs/api/`가 `.gitignore:52`에 있어 커밋·호스팅되지 않는다.** `docs/README.md`의 "Reading Paths"(L9-35)와 30+행 문서 테이블에도 생성 API 레퍼런스 링크가 없다(`api-surface/README.md`는 기여자용 게이트 문서). 결과적으로 소비자의 타입/API 탐색은 저장소 grep 또는 로컬 typedoc 생성에 의존한다. "EngineClient 계약이 정확히 뭐지?"를 문서만으로 닫으려면 `docs/architecture.md` → 소스 (`packages/types/src/public.ts`) 순으로 내려가야 한다.

### 4.2 [중] getting-started의 크기와 목표 간 괴리

`docs/getting-started.md`는 영문 1,329줄이며 L15에서 "within 10 minutes"를 표방한다. 1~3장(init/최소 예제)은 훌륭하지만 이후 타입 매핑·에러·어댑터 선택·모노레포·성능이 단일 파일에 누적되어, 목표 표방과 실제 탐색 부담이 어긋난다. "10분 커서" 별도 퀵스타트 + 심화 절 분리가 필요하다.

### 4.3 [하] ko/en 동기화는 양호 — 단 생성물 주석은 한국어 단일 언어

- `docs/` 대부분의 en/ko 쌍이 같은 날짜에 커밋되고 섹션 구조가 일치한다(예: `compatibility-matrix.md` 309줄 vs `.ko.md` 348줄은 CJK 줄바꿈 특성, 헤더 구조는 동일). 예외: `compatibility-contract.md` en 2026-09-04 vs ko 2026-09-07.
- 반면 **생성 코드와 코어 소스 주석은 한국어가 기본**이다: `examples/calculator/generated/errors.ts`·`types.ts`의 한글 주석, `packages/types/src/public.ts:82-114`(InvokeOptions JSDoc), `packages/types/src/errors.ts`(RustraErrorCode 주석 전체). 영문 문서를 읽는 컨슈머가 생성물/툴팁에서 한글 주석을 마주하는 불일치다.
- `docs/compatibility-matrix.md:74-76`과 `.ko.md:131-133`에 `<!-- release:versions:end -->` 마커가 3연속 중복됨 — 릴리스 자동화 교체 대상 블록 경계가 지저분하다는 품질 신호.

### 4.4 [하] CLI 이중 커맨드 `generate` vs `codegen`의 혼선

`packages/cli/src/cli-main.ts:31-39`는 `generate`(스키마→TS 렌더)와 `codegen`(config 기반 전체 파이프라인)을 모두 제공한다. crud README는 `bun ../../packages/cli/src/index.ts generate --schema ...`(L27, 저장소 내부 경로 직접 실행)를 안내하는 반면, 생성 파일 헤더는 `examples/crud/generated/commands.ts:6` "Regen: rustra codegen --config rustra.json"으로 안내한다. 동일 산출물의 재생성 명령이 README·헤더·calculator README(`rustra codegen`) 간 3천 양단이다.

---

## 요약 — Top 3 불편 포인트

1. **[상] `engine.supports` ↔ 호환성 매트릭스 셀의 표면상 모순(events/channels)** — "1:1 transcription" 선언과 달리 `channels: false`(Node)·`events: 'none'`(RN JSON)이 본문 ✅ 셀과 충돌해, 기능 게이트 분기의 신뢰가 흔들린다. (`docs/compatibility-matrix.md:120-129` vs L27-28)
2. **[상] shallow cancellation의 기대/관측 간극이 생성 표면이 아닌 산문에만 존재** — `signal`이 실제 중단이 아니라 "JS 프라미스만 거부, Rust 실행 계속"이라는 사실이 매트릭스 산문(L39)과 코어 주석에만 있어, 비멱등 명령 무단 재시도 사고의 온상이 된다.
3. **[중] 어댑터별 초기화 계약 비일관 + crud 예제의 엔진 공백** — 4개 생성 엔트리의 옵션명/계약 검증 기본값이 제각각(§2.1)하고, 두 번째 예제 crud는 README 스니펫이 `/* EngineClient */` 플레이스홀더로 끝나(README.md:49) 첫 성공 경로가 calculator에만 존재한다.

## 우선순위 매트릭스 (요약)

| #   | 항목                                                    | 심각도 | 유형     |
| --- | ------------------------------------------------------- | ------ | -------- |
| 1.1 | `supports` ↔ 매트릭스 모순                              | 상     | 문서/API |
| 3.1 | shallow cancellation 경고의 노출 위치                   | 상     | 문서/API |
| 1.2 | Rust 타입명 누출(`String`, `Tuple_of_*`)·호출 규약 혼재 | 상     | 코드젠   |
| 2.1 | 어댑터별 부트스트랩 옵션 비일관                         | 중     | API      |
| 2.2 | crud 예제 미완결(엔진 공백)                             | 중     | 예제     |
| 2.3 | 매크로 경로 래퍼 구조체 보일러플레이트                  | 중     | API      |
| 1.4 | React `useCommand`의 `InvokeOptions` 미전달             | 중     | API      |
| 1.3 | `number \| bigint` 상시 부담                            | 중     | 코드젠   |
| 3.2 | UniFFI 미지원 기능의 발견 가능성                        | 중     | 문서     |
| 3.3 | 버전 파편화 + 하드코딩 버전 문서                        | 하(低) | 문서     |
| 4.1 | 브라우징 가능한 API 레퍼런스 부재                       | 중     | 문서     |
| 4.2 | getting-started 과대                                    | 중     | 문서     |
| 4.3 | ko/en 동기화 양호 / 생성물 한글 주석                    | 하(低) | 문서     |
| 4.4 | `generate` vs `codegen` 혼선                            | 하(低) | 문서/CLI |

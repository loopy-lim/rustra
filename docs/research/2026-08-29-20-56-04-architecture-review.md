---
date: 2026-08-29T20:56:04+09:00
researcher: claude
git_commit: 47de0777d0e94a82168f4776eb19ab971094c7f9
branch: main
repository: rustra
topic: '현재 아키텍처 전수 리뷰 (Rust core · TS packages · CLI codegen · RN native · 품질 신호)'
tags: [research, architecture, review, rust-core, ts-packages, cli-codegen, react-native, tech-debt]
status: complete
last_updated: 2026-08-29
last_updated_by: claude
---

# 리서치: rustra-bridge 현재 아키텍처 전수 리뷰

**날짜**: 2026-08-29T20:56:04+09:00
**연구자**: claude
**Git Commit**: 47de0777d0e94a82168f4776eb19ab971094c7f9
**Branch**: main
**Repository**: rustra (loopy-lim/rustra)

> 이 리뷰는 **작업 트리(미커밋 58파일, +3,558/−1,442) 기준**이다. 미커밋 작업은
> `docs/plans/2026-08-29-developer-hurdle-reduction.md` 플랜의
> "개발 허들 완화" 구현으로, codegen 오케스트레이터·doctor·drift 게이트·dev 워치가
> 하나의 일관된 세트로 진행 중이다. 별도 언급이 없는 한 파일:줄 참조는 작업 트리 상태다.

## 연구 질문

현재 아키텍처에 대해 전수 리뷰하고, 그 결과를 문서로 굽는다.

## 요약 (한눈에 보는 평가)

**총평: 성숙도 대비 규모가 작은(≈42k LOC) 프로젝트치고 구조 규율이 비정상적으로 높다.**
계층 경계가 문서가 아니라 코드 구조로 강제되고(types가 유일 leaf, 어댑터 상호 import 0),
테스트는 적대적(fuzz/proptest/trust-baseline/field-order 드리프트 핀)이며 CI는
Miri·cargo-fuzz·coverage·MSRV·벤치 회귀 게이트·RN 양플랫폼까지 갖추고 있다.
인라인 TODO/FIXME이 사실상 0개다.

리스크는 5개로 수렴한다:

1. **🔴 publish gap (즉시 수정 권장)** — `packages/cli/package.json`의 `files`
   배열에 신규 헬퍼 모듈(`cargo/config/hash/paths/process`)이 없어 다음 npm 발행물이
   깨진다 (`dist/index.js`가 `./cargo.js` 등을 import).
2. **🟠 갓모듈 2개** — `crates/rustra/src/lib.rs` 3,314줄(레지스트리+4종 핸들러+
   코드젠+Tauri), `packages/types/src/index.ts` 2,108줄(계약+싱글턴+엔진+코덱).
3. **🟠 3벌 복제된 abort-race 블록** + JSON 어댑터 래퍼 3중화(미커밋 diff가
   `normalizeRustraError`로 절반은 해소 중).
4. **🟡 고아 API** — `RendererHost`(Lynx 제거 후 프로덕션 소비자 0), legacy
   benchmark FFI 게이트, node 어댑터의 binary/contract-hash 경로 부재.
5. **🟡 문서 드리프트 패턴** — 문서가 코드보다 한 릴리즈 뒤처짐. 미커밋 diff가
   0.4→0.5 드리프트를 수정 중(버전 핀, invokeBatch 매트릭스, codegen 플로우).

## 상세 분석

### 1. 시스템 개요와 계층 구조

```
Rust crates (16.4k LOC)
  crates/rustra         Package/registry, 4종 invoke 경로, rkyv V2 tier, FFI 26심볼
  crates/rustra-macros  #[command] #[bridge_type] register! build! (582줄)

TS packages (20.7k LOC, 9개)
  @rustra/types          유일 leaf: EngineClient·global invoke·rkyv V2 엔진·코덱·에러
  @rustra/{node,bun,tauri,react-native}  thin transport shim (types에만 의존)
  @rustra/{testing,devtools,react}       게이트·관측성·훅 (react는 types만 조합)

RN native (5.1k LOC)
  packages/react-native/native/  핸드라이튼 공유 C++ (JSI 브리지 1,373줄 + postcard hpp)
  examples/*/modules/*/generated/  앱별 생성 코덱 (100% 코드젠, 이름/라이브러리명만 앱별)

CLI (@rustra/cli)
  Rust bin → schema.json → 순수 렌더러 → 바이트비교 쓰기 + sha256 매니페스트
```

핵심 계약 불변식(문서 주장)은 **코드로 검증됐다**: 어댑터 `src/`에서
`@rustra/types` 외 `@rustra/*` import가 전혀 없고, RN은 `globalThis.__rustraNative`,
Tauri는 `window.__TAURI__`를 구조적으로만 만난다. 생성물은 host-specific import가 없다.

### 2. Rust core — 강점

- **freeze 아키텍처가 우아하다**: `build()` 시점에 `frozen = !cfg!(debug_assertions)`
  (`crates/rustra/src/lib.rs:2548`). release는 `FrozenRegistry` 스냅샷으로 무잠금
  invoke, debug는 가변 레지스트리(dev 핫리로드). 같은 바이너리로 dev/prod 동작이 결정된다.
  `grant_capability`만 frozen 상태에서 허용(`lib.rs:1753`) — 퍼미션은 구조 변경이
  아니라는 판단이 정확하다.
- **핸들러 정확히 한 번 보장**이 모든 폴백 경로에서 유지된다: caller-buffer
  probe-cache, async-into 단발 owned 폴백, `EnsureComplete` Drop 가드.
- **4종 핸들러 패밀리**(postcard/into/raw/buffer)가 `build_command` 단일 팩토리에서
  조립되고, tier 게이트는 `js_postcard_codec_supported_with_defs`로 JS 코드젠과 미러링.
- **OTA alias displacement**(`lib.rs:2370-2399`, `lib.rs:2455-2561`): legacy
  command_id 충돌 시 점유 명령을 새 id로 이주시키는 회복 전략 + `debug_assert`
  트립와이어.
- 테스트 13파일 ~131 테스트: `field_order_drift.rs`(F7 재발 방지),
  `trust_baseline_ffi.rs`(패닉/이중 free/핸들러 once), proptest, 동시성.

### 3. Rust core — 결함/부채

- **lib.rs 갓모듈**: 코드젠(`generate_types_ts`/`generate_commands_ts`,
  `lib.rs:2016`/`lib.rs:2081`)은 `codegen.rs`로, Tauri support도 분리 후보.
  복제 헬퍼 `snake_to_lower_camel`이 `crates/rustra/src/codegen.rs:284`와
  `crates/rustra-macros/src/lib.rs:561`에 2벌(관례로만 동기화).
- **core→FFI 역방향 의존**: `build_command`가 `crate::ffi::max_payload_bytes()`를
  호출(`lib.rs:759`, `lib.rs:841`) — 레지스트리 계층이 FFI 계층 상수를 끌어쓴다.
  프로세스 전역 가변 상태이기도 하다.
- **`RendererHost` 고아**(`renderer_host.rs:462줄`): 헤더 스스로 인정 — Lynx 제거
  (PR #16) 후 유일 구현체가 테스트 `MockHost`. public API ~18개 항목이 소비자 0.
- **cross-language 게이트 미러링**: Rust 엔진의 tier 라우팅이 TS CLI 코드젠의
  지원 판정을 복제 — 의도된 계약이지만 JS/Rust 어느 한쪽이 바뀌면 와이어 라우팅이
  조용히 갈라진다(와이어/fuzz 테스트가 부분 방어).
- `raw_output_kind` 미소비(`lib.rs:648-651`, `#[allow(dead_code)]` — 문서화된
  forward-compat 부채), int64 → `number | bigint` 누출(`codegen.rs:69-77`).

### 4. TS packages — 강점과 미커밋 개선

레이어링은 문서보다 낫다. 미커밋 diff가 **횡단 일관성 세트**다:

1. AbortSignal/timeout 통합 — `invokeWithTimeout`이 signal을 처리하고,
   `createRkyvV2Engine.invoke`가 같은 래퍼로 라우팅되도록 `invokeRaw`로 추출.
   취소 시맨틱이 JSON 어댑터와 바이너리 엔진에서 동일해짐.
2. `normalizeRustraError` 신설 — node/bun/tauri에 복붙됐던 3분기 에러 변환 제거.
3. invokeBatch 전 어댑터 완성(per-entry Promise.all) + sync throw → Promise.reject.
4. `subscribeEvent` canonical `(name, cb)` 오버로드(tauri/RN), 신규 RN 채널 API.

각 패키지 테스트가 동반 수정되어 test-only 드리프트 없음.

### 5. TS packages — 핫스팟

- **abort-race 3벌 복제**: `types` tier2 propagate(~~:1858), tier3 propagate(~~:1927),
  `react-native/src/index.ts:334-377`의 `createAsyncEngine` 블록. `raceAbort`/`raceAbortShallow`까지 합치면 4번째 사본. 공유 "async invoke with cancel" 헬퍼면
  ~150줄 감소.
- **JSON 어댑터 래퍼 3중화**: `createNodeEngine`/`createBunEngine`/`createTauriEngine`이
  transport 호출 한 줄 빼고 동일(`packages/node/src/index.ts:60-84`,
  `packages/bun/src/index.ts:63-87`, `packages/tauri/src/index.ts:113-140`) —
  types의 "JSON transport → engine" 컴비네이터 후보.
- **UTF-8 핸드롤 이중화**: `packages/react-native/src/utf8.ts`와
  `packages/types/src/index.ts:1053-1148`가 각자 비공개 구현.
- **버전 스큐**: testing/devtools/react 0.4.1이 `@rustra/types ^0.5.0`에 의존
  (0.x caret의 반올림 함정 — changeset 필요).
- **이벤트 계약 분기**: tauri는 `Promise<unsubscribe>`, RN은 sync unsubscribe +
  WeakMap fan-out. `@rustra/react`의 `useEvent`가 반환 promise를 무시하기 때문에
  tauri `subscribeEvent`의 rejection이 관측되지 않는다
  (`packages/react/src/useEvent.ts:30-35`).
- 마이너: mock이 pre-abort 거부 전에 호출을 기록(`packages/testing/src/index.ts:70`),
  `createChannel`의 `undefined` 반환(구 native) 미검사.

### 6. CLI codegen 파이프라인

구조는 깨끗하다: `rustra.json` → Rust bin(`RUSTRA_SCHEMA_OUT` 우회로로 temp 검증) →
`schema.json` → 순수 렌더러 → 바이트비교 skip 쓰기 + `.rustra-generated.json`
sha256 매니페스트 → fail-closed drift 게이트. 신규 모듈 분해
(`config/cargo/hash/paths/process.ts`)는 doctor·codegen·dev가 같은 파서/선택 정책을
쓰게 만든다. `rustra diff`는
`schema-diff.ts:14-39`에서 `command_removed/field_removed/field_type_changed/
required_field_added`를 breaking으로 분류하고 exit 1 — CI 게이트로 실재한다.

**결함**:

1. 🔴 **publish gap**: `packages/cli/package.json` `files`에
   `dist/cargo.js`, `dist/config.js`, `dist/hash.js`, `dist/paths.js`,
   `dist/process.js` 누락 → 다음 발행물이 런타임에 깨짐. **커밋 전 수정 필요.**
2. 🟠 `autoRebuild()`가 모든 에러를 삼킴(`index.ts:1052-1054`) — 재빌드 실패가
   stale dist로 조용히 진행. 존재 이유를 정확히 상실.
3. 🟠 `runDiff`/`runInit`의 직접 `process.exit(1)`(in-process 테스트 불가) vs
   `runDoctor`의 `process.exitCode` — 일관성 없음.
4. 🟡 legacy `runWatch`(`index.ts:824-859`): dirty 체크 없는 100ms 핸드롤 디바운스,
   dispose 없음 — `createWatchLoop`과 불일치.
5. 🟡 `codegen --check`는 Rust bin이 `RUSTRA_SCHEMA_OUT`을 존중해야 한다는 암묵적
   env 계약(구 bin은 감지하긴 함), `dev`의 schema self-write 억제가 첫 실행 실패 시
   루프 가능, watcher 미-close, CLI 버전 bump마다 전 예제 매니페스트 무효화.
6. 🟡 루트 `doctor.config.json`은 `rustra doctor`와 무관한 react-doctor/deslop
   lint 설정 — 이름 충돌이 혼란 유발.

테스트: `generate.test.ts` 2,280줄 ~70 케이스로 견고. 미커버:
`runCodegen` E2E(RUSTRA_SCHEMA_OUT 플로우), `ensureHostDependencies`의 package.json
변이, `config.ts` 전용 테스트.

### 7. RN native 레이어

팩토링이 좋다: 핸드라이튼 C++는 `packages/react-native/native`에 한 벌(앱별 차이는
shim 3줄 + 생성 코덱 + Rust .a뿐), 와이어는 `[cmd_id u16][postcard]` / 응답
`[ok:1][pad][postcard|err]`로 3면(Rust/TS/C++) 일관. tier 사다리
(Raw→Pos→ById→ByName→JS complex→Tier3 JSON)가 복잡도의 싱크이지만 각 단계가
한국어 주석으로 계약 문서화돼 있다.

**주 유지보수 위험은 C++가 아니라 빌드 오케스트레이션**: podspec/gradle의
상대 `node_modules` 경로 산술 — 모듈 디렉터리이 한 단계 깊어지자 두 예제의
경로가 조용히 깨졌고 미커밋 diff가 그 수정(`../../` → `../../../`)이다.
`react-native-calculator/modules/rustra-jsi`에 2번째 사본이 있어 병렬 수동 수정
필요. 또한 `invokeRkyvV2`라는 이름이 legacy 벤치 게이트와 일반 typed 진입 패밀리를
겹쳐 쓴다 — 문서가 이 뉘앙스를 다루지 않는다.

### 8. examples · CI · 히스토리

- examples 10개가 각기 다른 통합 얼굴(stdio/FFI/napi/Tauri/Expo/bare RN/훅)을 담당 —
  문서 매트릭스와 일치.
- CI 6워크플로: ci.yml 9잡(rust 3-OS 매트릭스, RN 양플랫폼, React Doctor
  warnings-block), bench.yml(10% 회귀 게이트 + 커밋 자동 코멘트), coverage, fuzz,
  miri, release. 1인 프로젝트 기준 비정상적으로 성숙.
- 히스토리: 352 커밋(2026-05-13~08-29), loopy-lim 92%, 버스 팩터 1.
  2026-08-21 성장 기회 서베이(~70 항목)의 perf 3개 항목은 #39/#41/#45로 이미
  착지했음이 커밋 로그로 확인 — **서베이→스펙→플랜→구현 루프가 실제로 돈다**.

### 9. 문서 드리프트

패턴: **문서가 코드보다 정확히 한 릴리즈 웨이브 뒤처진다.** 커밋된 문서는 0.4
2단계 codegen, `@0.4.0` 핀, invokeBatch ❌(실제론 전 어댑터 지원), RN 취소 "✅ 전파"
(실제론 조건부)를 말하고 — 미커밋 diff가 정확히 이것들을 고치고 있다. 즉 드리프트
수정이 이미 진행 중이며, 남는 잔여 이슈는:

- `docs/architecture.md`의 `createReactNativeEngine(transport)` 서술 — 실제
  시그니처는 ArrayBuffer JSI transport이고 표 형식 산문이 API를 뒤처림.
- README `packages/` 트리(README:318-341)에 `devtools`/`react` 기재 확인 필요
  (현재 기준 9패키지).
- `docs/compatibility-matrix.md`의 채널 행 등 diff 이후 재검증.

## 아키텍처 인사이트

1. **"계약의 단일 소유"가 실제로 구현돼 있다**: schema.json이 Rust→TS→C++의 유일한
   진실원이고, contract hash가 3면 런타임 drift를 잡고, `rustra diff`가 breaking
   change를 CI에서 잡는다. 대부분 프로젝트에서 문장으로만 존재하는 원칙이 여기선
   게이트로 존재한다.
2. **계층 위반은 없되 갓모듈이 계층을 압축한다**: 위반 없음의 대가로 lib.rs와
   types/index.ts에 크기가 집중됐다. 분리는 안전하다(어댑터가 조각을 import하지
   않는 구조라 내부 재배치는 API 불변).
3. **복제는 절반쯤 정당화돼 있다**: abort-race 3벌은 플랫폼별 파일 경계 + 공용
   헬퍼 부재의 산물이지만, RN utf8 비공개 복제는 "public API 최소화"라는 의식적
   선택(리서치 에이전트가 관례로 확인). 정당한 절과 게으른 절을 구분해 정리 필요.
4. **드리프트 방지의 핵심 자산은 thoughts/plans + docs/plans(57파일) + 벤치
   영수증**: 결정 이력이 날짜 prefixed 마크다운으로 축적돼 "왜 이렇게 됐는가"가
   항상 추적 가능. 1인 프로젝트의 문서화 모범 사례.
5. **빌드 오케스트레이션이 최약 링크**: RN 상대 경로, `autoRebuild` 삼킴,
   legacy `runWatch` — 세 결함 모두 "생산자와 소비자의 위치 계약"이 코드가 아닌
   관례에 있어서 생김.

## 코드 참조 (리뷰 근거 top 항목)

- `crates/rustra/src/lib.rs:2548` — release freeze at build()
- `crates/rustra/src/lib.rs:759` — core→FFI 역방향 의존 (`max_payload_bytes`)
- `crates/rustra/src/renderer_host.rs:17-25` — 고아 API 자기 인증
- `crates/rustra/src/lib.rs:2016-2221` — 코드젠(TS emitter)의 lib.rs 내 거주
- `packages/types/src/index.ts` — 2,108줄 갓모듈; `:142` normalizeRustraError(신규)
- `packages/react/src/useEvent.ts:30-35` — tauri 구독 rejection 미관츠
- `packages/cli/package.json` — `files` 배열 누락 모듈 (publish gap)
- `packages/cli/src/index.ts:1052-1054` — autoRebuild 에러 삼킴
- `packages/cli/src/schema-diff.ts:14-39` — breaking change 분류기
- `packages/react-native/native/cpp/RustraJSIBridge.cpp:204` — stack-buffer
  typedInvokeTail, handler-exactly-once 재시도
- `examples/react-native-bare-calculator/modules/rustra-bridge/RustraBridge.podspec`
  — 상대 경로 산술(미커밋에서 수정)

## 히스토리 컨텍스트 (thoughts/ 디렉터리)

- `docs/research/2026-08-21-18-50-00-growth-opportunities-survey.md` —
  ~70 성장 기회. release-mode capability freeze 등 6건 결함은 이후 커밋으로
  해소된 것 확인(grant_capability는 이제 frozen에서 허용). perf 항목 3건은
  #39/#41/#45로 착지. **이벤트 표면(Node/Bun/Tauri JS 갭)·온보딩 축은 부분 미해결.**
- `docs/research/2026-08-20-09-55-00-unimplemented-survey.md` — 26건
  전수 구현 완료(feat/unimplemented-closure, 메모리 기록과 일치).
- `docs/plans/2026-08-29-developer-hurdle-reduction.md` — 현재
  미커밋 작업의 설계 근거. 체크박스 미완료 = 작업 진행 중.

## 관련 리서치

- `docs/research/2026-08-21-18-50-00-growth-opportunities-survey.md`
- `docs/research/2026-08-20-09-55-00-unimplemented-survey.md`
- `docs/research/2026-08-19-23-40-00-feasibility-multi-angle.md`

## 미해결 질문 / 후속 조치 권장

1. **publish gap 수정이 최우선** — cli `files` 배열 보완(또는 `dist` glob).
   커밋 전에.
2. abort-race 공유 헬퍼 추출 + JSON 어댑터 컴비네이터화 — types 2,108줄 완화의
   첫 단계로 리스크 낮음.
3. `RendererHost` 제거 또는 `#[doc(hidden)]`화 결정.
4. testing/devtools/react 0.4.1 → 0.5.0 changeset (버전 스큐 해소).
5. `useEvent`의 tauri promise 미관츠 — await 또는 rejection 래핑.
6. C++/gradle/podspec의 `node_modules` 경로 산술을 코드젠이 생성하므로, 생성 시점에
   모듈 깊이를 계산해 하드코딩 제거 — 이번 결함의 재발 방지.
7. 이벤트 표면 통합 계약(types 레벨 subscribeEvent 정규화) — 2026-08-21 서베이의
   "define once, run anywhere 반쪽" 지적과 직결.

## 후속 교차검증 (2026-08-29, 현재 작업 트리)

이 문서의 위 결함 목록을 현재 버전의 소스와 생성 산출물에 다시 대조했다. 버전
필드는 변경하지 않았으며, 릴리스/커밋/푸시는 수행하지 않았다.

### 해결 및 검증 완료

- CLI publish gap: `packages/cli/package.json`의 `files`에 `cargo`, `config`,
  `hash`, `paths`, `process`의 JS/d.ts/map 산출물을 추가했다. `npm pack --dry-run`
  으로 다섯 모듈이 패키지에 포함되는 것을 확인했다.
- `dev --config`: repo-local CLI 탐색을 제거하고 in-process `runCodegen`을
  사용한다. Rust schema 출력은 `RUSTRA_SCHEMA_OUT`을 따르고 동일 바이트 write를
  건너뛰므로 Linux에서 자기 파일을 다시 깨우는 루프를 만들지 않는다.
- watcher/CLI 오케스트레이션: legacy/config 양쪽이 `createWatchLoop`의
  running/queued/dispose 상태기를 공유한다. Linux recursive watch 의존도 제거,
  Cargo metadata realpath 캐시, 공통 config/cargo/process/path/hash 모듈을 적용했다.
- codegen drift: `--check`는 임시 schema 출력으로 Rust bin을 검증하고 작업 트리를
  복원할 필요가 없다. auto-rebuild 실패는 삼키지 않고 실패시키며, `diff`/`init`의
  직접 `process.exit`도 제거했다.
- adapters: JSON 엔진을 공통 combinator로 합쳐 timeout, abort, Promise batch,
  retryable error normalization을 Node/Bun/Tauri에 동일 적용했다. RN/Tauri의
  canonical event signature와 RN channel close 계약, React `useEvent`의 async
  unsubscribe cleanup/rejection 관측도 추가했다.
- Rust/C++: core payload limit을 독립 `limits` 모듈로 분리해 core→FFI 역참조를
  제거했고, 미사용 `raw_output_kind`를 제거했다. tuple C++ decode 회귀 테스트와
  C++ codec compile/run 테스트를 통과시켰다.
- 유지보수/문서: mock pre-abort 기록을 수정하고, `docs/architecture.md`의 RN
  low-level 인자 타입과 README 패키지 트리를 현재 API에 맞췄다.

### 현재 검증 영수증

- `cargo test --workspace`: 전체 workspace 통과.
- TypeScript: `@rustra/types` 110, CLI 107, Bun 11, React 5, testing 11, Node
  소스 테스트 8 통과/4개는 Bun에서 Node 전용 process transport라 skip.
- Node 실제 런타임 테스트: compiled test 12/12 통과.
- React Doctor: 100/100, 이슈 없음.
- 실제 calculator에서 `doctor`, `codegen --check`, 반복 `generate --check` 통과.

### 의도적으로 남긴 경계

- `RendererHost`는 현재 런타임 소비자가 없지만 public Rust API와 mock 계약이므로
  호환성 결정을 하지 않은 채 삭제하지 않았다. 큰 `lib.rs`/`types/index.ts` 분리와
  abort-race 내부 공통화는 동작 결함이 아닌 후속 리팩터링 범위다.
- testing/devtools/react의 기존 버전 스큐는 사용자의 요청에 따라 이번 작업에서
  버전업하지 않았다. 다음 릴리스 작업에서 changeset과 함께 맞춰야 한다.
- Node JSON stdio 프로토콜에는 native contract-hash 질의가 없으므로 generated
  Node entry의 binary 후보 경로는 보강했지만, hash 검증은 `getContractHash`를
  노출하는 native 엔진 범위에 한정된다. stdio 프로토콜에 새 질의를 추가하는 것은
  별도 호환성 변경으로 남긴다.
- 공개 npm registry의 기존 `@rustra/cli@0.5.0` 산출물은 이 작업 트리의 수정과
  별개이며, registry 재발행은 버전업/배포 승인이 있을 때 처리한다.

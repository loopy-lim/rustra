# Dev Tier — 개발 중 동적 표면 설계 (2026-09-08)

상태: 설계 확정(사용자 승인 — "모두 진행"). 구현 계획은 별도 문서
(`2026-09-08-dev-tier.md`). 배경 대화: 개발 중 4가지 정적 벽(커맨드
프로토타이핑 루프·디바이스 토큰 닫힌 카탈로그·느슨한 타입 부재·게이트 의례)을
"개발 중 동적 / 릴리스 정적" 하나의 개념으로 해소한다.

## 문제

1. **커맨드 프로토타이핑 루프** — 신규 명령 실험 한 번에 Rust 수정 →
   `rustra codegen`(cargo 프로브 포함) → 런타임 바이넌 재빌드 → tsc →
   (export 변동 시) api-surface → docs 리전 재생성까지 최대 6단계. 정작
   동적 경로(엔진 이름 기반 `invoke`, `debug_assertions` 런타임 레지스트리,
   live schema commandId 조회, Tier 3 JSON 폴백 — `rkyv-engine-async.ts`가
   전부 갖춤)는 명명된 표면·문서가 없어 저작 경로로 인식되지 않는다.
2. **디바이스 토큰 이중 하드코딩 + 닫힘** — 카탈로그 21종이 Rust
   `DeviceCapability::ALL`(`device_capabilities.rs:43-65`)과 CLI 수동 미러
   (`generate-devices.ts:23-45`, "주석이 유일한 연결 고리") 양쪽에 박혀
   있다. 카탈로그 밖 토큰은 등록 시점 패닉 — 앱 개발자는 rustra 릴리스가
   나오기 전까지 신규 역량 토큰을 선언으로 실험할 수 없다.
3. **느슨한 타입 표면 부재** — 생성 클라이언트(타입화 함수)가 유일한 공식
   호출 경로. 문자열 키 즉석 호출은 엔진 메서드로는 존재하지만 문서화된
   프로토타이핑 경로가 아니다.
4. **게이트 의례** — 개발 중에도 풀 배터리(docs:sync·api-surface·codegen
   체크)를 도는 관례. 빠른 루프용 프로파일 스크립트이 없다.

## 개요 결정 5줄

1. **`invokeLoose` 명명 표면**(`packages/types`) — 엔진 이름 기반
   `invoke`의 공식 저작 경로 승격. 새 매커니즘이 아니라 명명·문서화다
   (엔진의 정적 코덱→동적 바이너리→Tier 3 폴백 체인을 그대로 탄다).
2. **카탈로그 스키마 단일소싱** — schema.json 최상위 `deviceCapabilities`
   필드로 Rust 카탈로그를 실어 보내고 CLI 수동 미러를 삭제한다(선언이
   있는 패키지에만 기록 — 선언 없는 패키지의 schema.json/계약 해시 불변).
3. **debug 빌드 토큰 관대화** — 미지 토큰 패닉은 debug 빌드에서 eprintln
   경고+수용으로, release 빌드에서 패닉 유지. 코드젠은 미지 토큰을 유니언
   리터럴로 렌더(마커 주석 포함). fail-closed 폐기가 아니라 **검증 지점
   이동**: doctor 신규 검사 `codegen.device_catalog`가 릴리스 벽이 된다.
4. **게이트 프로파일** — 루트 `test:fast`(cargo check + calculator tsc +
   cli 유닛) 신설. 풀 배터리는 CI/PR 그대로 — 의례 제거가 아니라 개발
   루프 분리.
5. **승격은 이중 벽** — doctor 검사(JS 쪽) + release 빌드 패닉(Rust 쪽).
   live 덤프 → `#[command]` 스캐폴딩(`codegen --from-live`)은 범위 밖
   후속 슬라이스.

접근법 후보 3종(우회로 각개격파 / 통합 Dev Tier / 동적 우선 저작) 중 통합
Dev Tier를 선택 — A13 서브셋 설계(`registry.commands` 옵트인 + Tier 3 자동
폴백)와 같은 방향이고 동적 인프라가 이미 번들에 존재해 추가 런타임 비용이
0이다. 동적 우선 저작은 버전닝된 닫힌 계약 철학과 충돌해 기각.

## A. `invokeLoose` 표면 (packages/types)

```ts
export function invokeLoose<T = unknown>(
  client: EngineClient,
  command: string,
  args?: unknown,
  options?: InvokeOptions,
): Promise<T>;
```

- **순수 위임** — `client.invoke(command, args, options)`만 호출. 엔진이
  정적 코덱 fast-path / live schema commandId 조회 / Tier 3 JSON 폴백을
  이미 판정한다(`rkyv-engine-async.ts` 전체, json 엔진은 JSON 경로).
  반환 타입 기본값 `unknown` — 호출자가 좁힌다.
- **`EngineClient` shape 수용** — 최소 요구가 `invoke` 하나이므로 모든
  호스트 엔진·글로벌 `configure({ invoke })` 클라이언트에 그대로 쓸 수
  있다. 새 파일 `invoke-loose.ts` + `index.ts` re-export.
- **프로토타이핑 루프** — Rust 핸들러를 `Package::register`(debug 빌드
  런타임 등록) 또는 매크로로 추가 → `cargo build` → JS에서 곧장
  `invokeLoose`. 코드젱·tsc·api-surface 불필요(live schema가 commandId를
  제공). 정적 승격은 평소처럼 `rustra codegen`.
- debug 이벤트(`RustraDebugEvent`)는 v1에서 붙이지 않는다 — transport
  필드가 필수라 와이어 프레임이 아닌 loose 호출에는 맞는 값이 없고,
  엔진 수준 진단은 이미 존재한다(YAGNI).

## B. 카탈로그 스키마 단일소싱

- **Rust**(`package_schema.rs::schema`) — 어느 명령이든
  `device_requirements`가 비지 않은 패키지에 한해 최상위
  `"deviceCapabilities"` 기록: `DeviceCapability::ALL`의 토큰 배열
  (카탈로그 선언 순). events 섹션과 같은 조건부 기록 관례 — 선언 없는
  패키지의 schema.json/계약 해시는 바이트 불변.
- **CLI**(`schema.ts`) — `PackageSchema.deviceCapabilities?: string[]`
  타입 추가.
- **렌더러**(`generate-devices.ts`) — `DEVICE_CAPABILITY_CATALOG` 수동
  미러·`CATALOG_ORDER`를 삭제하고 스키마 카탈로그로 정렬·검증한다.
  미지 토큰(선언에는 있고 카탈로그에는 없는)은 throw 대신 렌더 대상이
  된다(§C). 카탈로그 필드가 없는데 선언이 있으면(구버전 rustra 스키마)
  재생성 안내와 함께 throw — fail-closed.
- **계약 해시 영향** — 선언 있는 패키지(calculator)는 schema.json이
  바뀌므로 `GENERATED_CONTRACT_HASH`가 갱신된다. 코드젱이 양쪽(스키마와
  생성물)을 함께 재생성하므로 드리프트 없다. additive 변경.

## C. debug 관대화 + 릴리스 벽

- **Rust 빌더**(`builder_devices.rs::command_devices`) — 미지 토큰 판정을
  프로파일로 분기:
  - `#[cfg(debug_assertions)]`: eprintln 경고(관례: `rustra: …`,
    `ffi_event_entries.rs:104` 참고) 후 수용 — 선언이 스키마로 흐른다.
  - `#[cfg(not(debug_assertions))]`: 현행 패닉 유지 — 릴리스 바이너리의
    계약 벽.
  - 나머지 패닉 조건(미등록 명령/빈 슬라이스/중복)은 프로파일 무관 불변.
- **렌더러** — 미지 토큰을 유니언·`{FN}_DEVICES` 상수에 포함한다. 순서는
  카탈록 순(known) 뒤 미지 토큰 알파벳순 — 선언 순서와 무관한 결정적
  출력. 유니언 뒤 마커 주석 1줄: 미지 토큰 목록 + "debug 빌드에서만
  등록 가능, doctor가 릴리스 검사에서 보고" 안내. **카탈로그 내 토큰만
  있는 패키지의 devices.ts는 바이트 불변**(마커는 미지 토큰이 있을 때만).
- **doctor**(`doctor-checks.ts`) — 신규 검사 `codegen.device_catalog`:
  - schema.json을 읽어 선언 토큰(각 commands[].devices)이
    `deviceCapabilities` 안에 있으면 **pass**.
  - 미지 토큰이 있으면 **fail**(required) — 토큰 목록과 안내(카탈로그
    토큰으로 교체하거나 rustra 카탈로그 확장).
  - 선언은 있는데 카탈로그 필드가 없으면(구버전 스키마) **warn** — 현행
    rustra로 재생성 안내.
  - 선언 자체가 없으면 **skip**(검사 부재와 의도된 스킵 구별 — 기존
    관례). schema.json 부재는 기존 `codegen.schema_output` warn이 이미
    담당하므로 중복 보고하지 않는다.

## D. 게이트 프로파일

- 루트 `package.json` 신규 스크립트:
  `"test:fast": "cargo check --workspace -q && tsc -p examples/calculator/tsconfig.json && bun run --cwd packages/cli test"`
- 의미: 언어 양쪽 컴파일 정합 + 코드젠 렌더러·doctor 유닛(cli). Rust
  동작 검증은 `cargo test -p rustra <필터>`로 ad-hoc. 문서 위치: 새
  dev-tier 가이드(§E)에 "빠른 루프 vs 풀 배터리" 표.
- CI(`ci-gate.sh`)·pre-commit(lefthook) 무변경 — 풀 배터리가 PR/발행
  게이트로 그대로 남는다.

## E. 문서

- 신규 가이드 `docs/dev-tier.md` + `docs/dev-tier.ko.md`(미러):
  - `invokeLoose` 프로토타이핑 루프(정적 승격 시점 포함)
  - debug 빌드 미지 토큰 실험 + doctor 릴리스 검사 + release 패닉 벽
  - `test:fast` vs 풀 배터리
- 인덱스 등록: `docs/README.md`/`README.ko.md` Reading Paths + Full
  Document List. getting-started의 devices.ts 인용 리전은
  devices.ts 바이트 불변이므로 무변경(재생성 후 게이트로 확인).

## F. 테스트

- **Rust**(`builder_devices_tests.rs`, `package_schema` 스키마 테스트):
  - debug: 미지 토큰 수용(경고 출력과 함께 device_requirements 기록)
    `#[cfg(debug_assertions)]` / release 패닉 유지
    `#[cfg(not(debug_assertions))]`(기존 should_panic 테스트를 프로파일
    분기로 이동).
  - schema: 선언 있으면 `deviceCapabilities` = ALL 21종 / 없으면
    미기록(바이트 불변 테스트 갱신).
- **cli**: generate.test.ts — 스키마 카탈로그 소싱 렌더 골든, 미지 토큰
  렌더+마커, 카탈로그 부재 throw. doctor.test.ts —
  `codegen.device_catalog` 4케이스(pass/fail/warn/skip).
- **types**: invoke-loose 유닛(위임·unknown 기본 반환). **예제 e2e**:
  calculator `ts/loose-invoke.test.ts` — 글로벌 configure 클라이언트로
  invokeLoose 호출 회로.
- **api-surface**: `invokeLoose` export 추가 → `--update`.
- 전체 게이트 배터리(fmt/clippy/cargo test/umbrella test/ts:node/
  ts:bun/architecture/api-surface/docs/onboarding).

## G. 명시적 범위 밖

- `codegen --from-live` 스캐폴딩(live 덤프 → `#[command]` 골격) — 후속
  슬라이스.
- `RustraDebugEvent`에 loose 호출 이벤트 추가 — transport 필드 의미론
  정리가 선행되어야 한다.
- pre-push 훅 신설 — codegen:check가 cargo 프로브를 돌려 pre-push에
  무겁다. CI가 드리프트를 잡는다.
- RN 예제(bare-calculator)의 카탈로그 채택 — 디바이스 선언이 없어
  관찰 가능한 변화가 없다.
- A13 `registry.commands` 서브셋 — 별도 확정 트랙(상호작용 없음, 같은
  Tier 3 방향).

## changeset

minor 후보(@rustra/types 신규 export, cli 코드젱 입력 스키마 확장) —
**생성은 사용자 승인 게이트**(관례: 계획서에 초안만).

- `@rustra/types`: minor — `invokeLoose` 추가
- `@rustra/cli`: minor — 스키마 `deviceCapabilities` 소싱, 미지 토큰
  렌더, doctor 검사, `test:fast`
- `rustra`(crate): 카탈로그 스키마 기록 + debug 관대화 — crates.io
  발행은 changeset과 별개 절차(사용자 게이트).

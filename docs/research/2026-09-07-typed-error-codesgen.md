# 커맨드별 타입화 에러 코드젠 — 리서치 (2026-09-07)

상태: complete. 조사 방법 — `.worktrees/integrate`(feat/integrate-1.0-track) 워크트리의
코드/테스트/생성물 직접 확인. 모든 `file:line` 근거는 해당 워크트리 기준(경로는
저장소 루트 상대). 확인되지 않은 사항은 "미확인"으로 명시.

## 해결하려는 격차

`docs/research/2026-09-07-competitive-landscape.md` 격차 Top 10 중 #2 (같은 문서 41행):

> **커맨드별 타입화 에러 코드젠** — 경쟁 대부분이 에러를 타입으로 노출, rustra 는
> 제네릭 `{code,message}` → string 비교 분기. 구현 비용 대비 가치 최고.

비교표(DX · 에러 타입화 행, 같은 문서 15행)도 동일 지적: UniFFI는 "enum → 각 언어
예외 생성", FRB는 "Dart 타입화 예외", napi-rs는 "`napi::Error` + cause 체인"인 반면
rustra는 제네릭 `RustraCommandError{code,message}`. 종합 권장(67–69행)도 타입화
에러를 다음 안정화 트랙 1순위로 지목한다.

## 1. Rust 에러 흐름 전수

### 1.1 RustraError 구조와 코드 테이블

- 구조체: `RustraError { code: &'static str, message: String, retryable: bool }` —
  `crates/rustra/src/error.rs:36-42`. `retryable`은 직렬화 조건부(
  `skip_serializing_if = "is_false"`, error.rs:40-46).
- 빌트인 팩토리와 코드: `command.not_found`(error.rs:50),
  `command.invalid_args`(error.rs:60), `internal`(error.rs:69),
  `capability.denied`(error.rs:93), `platform.unavailable`(error.rs:106),
  `payload.too_large`(error.rs:128), `transport.error`(retryable, error.rs:147),
  `transport.timeout`(retryable, error.rs:155), `cancelled`(retryable,
  error.rs:166). 사용자 정의는 `RustraError::custom(code, message)`(error.rs:80) —
  `code`는 `&'static str`이고 "도메인 점 표기법을 권장"(error.rs:79).
- `Display`는 평탄화 `"{code}: {message}"`(error.rs:185-189) — JSON 폴백 경로에서
  이 문자열이 그대로 흘러간다(1.4 참고).

### 1.2 핸들러가 에러를 반환하는 경로

- 핸들러 계약: `Command.invoke: Arc<dyn Fn(Value) -> crate::Result<Value>>`
  (`crates/rustra/src/command_types.rs:9`). typed postcard fast path는
  `rkyv_v2_handler: Option<BinHandler>`(command_types.rs:11), caller-buffer는
  `rkyv_v2_into_handler`(command_types.rs:13).
- JSON 경로: `invoke_json_command` — capability 게이트 후 `(command.invoke)(params)`
  (`crates/rustra/src/package_json.rs:35-40`).
- rkyv V2 경로: capability 게이트 → `catch_unwind` panic guard → typed 핸들러 또는
  decode→invoke→encode 폴백(`crates/rustra/src/invoke_dispatch.rs:3-40`). 핸들러
  패닉은 `RustraError::internal("panic in handler: …")`로 정규화된다
  (invoke_dispatch.rs:35-38, 98-103). panic guard가 필요한 이유는 FFI 진입점이
  `extern "C"`(nounwind)이어서 언와인드가 경계에서 abort 되기 때문
  (invoke_dispatch.rs:10-15).
- 계산기 예제의 실례: `divide`는 `b == 0`일 때
  `RustraError::custom("math.divide_by_zero", "cannot divide by zero")` 반환
  (`examples/calculator/src/lib.rs:256-267`). 같은 파일의 resource 계열은
  `"resource.not_found"`를 쓴다(lib.rs:1108, 1136).

### 1.3 와이어상 에러 프레임 인코딩 — 코드는 어떻게 직렬되는가

- `encode_rkyv_v2_error(&RustraError) -> Vec<u8>`
  (`crates/rustra/src/rkyv_error.rs:23-47`). 프레임 형식:
  `[ok: u8 @0 = 0][pad 7B][err_len: u16 @8 LE][postcard({code, message}) @10...]`
  (rkyv_error.rs:12-17).
- 페이로드는 `RustraErrorWire { code, message }`를 postcard 직렬화
  (rkyv_error.rs:6-10, 29). **`retryable` 플래그는 와이어에 없다** — TS가
  `isRetryableCode`로 코드에서 도출한다(`packages/types/src/errors.ts:117-123`의
  주석도 이 사실을 명시).
- 65535바이트 초과 시 "…(truncated)" 마커로 재구성(rkyv_error.rs:33-40).
- 왕복 증명 테스트: `test_rkyv_v2_divide_by_zero_typed_error` — command_id 10
  프레임을 직접 만들어 에러 와이어의 `code == "math.divide_by_zero"`를 단언
  (examples/calculator/src/lib.rs:1816-1844).
- OK 프레임 인코더(`rkyv_response.rs:14-163`)와 에러 프레임은 `ok` 바이트로
  구분된다(에러 프레임 buf[0]=0, rkyv_error.rs:43).

### 1.4 FFI 경계에서의 에러 전달

- **JSON FFI**: `FfiResponse { ok: false, error: Some(e.to_string()) }` —
  `RustraError`의 Display 평탄화 문자열이 그대로 실린다
  (`crates/rustra/src/ffi_dispatch.rs:61`). 패닉도 같은 형태로 정규화
  (ffi_dispatch.rs:44).
- **버퍼/typed FFI**: payload 초과는 `payload_too_large`
  (`crates/rustra/src/ffi_buffer_entries.rs:5,123`;
  `ffi_typed_async.rs:25,123`), 패닉은 `encode_rkyv_v2_error(internal(...))`로
  이진 프레임 복귀(`crates/rustra/src/ffi_typed_buffer.rs:79,113`), 미등록은
  `"ffi.not_registered"` custom 코드(ffi_typed_buffer.rs:70,106).

**요약**: 모든 경로에서 `code` 문자열은 손실 없이 JS까지 도달한다. 이진 경로는
구조화된 `{code, message}`(postcard), JSON 폴백 경로는 `"{code}: {message}"
` 문자열을 TS가 재분할(`parseRustraErrorString`, errors.ts:54-76). 즉 타입화
에러의 **런타임 전제 조건은 이미 갖춰져 있고**, 없는 것은 "이 커맨드가 어떤 코드를
반환할 수 있는가"라는 **선언/코드젠 표면**뿐이다.

## 2. 빌더/스키마 표면 — 현재 에러 관련 표면은 없다

- `Command` 구조체 필드 전수(`crates/rustra/src/command_types.rs:1-35`):
  command_id, description, input/output 타입·스키마, definitions, 핸들러 4종,
  raw_input_kinds, decode/encode, tier3 플래그, `required_capability`(command_types.rs:29),
  `platforms`(command_types.rs:34). **에러 선언 필드는 존재하지 않는다.**
- 스키마 엔트리 `command_schema_entry`(`crates/rustra/src/package_schema.rs:146-187`):
  항상 기록되는 name/commandId/inputType/outputType/inputSchema/outputSchema +
  **조건부 필드** platforms(비었으면 미기록, package_schema.rs:161-169),
  description(:170-175), definitions(:177-185). 조건부 관례 덕에 선언 없는 기존
  패키지의 계약 해시는 불변이다.
- 실측 확인: `examples/calculator/generated/schema.json`의 `divide` 항목 키는
  `['commandId','inputSchema','inputType','name','outputSchema','outputType']`
  뿐 — 에러 정보 없음.
- `command_wire_signature`(핫 리로드 와이어 서명)은 스키마 엔트리 JSON의 SHA-256
  (package_schema.rs:193-196)이고, 계약 해시도 `schema()` pretty JSON에서 파생
  (package_schema.rs:60-77). 따라서 **에러 선언 추가는 계약 해시·와이어 서명 변경을
  수반한다** — capability/platforms 필드 추가와 동일한 종류의 (의도된) 계약 진화다.

### 2.1 참고 패턴 1 — `platforms` 필드(직전 커밋 계열, 19ea6a19/1990fd5d)

1. `Command.platforms: Vec<Platform>` 필드(command_types.rs:34).
2. 빌더 `platform_command::<I,O>(name, &[Platform])` — 전 플랫폼 등록 +
   `platform.unavailable` 스텁, `platform_command_impl`로 구현 교체, `build()` 시점
   정합 검증 패닉(`crates/rustra/src/builder_platform.rs:32-67, 78-127, 154-168`).
3. 스키마 조건부 삽입(package_schema.rs:161-169).
4. 매크로 `#[command(platform(windows, macos))]` — `CommandAttr.platforms` 파싱
   (`crates/rustra-macros/src/macro_command_support.rs:40-58`), 메타 상수
   `__RUstra_platforms_*` → register!/build! 체인의 `.platform_meta_if(...)`
   (`crates/rustra-macros/src/macro_register.rs:102`, `macro_build.rs:99`;
   구현은 `builder_platform.rs:137-151`).
5. TS 상수 `RustraErrorCode.PlatformUnavailable` 1건
   (`packages/types/src/errors.ts:145-146`).
   **주의(실측)**: `packages/cli/src/schema.ts`의 `CommandSchema` 타입에는 아직
   `platforms` 필드가 없다(schema.ts:13-30) — 즉 Rust→schema.json까지만 흐르고
   TS 코드젠 소비는 아직 없다. "스키마 필드 우선, 코드젠 소비는 다음 슬라이스"가
   이 트랙의 직전 선례다.

### 2.2 참고 패턴 2 — 이벤트 계약(선언→스키마→TS 코드젠 완결 관례)

`PackageBuilder::event::<E>("name")` 선언이 (a) 빌더 상태로 저장
(`crates/rustra/src/package_types.rs:104-106`), (b) schema.json `events` 섹션으로
조건부 출력(package_schema.rs:128-138), (c) CLI가 `generateEventsTs`로 `events.ts`
(타입 + 이름 유니언 + 구독 헬퍼)를 렌더링(`packages/cli/src/generate-surface.ts:36`,
`cli-generate-files.ts:95-96`), (d) **선언이 없으면 파일 자체를 생성하지 않아 기존
프로젝트 재생성을 유발하지 않는다**(generate-surface.ts의 관례 주석,
cli-generate-files.ts:99-101). 에러 코드젠은 이 관례를 그대로 따르는 것이 정합이다.

## 3. TS 측 — errors.ts와 생성 클라이언트의 에러 소비

### 3.1 `packages/types/src/errors.ts` 전수

- `RustraError` 타입 `{code, message, retryable?}`(errors.ts:1-6) — Rust 와이어
  미러.
- `RustraCommandError extends Error` — `code`, `retryable` 필드(errors.ts:8-19).
  전 호스트가 이 클래스(또는 서브클래스)로 정규화한다.
- 전용 서브클래스 `TimeoutError`/`CancelledError`(errors.ts:26-42) — 문자열 비교
  없이 `instanceof` 분기를 만든 **선례**: "코드 매핑은 기존 와이어 값을 그대로
  유지"(errors.ts:24) 원칙으로 추가됐다.
- `parseRustraErrorString`(errors.ts:54-76) — Display 문자열/JSON 재분할. 코드
  토큰 판정 정규식 `/^[a-z][a-z0-9_.]*$/`(errors.ts:71) — 에러 코드 네임스페이스의
  사실상 계약. FFI 수준 평문은 `invoke.failed` 폴백(errors.ts:75).
- `normalizeRustraError`(errors.ts:84-112) — 어댑터/전송 경계 정규화 단일 헬퍼.
- `isRetryableCode`(errors.ts:121-123) — `transport.error`, `transport.timeout`,
  `cancelled` 3코드 하드코딩. 커스텀 코드의 retryable 인스턴스 값은 와이어에서
  유실되므로(1.3) 코드 기반 도출이 유일한 회수 경로다.
- `RustraErrorCode` 상수 레지스트리(errors.ts:138-205) — Rust error.rs 대응 코드 +
  **JS 어댑터 전용 코드**(`sync.unavailable`, `invoke.failed`, `invoke.malformed`,
  `event.unavailable`, `channel.unavailable`, `contract.mismatch`,
  `inspector.*` 등 — 각 주석에 "Rust error.rs 에 대응 값이 없다" 명시).
  `isRustraErrorCode` 타입 가드(errors.ts:210-212).
  이 레지스트리의 존재 이유가 곧 격차의 요약이다: "오타가 컴파일 타임에 안 잡혔다"
  (errors.ts:127-129) → 상수로 해결(범용) — 하지만 **커맨드별** 코드 집합은 여전히
  문자열 리터럴 비교로 남아 있다.

### 3.2 생성 클라이언트는 에러를 어떻게 소비하는가

- 생성된 `commands.ts`의 모든 함수는 `Promise<Output>`만 선언 — throw 타입 정보
  없음(실측 `examples/calculator/generated/commands.ts`, 예: divide :43). TS는
  throws 타이핑이 불가능하므로 타입화는 "catch 후 가드/유니언" 형태가 될 수밖에
  없다.
- 호출자 패턴(전부 문자열 리터럴 비교 — 격차의 실례):
  - `examples/calculator/ts/journey.test.ts:187` —
    `error instanceof RustraCommandError && error.code === 'math.divide_by_zero'`
  - `examples/calculator/ts/payload-robustness.test.ts:75,116` —
    `r.error?.code === 'math.divide_by_zero'`
  - `examples/calculator/ts/cross-wire.test.ts:103` — 동일.
- 공식 문서도 같은 패턴을 가이드: `docs/getting-started.md:1052-1072` — "정확히
  하나의 `instanceof` 분기" + `e.code` 비교. 문자열 비교 체계의 취약성은 문서
  수준에서도 실증된다 — `docs/getting-started.md:1065`(예시 주석)과
  `docs/rust-api-guide.md:510`(`RustraError::custom` 예시)가 실제 예제의 코드
  (`math.divide_by_zero`, examples/calculator/src/lib.rs:259)와 어긋나는 오타 코드
  `"division.by_zero"`를 게시 중이다(실측).
- invoke 계약상 에러 타입: 생성 헬퍼(`invokeGenerated*`,
  `packages/types/src/global-fields.ts:17-101`)는 엔진 dispatch의 throw/reject를
  그대로 전달한다. 미구성 상태 에러도 `RustraCommandError(transport.unavailable)`
  (global-fields.ts:39-44). 즉 **catch 되는 값은 사실상 항상 `RustraCommandError`
  계열** — 타입 가드의 `instanceof` 전제가 성립한다.

### 3.3 엔진/호스트별 에러 승격 지점과 코드 보존

| 호스트/경로                         | 승격 지점                                                                                                                                        | 코드 보존                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| rkyv V2 (Node napi, Tauri, JS 코덱) | `tier2Outcome` — 코덱 decode 후 `ok:false`면 `new RustraCommandError(e.code, e.message, …)` (`packages/types/src/rkyv-engine-contract.ts:12-36`) | 구조적 보존(postcard `{code,message}`)     |
| tier 3 (JSON-in-binary)             | `rkyv-engine-dispatch.ts:104-108`                                                                                                                | 구조적 보존                                |
| 동적/complex 코덱                   | `decodeErrorFrame` (`packages/types/src/schema-postcard-codec.ts:29,80`, `complex-codec-error.ts:5-20`)                                          | 보존(잘림/파손 시 `invoke.malformed` 폴백) |
| JSON 엔진 (Tauri `rustra_dispatch`) | `normalizeRustraError` (`packages/types/src/json-engine.ts:100,104,148`; 라우팅 `packages/tauri/src/index.ts:139`, 배치 항목 `index.ts:153`)     | Display 문자열 재분할로 보존               |
| Node loop-stdio (NDJSON)            | `waiter.reject(parseRustraErrorString(frame.error))` (`packages/node/src/node-loop.ts:558`)                                                      | Display 재분할 보존                        |
| RN (JSON 폴백)                      | `parseRustraErrorString(response.error)` (`packages/react-native/src/react-native-core.ts:91`)                                                   | 동일                                       |
| Mock 엔진 (`@rustra/testing`)       | `MockError` 유니언 → `toMockError`로 `RustraCommandError`화 (`packages/testing/src/index.ts:32-33,108`)                                          | 보존                                       |

**결론**: 어느 호스트에서도 code는 보존된다. 호스트 무변경으로 타입화 에러를
올릴 수 있다.

## 4. 코드젠 파이프라인 — 스키마 필드가 TS 출력으로 흐르는 경로

단일 화살 구조: Rust는 `schema.json`만 발행(`GeneratedPackage::write_schema_to_dir`,
`crates/rustra/src/package_types.rs:150-168`; 구 `write_to_dir`의 TS 직접 생성은
deprecated, package_types.rs:171-198). TS 표면은 `rustra codegen`(packages/cli)이
schema.json에서 렌더링한다.

파이프라인(`packages/cli/src/cli-generate-files.ts:50-110`):

1. `JSON.parse(schema.json)` → `parsePackageSchema`(`schema-validation.ts:77-119`).
   **알 수 없는 필드는 검증 없이 통과**(`return value as PackageSchema`,
   schema-validation.ts:118) — 새 "errors" 필드가 구 CLI에서 조용히 무시되는
   포워드 호환이 이미 구조적으로 보장된다.
2. 파일 배터리: `types.ts`(`generateTypesTs`), `commands.ts`(`generateCommandsTs`,
   `generate-commands.ts:14-91`), `contract.ts`(원문 schemaContent에서 해시),
   `rkyv-codecs.ts`, `rkyv-registry.ts`, `events.ts`(조건부), positional/host
   엔트리, C++ 코덱(cli-generate-files.ts:90-110).
3. 지문 매니페스트 `.rustra-generated.json`(cli-generate-files.ts:149-163) +
   `--check` 드리프트 게이트(:119-125).
4. 렌더링 헬퍼: `tsTypeFromSchema`(union/enum/ref → TS 타입,
   `codegen-schema.ts:5`), `commandFunctionName`(snake→lowerCamel,
   `codegen-definitions.ts:30-47`), `generatedJsDoc`(generate-surface.ts:9).

커맨드 입력/출력과 무관한 새 출력 파일을 조건부로 추가하는 방법은 events.ts가
이미 증명했다(2.2). 코드젠의 코덱/레지스트리/C++ 렌더러는 입력·출력 스키마만
소비하므로 에러 선언이 미치지 않는다(미확인 사항 없음 — generate-postcard*,
generate-cpp*는 command 스키마의 input/output만 읽음을 실측).

## 5. 매크로/작성 경로와 메타데이터 체인

- `#[command]` 속성 키: `name`, `capability`, `platform(...)` — 지원 외 키는 즉시
  컴파일 에러(`macro_command_support.rs:5-13, 60-64`).
- 메타데이터 체인: `#[command]`가 상수(`__RUstra_meta_*`, `__RUstra_cap_*`,
  `__RUstra_platforms_*`, `__RUstra_doc_*`)를 심고(macro_command.rs:296-310
  근처, 실측), `register!`/`build!`가
  `.command(name, fn).command_doc(...).require_capability_if(...).platform_meta_if(...)`
  체인으로 연결(`macro_register.rs:100-102`, `macro_build.rs:97-99`).
  새 에러 선언도 `__RUstra_errors_*` 상수 + `.errors_meta_if(...)` 1개 추가로
  동일 체인에 끼워진다.
- register!/build!는 빌더를 반환하므로(macro_register.rs expanded `#builder
#chain`), 매크로 속성 없이도 `register!(builder, divide).command_errors("divide",
&[…])` 형태로 체인 연결이 가능하다 — 매크로 속성은 편의성(이름 재결합 오타
  방지)이지 필수가 아니다.
- 작성 API 통합 테스트는 `crates/rustra/tests/public_authoring_api_tests.rs`
  (capability/platform 매크로 사례 포함, 실측 91개 test fn), 빌더 단위 테스트는
  `crates/rustra/src/builder_platform_tests.rs`처럼 lib.rs `#[cfg(test)] mod`로
  include(lib.rs:194).

## 6. 게이트/문서 영향 지도

- 전면 게이트(루트 package.json scripts): `bun run test:packages`, `cargo test
-p rustra -p rustra-naming -p rustra-macros`, `cargo clippy --workspace
--all-targets -- -D warnings`, `cargo fmt --all -- --check`, `bun run lint &&
bun run format:check`, `bun run test:docs && bun run test:onboarding`,
  `bun run test:ts:node && bun run test:adapter:tauri`.
- `api-surface/snapshot.json`(`{version, rustModules, ffiExports, macros,
tsExports}` — 실측) — 새 public 심볼(빌더 메서드/타입) 추가 시 스냅샷 갱신
  필요(`bun run test:api-surface`).
- 문서: `docs/rust-api-guide.md`(에러 코드 절 :538 근처, RustraCommandError 재수출
  :675), `docs/getting-started.md`(에러 처리 절 :1040-1072) — 둘 다 `.ko.md` 쌍
  존재 + `docs:sync` 마커 게이트(scripts/docs-gate.mjs:15,31).
  `docs/wire-format.md` — 에러 프레임 형식은 무변경이므로 수정 불필요(명시만).
- changeset: `.changeset/*.md` 관례(실측 예: channel-adapters-4-hosts.md) —
  생성 자체가 이 프로젝트에서 사용자 승인 대상.

## 7. 설계 시사점 요약

1. 런타임(와이어/호스트/정규화)은 이미 코드 보존을 보장 — **변경 불필요, 무변경
   원칙**이 답이다. 새 트랙의 본질은 "선언 표면 + 코드젠"이다.
2. 와이어 에러 프레임은 `{code, message}`뿐이므로 v1 타입화는 **코드 문자열
   리터럴 유니언 + 타입 가드**가 정직한 상한이다. payload 스키마는 와이어 변경
   없이는 거짓 계약이 된다(하지 않는다).
3. `platforms`(조건부 필드 + 빌더 + 매크로 + 정합 패닉)와 `events`(선언→스키마
   섹션→조건부 TS 파일) 두 선례의 조합이 그대로 설계 뼈대가 된다.
4. 포워드 호환은 이미 확보: 구 CLI는 신규 스키마의 모르는 필드를 무시하고(4-1),
   신 CLI는 errors 없는 스키마에서 파일을 만들지 않으면 기존 재생성을 유발하지
   않는다(2.2).
5. 계약 해시/핫리로드 서명은 에러 선언 추가 시 변경된다 — 이는 기존 스키마 진화
   관례(platforms/capability)와 동일하며 `rustra diff`/contract 게이트가 검출
   통로다.

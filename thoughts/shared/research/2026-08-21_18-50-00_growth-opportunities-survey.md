---
date: 2026-08-21T18:50:00+09:00
researcher: claude (loopy 세션)
git_commit: f77c2b864f5c83a342fda2ebf05aabfb110bb41b
branch: main
repository: rustra-bridge (remote: loopy-lim/rustra)
topic: 'v0.2.0 이후 성장 건덕지 전수 조사 — 코어·JS패키지·CI·문서·성능·생태계 6각도'
tags: [research, codebase, growth, roadmap, performance, ecosystem, onboarding]
status: complete
last_updated: 2026-08-21
last_updated_by: claude
---

# 리서치: v0.2.0 이후 성장 건덕지 전수 조사 (6개 병렬 심층 조사)

**날짜**: 2026-08-21T18:50:00+09:00
**연구자**: claude (loopy 세션)
**Git Commit**: f77c2b86
**Branch**: main
**Repository**: rustra-bridge (remote: loopy-lim/rustra)

## 연구 질문

"현재 여기에서 얼마나 더 발전을 시킬 수 있을까? 더 발전할 건덕지를 찾아달라" — PR #29(프로덕션 준비성 감사 수정) 병합 직후, 0.2.0 발행 완료 상태에서 6개 축(코어 크레이트 / JS 패키지 / CI·인프라 / 문서·온보딩 / 성능·벤치 / 생태계·경쟁)의 병렬 심층 조사로 다음 성장 후보를 도출한다.

## 요약

총 **70여 건**의 구체적 건덕지를 확인했다. 현재 상태는 "품질 경영은 성숙, 기능 스펙트럼은 절반, 시장 노출은 0에 수렴"이다.

- **결함 성격의 발견 6건** (PR #29 이후 신규 발견분):
  1. release 빌드에서 `grant_capability`가 영원히 불가능 (capability 시스템 prod 무효) — `lib.rs:1414`
  2. 루트 README 퀵스타트 예제가 컴파일 안 됨 (`add_numbers(a, b) -> i64` — 매크로 계약 위반)
  3. `@rustra/react` useCommand가 `commandFn.name` 의존 — minify 환경에서 파손
  4. useCommand×Node/Bun 엔진 조합이 항상 signal을 전달해 첫 호출부터 `cancel.unsupported` throw
  5. devtools instrumented 엔진이 options(signal/timeoutMs)를 탈락시킴
  6. release.yml 하드코딩 `rustra-macros@0.1.3` 대기 루프 — 이미 무효화 (0.2.0 발행 시 no-op)
- **가장 큰 구조적 건덕지 3축**:
  - **이벤트 표면** — RN에만 완결, Node/Bun/Tauri JS는 공백, 페이로드는 비타입 문자열, 코드젠 없음. "한 번 정의하면 어디서든" 약속의 절반이 여기서 깨짐
  - **비동기** — 커맨드 핸들러가 동기 `Fn` 전용, async invoke는 호출당 `thread::spawn`, `block_on`이 단일 스레드 park (런타임 통합 시 교착 위험)
  - **온보딩/발견성** — README 한국어 단일 언어, crates.io keywords/categories/homepage 전부 미설정, 이슈 템플릿·SECURITY.md 없음, 프리빌트 바이너리 배포 전략 부재
- **성능**: Nitro 격차 1.3x의 잔여 경로가 실측 근거와 함께 식별됨 — caller-buffer rkyv V2 변형 부재, Command clone의 스키마 deep copy (매 invoke!), probe 2회 실행, 코어 이중 HashMap 조회
- **시장 신호**: crates.io 총 98 다운로드, npm 주간 410 — 품질 대비 노출이 극단적으로 낮음. 이것 자체가 최대 건덕지

## 상세 분석

### A. 코어 크레이트 (crates/rustra + rustra-macros) — 20건

#### A-1. release에서 capability 부여 영원히 불가능 [결함, 상]

`build()`가 release에서 `frozen=true`로 시작(`lib.rs:1414`: `AtomicBool::new(!cfg!(debug_assertions))`)하는데 `grant_capability`는 `ensure_mutable()?` 호출(`lib.rs:879-887`). release에서는 `require_capability` 명령에 권한을 부여할 방법이 전혀 없어 deny-by-default가 deny-forever가 됨. Runtime Authority 기능 전체의 prod 사용 불가. 빌더 시점 사전 grant 또는 freeze 예외 필요.

#### A-2. caller-buffer FFI가 임시 Vec 할당 (JSON 변형만 존재, rkyv V2 변형 부재)

`rustra_ffi_invoke_json_into`(`ffi.rs:493-556`)조차 `json_serialize`로 Vec 먼저 만들고 memcpy. 문서와 달리 "Rust는 응답을 할당하지 않고"가 아님. `serde_json::to_writer` + caller 버퍼 io::Write 어댑터로 실제 zero-copy 가능. 더 중요: **핫패스인 rkyv V2 caller-buffer 변형(`invoke_rkyv_v2_into`)은 아예 없음** — JSI typed fast path는 여전히 malloc→memcpy→free 사이클(`RustraJSIBridge.cpp:351`). Nitro 격차 1.3x→1.1x대의 현실적 경로.

#### A-3. caller-buffer size-probe가 핸들러를 2회 실행 [정확성, 상]

probe(buf=null) → write(buf) 2단계에서 각 호출이 `dispatch_json`을 재실행(`ffi.rs:520-556`). 비멱등 핸들러(카운터, 결제)는 사이드 이펙트 2회. probe 결과 캐싱 또는 단일 호출 프로토콜 필요.

#### A-4. 매 invoke마다 Command 스키마 deep copy [성능, 상·쉬움]

`Command`가 `input_schema/output_schema/definitions: serde_json::Value`를 값으로 보유(`lib.rs:493-512`)하고 invoke 시 재진입 방지로 통째 clone-out(`lib.rs:744-753, 795-809`). serde_json Value clone은 트리 전체 복사 — **호출 1회마다 스키마 JSON 전체 재할당**. `Arc<Value>`로 바꾸면 포인터 복사. 핫패스 1줄 개선.

#### A-5. async invoke가 호출당 `std::thread::spawn` (워커 풀/백프레셔 없음)

`ffi.rs:646-655, 690-699`. burst 시 스레드 폭증. 고정 풀 + bounded channel이 정석 후속.

#### A-6. async spawn 실패가 패닉 가드 밖 [안전성]

`std::thread::spawn` 실패 패닉이 `unsafe extern "C"` nounwind 경계를 넘어 abort. sync 경로는 `with_panic_guard`(`ffi.rs:282-301`)로 커버되나 `ffi.rs:627-656, 671-700`은 무방비. catch_unwind + invocation_id 정리 필요.

#### A-7. async가 크기 검사 전에 페이로드 복사

`ffi.rs:640-656, 684-700` — 주석 스스로 "메모리 2배" 인정. `max_payload_bytes()` 선검사로 해결.

#### A-8. `rustra_ffi_free`가 foreign 포인터 헤더를 무조건 역참조 (release)

release에서 가드 컴파일 아웃 후 곧장 `ptr.sub(8)`(`ffi.rs:801-803`). 잘못된 포인터면 할당 경계 밖 읽기(UB). side-table 또는 문서 명시.

#### A-9. 에러 메시지 형식 3종 공존

`"internal: panic — {msg}"`(ffi.rs:297) vs `"panic in handler: {msg}"`(ffi.rs:538, lib.rs:841-844). 호스트 파서가 어긋날 수 있음. 포맷터 통일 + 가드 헬퍼 일반화.

#### A-10. `js_field_supported`의 `$ref` 미검증 [와이어 불일치 위험, 상]

`rkyv_codec.rs:604-612`가 `$ref`를 무조건 struct로 취급(주석 스스로 "단순화" 인정). `$ref`가 map/oneOf를 가리키면 Rust는 typed fast-path를 켜고 JS는 다른 인코딩 → 런타임 디코딩 실패. definitions를 따라가 재검증 필요.

#### A-11. 스키마 구동 Tier 1/2 디코더 지원 협소 + 사실상 레거시화

`wire_kind_from_schema`(`rkyv_codec.rs:440-471`)는 타입 종류가 적고 Option을 전부 Tier 3로 밀어냄. typed postcard 핸들러(2026-08-20 확장)와 지원 범위가 어긋남. retire 또는 패리티 결정 필요.

#### A-12. 코어 ffi.rs에 rkyv V2 FFI 심볼 부재 — 소비자마다 래퍼 복제

`Package::invoke_rkyv_v2`는 코어에 있으나(`lib.rs:786-846`) FFI 심볼이 없어 calculator 예제가 패닉 가드+버퍼 프로토콜을 통째로 재구현(`examples/calculator/src/lib.rs:1093-1210`). 코어 generic 심볼 노출로 보일러플레이트 제거.

#### A-13. `#[command]`에 capability 속성 없음 — 문자열 이름 런타임 패닉

`CommandAttr`은 `name`만 파싱(macros lib.rs:40-57). `.require_capability("locked", "compute:secure")`는 문자열 결합이라 오타 시 런타임 패닉(`lib.rs:1253`). `#[command(capability = "...")]` 속성 추가. A-1과 묶어 1개 PR.

#### A-14. 매크로 에러 메시지 품질 (지원 목록/힌트 부재, trybuild 없음)

macros lib.rs:46-49, 100-120, 151-159. 에러 UI 스냅샷 테스트(trybuild)도 신설 가능.

#### A-15. `bridge_type`이 derive 충돌/serde 조합 미검증

macros lib.rs:386-415. 중복 derive, rename_all 조합, "이 타입은 Tier 3 폴백" 진단 경고 가능.

#### A-16. features가 `tauri` 하나뿐 — 의존 전부 무조건 컴파일

`crates/rustra/Cargo.toml:15-26`. sha2/hex(코드젠 전용), serde_json, postcard를 feature로 분리 가능. 바이너리 크기·컴파일 시간. "rkyv"라는 모듈명이 실제로는 postcard+커스텀 와이어(rkyv 크레이트 부재)인 것도 네이밍 정리 필요.

#### A-17. `block_on` 실행기가 단일 스레드 park — 런타임 통합 시 교착

`executor.rs:21-32`. tokio 컨텍스트에서 워커 굶김, spawn 태스크에서 thread_local state 유실(`state.rs:60-85`). 실행기 주입 훅 또는 제약 문서화. 실제 호스트 대부분이 자체 런타임을 가지므로 중요.

#### A-18. 이벤트 emit 직렬화 실패가 조용히 `"{}"`로

`lib.rs:679-686`. bytes API + 경고 필요. (E-4와 연동)

#### A-19. 에러 body가 u16::MAX에서 조용히 잘림

`rkyv_codec.rs:360-372`. "…(truncated)" 마커 필요.

#### A-20. 테스트 구조 공백 5건

caller-buffer fuzz 부재, caller-buffer×async 조합, Json 기본 디스패치, 이벤트 싱크 병렬 등록, Json/postcard 심볼 혼용 미검증.

### B. JS 패키지 9종 — 19건

#### B-1. useCommand `commandFn.name` 의존 [결함, 치명]

`useCommand.ts:31`, `useMutation.ts:30`, testing `.mock()` 까지. minifier mangling 시 `command.not_found`. 코드젠 산출물의 `commandId` 상수 심는 규약(`fn.commandId`)으로 해결.

#### B-2. useCommand×Node/Bun 엔진 조합 동작 불가 [결함]

훅이 항상 `{signal}` 전달(`useCommand.ts:44`)하는데 node/bun JSON transport는 signal 즉시 throw(`node/index.ts:46-59`). 문서화되지 않은 조합 실패. capability 선언 또는 signal 정책 통일 필요.

#### B-3. devtools가 options 탈락 [결함, 매우 쉬움]

`devtools/index.ts:57-60` — `invoke(command, args?)` 시그니처에 options 파라미터 자체가 없음. 관측 삽입 시 T1 취소/timeoutMs 조용히 소실.

#### B-4. 배치 항목별 취소 미지원 — signal 섞이면 N회 폭탄

`types/index.ts:1040-1072`. `invokeTypedBatchAsync` + 항목별 id + 부분 reject 의미론 필요 (네이티브 동반, 난이도 높음).

#### B-5. byId 배치 — JS측 완료, 네이티브 노출만 남음

`types/index.ts:1057-1063` 분기 구현. C++ `invokeTypedBatchById` 구현만 남음.

#### B-6. typed(tier1) 경로 취소 얕음 — 전파 조건에서 제외

`types/index.ts:929-935`. RN `invokeTypedAsync`는 전파되나 코어 typed 싱크 경로는 아님.

#### B-7. positional facade가 설계 목표 미달

`generate.ts:1369-1447` — 여전히 인자 객체 생성, `invokeTyped` 이름 기반, `Promise.resolve` 래핑, `_options` 무시. byId 전환 + 옵션 배선 + 측정 필요.

#### B-8. postcard 코덱 타입 커버리지 — set_string/set_struct/vec_enum/option_enum/option_vec/Map/tuple 전부 미지원

`generate.ts:182-225`. 미지원 필드 1개면 명령 전체가 Tier 3 JSON 폴백으로 강등. 종류별 기계적 추가, 영향 큼.

#### B-9. TS 타입 매핑 한계 — Date/BigInt/generics 없음

`codegen.ts:59-104`. format 기반 Date 매핑은 쉬움, bigint 와이어는 설계 필요.

#### B-10. 필드 순서 검증 없음 — 알파벳 순 가정 위반 시 조용한 데이터 오염

`cli/index.ts:454-474` 경고만 존재. 라운드트립 테스트 코드 생성 또는 Rust측 순서 해시 검증.

#### B-11. node lazy-respawn — 호출마다 프로세스 재시작

`node/index.ts:79-203`. Rust 예제 main.rs가 요청 1개만 읽고 종료하는 탓. 루프형 stdio 런타임 + persistent 프로세스 + NDJSON 파서. 또한 죽은 `pending` 변수, stdout 전체 JSON 파싱(로그 한 줄에 파괴), 동시 invoke 시 child 덮어써짐 3결함.

#### B-12. `_utf8Encode` number[] 누적 — O(n) 재할당

`types/index.ts:366-388`, `cli/codegen.ts:271-282`. 청크 Writer 또는 TextEncoder 폴백 계층.

#### B-13. React 훅에 캐시/디듀프/Suspense 전무

useSyncExternalStore 미사용, `JSON.stringify(input)` 의존성(순환 참조 throw), in-flight dedupe 없음. TanStack Query 수준은 장기.

#### B-14. mock 엔진 완성도 — invokeBatch/options/waitFor 부재

`testing/index.ts:29-77`. 온보딩 관문 패키지.

#### B-15. contract-gate가 어디에도 연결 안 됨

`testing/contract-gate.ts:9-20` — 순수 함수만 존재, matcher/CLI 짝 없음.

#### B-16. react-native `RustraJSINative` 타입 3중 수동 미러링

`react-native/index.ts:31-65` ↔ `types/index.ts:151-197, 431-471`. 신규 옵션마다 3곳 동기화.

#### B-17. 에러 코드 13종 산재 — 중앙 레지스트리 없음

`types/index.ts:124-126` 하드코딩. `RustraErrorCode` enum + 문서화.

#### B-18. useCommand cleanup 경쟁 — `setLoading(true)` 가드 없음

`useCommand.ts:40-57`. settled ref 패턴.

#### B-19. testing/devtools README 부재 + 패키지 README 전반 소박

npm 공개 패키지 2종이 빈 페이지.

### C. CI/발행/보안 인프라 — 14건

#### C-1. release.yml 하드코딩 버전 [결함]

`release.yml:108` — `cargo info rustra-macros@0.1.3` 대기 루프가 이미 무효화(현재 0.2.0). 다음 발행 시 no-op로 dry-run 실패 가능.

#### C-2. npm provenance 미활성 — 권한은 있는데 안 씀

`release.yml:28`에 `id-token: write` 있는데 env에 `NPM_CONFIG_PROVENANCE` 없음. 1줄 추가로 공급망 증명 확보.

#### C-3. MSRV(1.87) 계약 무검증

`Cargo.toml:39` 선언만. CI 매트릭스에 1.87 레그 추가.

#### C-4. cargo-deny 부재 — 라이선스/밴/중복 검증 없음

deny.toml 없음. MIT 발행물의 법적 위생.

#### C-5. CodeQL/SECURITY.md/CODEOWNERS/이슈 템플릿 전무

`.github/`에 workflows+dependabot만. 취약점 신고 채널 자체가 없음.

#### C-6. napi 경로 CI 미탑재 + 0바이트 index.d.ts + napi 2/3 불일치

`test:runtime:node-napi` 스크립트가 어떤 CI 잡에서도 안 돎. `@napi-rs/cli ^3` vs `napi = "2"` 메이저 불일치. dependabot napi 3.4 PR이 E0433/E0425로 실패 중(방치됨).

#### C-7. miri 부재 — unsafe 95회 FFI 크레이트

`ffi.rs` 1444줄에 unsafe 95회. 야간 cron miri로 UB 조기 발견.

#### C-8. fuzz — 고아 corpus(invoke_postcard 732파일 유령), 시드 없는 CI 실행

`fuzz/Cargo.toml` 타깃 1개(invoke_rkyv_v2)인데 corpus에 삭제된 타깃 파일 잔존. corpus gitignore라 주간 퍼징이 매번 0시드. 시드 corpus git 등록만으로 효율 급상승.

#### C-9. consumer-smoke가 10개 중 2개만 검증

`ci.yml:230-246` — types/node만 npm pack 검사. CLI bin 포함 8종 미검증.

#### C-10. dependabot github-actions 생태계 미포함

액션 10종+ 버전 수동 관리.

#### C-11. bench 회귀 감지 사각지대

`bench.yml:10-14` paths에 JSI/C++/cli 빠짐(최근 최적화 4종의 실제 수정 파일!). PR 비교 없음, baseline 복원 없음, dev 프로파일만.

#### C-12. transport-bench "Rust core 200ns" 하드코딩

`transport-bench.mjs:274`. criterion 결과 주입으로 실측화.

#### C-13. cargo audit 스케줄 없음 — 커밋 사이 신규 RUSTSEC 미탐

cron 3줄 추가.

#### C-14. 브랜치 보호 required checks 수동 계약

`release-procedure.md:52-82`. 동기화 스크립트 여지.

### D. 문서/온보딩/예제 — 12건

#### D-1. 루트 README 퀵스타트 컴파일 불가 [결함, 최우선]

`README.md:43, 124` — `fn add_numbers(a: i64, b: i64) -> i64`는 파라미터 2개 + Result 반환 위반. 복붙하면 즉시 컴파일 에러. 저장소 첫인상이 부서진 상태. 30분 수정.

#### D-2. rust-api-guide 잔여 위반 예제 + doctest CI 게이트 부재

`rust-api-guide.md:496` 잔여 1건. "문서 예제 → cargo check" 게이트가 없어 재발 가능. (2026-08-20 조사의 근본 원인 지적 재확인)

#### D-3. CHANGELOG 0.2.0 엔트리 부재

CHANGELOG 최신이 0.1.3. benchmarks.md 헤더도 "0.1.2 재측정"으로 스테일.

#### D-4. react-native-setup.md Android 서술이 README와 모순

가이드 `:7, :127` "Android not yet implemented" vs README:299 "Stable + Release APK CI". Android 셋업 문서 전면 재작성 필요(코드는 Stable).

#### D-5. reference-app이 예제로서 실사용성 부족

README 없음(9개 예제 중 유일), UI 없음, crud generated 상대 import로 독립 실행 불가.

#### D-6. docs/README.md 색인 누락 4종

rust-api-guide, security-audit, release-procedure, react-native-setup.

#### D-7. 루트 README 배지/비교표/로드맵/FAQ 부재

경쟁 지형 표는 thoughts 연구에만 존재. npm/GitHub 도착 사용자의 평가 근거 부재.

#### D-8. API 레퍼런스 게시 인프라 전무

rustdoc CI 게시 없음, typedoc 설정 자체가 없음.

#### D-9. getting-started "10분" + init 경로 이탈

init 사용자가 §2부터 calculator 예제로 전환돼 흐름 단절.

#### D-10. 예제 README 품질 격차

benchmark(30줄)/crud(48줄)에 기대 출력 없음. rn-calculator 포맷(66줄, 티어 표) 확산 가치.

#### D-11. unimplemented-closure 플랜 체크박스 미폐쇄

WS1~WS8 체크박스 전부 `[ ]` — 상당수 이미 구현됨. 플랜-실제 불일치 자체가 신뢰 부채. (참조 오탈자 `2026-08-35` 포함)

#### D-12. "구현 완료 → 문서 동기화" 강제 장치 없음

이 저장소의 반복 패턴 — 구현은 빠른데 문서 반영이 늦음(benchmarks 헤더, CHANGELOG, RN Android, 플랜 체크박스). 릴리즈 체크리스트에 문서 동기화 항목 강제가 근본 개선.

### E. 생태계/경쟁 — 12건

#### E-1. 이벤트(Rust→JS 푸시) 표면이 RN에만 완결 [최대 구조 갭]

`compatibility-matrix.md:15` — Node/Bun ❌, Tauri는 Rust측 `register_with_events`(`lib.rs:249` → `app.emit("rustra://{name}")`)가 있는데 **JS 구독 API 없음**. `subscribeEvent`는 RN 전용(`react-native/index.ts:345`). "한 번 정의하면 어디서든"의 절반이 깨진 곳.

#### E-2. 이벤트 페이로드가 비타입 문자열 — 이벤트 계약 코드젠 부재

`events.rs:145` `emit(name, payload_json: String)`. 커맨드는 끝까지 타입 안전한데 이벤트는 수동 파싱. schema.json·코드젠에 이벤트 포함으로 해결.

#### E-3. 커맨드 핸들러 동기 전용 — async 핸들러 부재

`lib.rs:501` `Arc<dyn Fn(Value)>`. DB/HTTP I/O 커맨드를 스레드 블로킹으로. napi-rs/Tauri/Crux 모두 해결된 문제. 실서비스 백엔드 사용의 벽. (A-5/A-17과 묶어 "비동기 스토리" 단일 트랙으로.)

#### E-4. 이벤트 버스 drop-oldest 폴링 — 순서 보장 스트림 부재

고정 1024 drop-oldest + 폴링. 백프레셔/역방향 스트리밍 없음. LLM 토큰 스트림 같은 유즈케이스의 품질 결정권.

#### E-5. Windows 매트릭스 행 부재 — 블로커는 소멸한 상태

Lynx 제거로 FML PE 심볼 문제가 사라졌으나 재개 흔적 없음. `ci.yml:31,62`는 core만. Tauri 2등 OS + RN Windows 시장 전체 미개척. 비용대비 효과 좋은 확장 슬롯.

#### E-6. Electron/Deno/WASM 호스트 부재

`adding-host.md:409` Electron은 튜토리얼만. 브라우저/WASM 경로 설계 전무. "같은 코어로 웹까지" 스토리 미완결.

#### E-7. 오픈소스 커뮤니티 인프라 전무

이슈 템플릿/CODE_OF_CONDUCT/SECURITY.md/Discussions/topics 전부 없음. crates.io keywords/categories/homepage 미설정 — 검색 발견성 직결.

#### E-8. 문서 한국어 단일 언어

npm 게시 README도 한국어. 발견의 대부분이 npm/crates 검색인 초기 프로젝트에서 영어 사용자 이탈. 영어 병기(또는 이중 README)가 최저비용 최대효과.

#### E-9. 프리빌트 바이너리 배포 전략 부재

사용자가 직접 cargo 빌드. napi-rs식 per-target 프리빌트 + NPM 아키텍처 매트릭스가 업계 표준. "5분 온보딩"이 실제로는 Rust 툴체인 지식 요구. (B-11 node transport와 묶음)

#### E-10. DevTools가 통계 카운터 수준

110줄 카운터 래퍼. 타임라인/페이로드 검사/내보내기 없음. getLiveSchema·계약 해시·diff 인프라가 있어 확장 토양이 좋음.

#### E-11. invokeBatch가 RN 전용

배치 최적화가 가장 필요한 곳이 JSI만이 아님. Node napi 경로 배치 확장 여지.

#### E-12. 시장 노출이 품질 대비 극단적으로 낮음

crates.io 총 98, npm 주간 410, star 0. 품질(감사·게이트·문서 정직성)은 성숙한데 발견성 투자가 0. E-7/E-8과 함께 "퍼블리시 빅스" 트랙 필요.

### F. 성능/벤치마크 — 8건

#### F-1. 벤치 통계 정밀도 — 아웃라이어/분산/p99 로깅 부재

`transport-bench.mjs:106-124` 트림드 평균 없음. BenchmarkApp은 p99 계산만 하고 로그 누락 — docs 표의 p99 "-" 공백 원인. 모든 성능 논의의 신뢰 기반.

#### F-2. 측정 공백 — 메모리/할당 횟수/콜드스타트/대형 페이로드(JSI)

할당 횟수(global_allocator 카운팅)는 A-2 효과 검증 지표. 1MB 게이트(`ffi.rs:99`) 근처 미측정. 콜드스타트 측정 코드 0건.

#### F-3. 코어 디스패치 이중 HashMap 조회 + 호출당 Arc 클론

`lib.rs:794-809`. u16→핸들러 직접 캐시로 단일 조회화. 수십~100ns.

#### F-4. N-API 어댑터 String 왕복 — 24.3µs 중 97.9%가 브릿지

`calculator-napi/src/lib.rs:16-29`. `rustra_ffi_invoke_json_into` → napi Buffer 배선. Node 계열 최대 지렛대.

#### F-5. positional facade 측정 0회 (B-7과 동일 항목의 성능 측면)

#### F-6. bench CI 사각지대 (C-11과 동일)

#### F-7. typed 응답 decode JS 객체 구성 — 잔여 격차 주성분 (추정)

`rustra-generated-codecs.cpp:18-22`. Nitro식 프로토타입 재활용 후보. F-2 측정 후 착수.

#### F-8. 벤치 문서 수치 세션 불일치

`benchmarks.md:44-45` — Node 2.9µs와 24.3µs 공존. 정비 필요.

## 우선순위 로드맵 (권장)

### 트랙 1 — 즉시 수리 (버그 성격, 반나절~1일)

1. D-1 README 퀵스타트 수정 (첫인상)
2. A-1 release capability 결함 (기능이 prod에서 죽어 있음)
3. B-1 commandFn.name minify 파손 + B-3 devtools options 탈락 + B-2 signal 정책
4. C-1 release.yml 하드코딩 버전
5. C-2 provenance 1줄
6. D-3 CHANGELOG 0.2.0

### 트랙 2 — 신뢰/인프라 디딤돌 (1~2주)

- C-3 MSRV 레그, C-5 SECURITY.md/CodeQL/이슈 템플릿, C-9 consumer-smoke 확장, C-13 audit cron, C-10 dependabot actions
- A-4 Command Arc<Value> (1줄, 핫패스), A-6 spawn 가드, A-7 선검사
- F-1 벤치 통계 (모든 성능 작업의 전제)
- D-11 플랜 체크박스 폐쇄, D-6 색인, D-4 RN Android 정합

### 트랙 3 — 이벤트 스토리 완결 (핵심 가치 갭, 2~4주)

- E-1 Tauri JS 구독 API + Node 이벤트 transport
- E-2 이벤트 계약 코드젠 (타입 안전 이벤트)
- E-4 스트리밍 채널 (순서 보장) 설계
- A-18 emit 직렬화/bytes

### 트랙 4 — 비동기 스토리 (2~4주)

- E-3 async 커맨드 핸들러 설계·구현
- A-5 워커 풀, A-17 실행기 주입, B-11 node persistent transport
- A-3 probe 2회 실행 해소와 결합

### 트랙 5 — 시장 노출 (E-12, 병렬 상시)

- E-8 영어 README, E-7 crates.io 메타/커뮤니티 인프라, D-7 비교표/배지
- E-9 프리빌트 배저 전략 (napi-rs식)
- D-5 reference-app 승격, D-8 API 레퍼런스 게시

### 트랙 6 — 성능 마지막 한 끗 (측정 선행)

- F-2 측정 공백 → A-2 rkyv V2 caller-buffer → F-3 단일 조회 → F-4 napi 배선 → B-5 byId 배치

### 트랙 7 — 플랫폼 확장 (선택)

- E-5 Windows (블로커 소멸), E-6 Electron/WASM, E-11 배치 확장

## 코드 참조 (핵심 결함만)

- `crates/rustra/src/lib.rs:1414, 879-887` — release frozen → grant 불가
- `crates/rustra/src/lib.rs:493-512, 744-753` — Command 스키마 deep copy
- `crates/rustra/src/ffi.rs:493-556` — caller-buffer JSON (rkyv V2 변형 부재)
- `crates/rustra/src/ffi.rs:627-700` — async spawn 가드 부재/선복사
- `crates/rustra/src/rkyv_codec.rs:604-612` — $ref 미검증
- `README.md:43, 124` — 컴파일 안 되는 퀵스타트
- `packages/react/src/useCommand.ts:31, 44` — name 의존 + signal 강제
- `packages/devtools/src/index.ts:57-60` — options 탈락
- `packages/types/src/index.ts:1040-1072` — 배치 취소 폴백
- `.github/workflows/release.yml:108` — 하드코딩 0.1.3
- `docs/compatibility-matrix.md:15` — 이벤트 표면 공백

## 아키텍처 인사이트

- **PR #29 이후에도 결함이 6건 새로 발견**되었다는 점이 주목할 만. 감사가 게이트 중심(누수/패닉/타임아웃)이었기 때문에, 다음 감사는 "조합 폭발"(훅×엔진, devtools×옵션, probe×비멱등) 영역으로 확장해야 한다.
- **이벤트·비동기·노출 3축이 모두 "코어는 있는데 표면이 안 열린" 패턴** — Rust측 `register_with_events`, `invoke_rkyv_v2`, capability 시스템 전부 구현되어 있고 JS/문서/배포 층에서 끊긴다. 구현보다 "표면 개통"이 현재 병목.
- **이 저장소의 반복 패턴은 "구현 빠름 → 문서/플랜 동기화 지연"** (D-12). 릴리즈 체크리스트에 문서 동기화 강제가 근본 개선.
- 성능 최적화는 이미 2.8x→1.3x까지 왔고, 잔여는 측정 정밀도가 전제된 마이크로 최적화. 이제 투자 우선순위는 raw 성능보다 스펙트럼(이벤트/비동기)과 발견성.

## 히스토리 컨텍스트 (thoughts/ 디렉토리)

- `thoughts/shared/research/2026-08-20_09-55-00_unimplemented-survey.md` — 전날 26건 전수조사. 본 조사는 그 후속으로, 구현 완료 확인(D-11) + 신규 6각도 확장
- `thoughts/shared/research/2026-08-19_23-40-00_feasibility-multi-angle.md` — 온보딩 퍼널 병목 최초 지적
- `docs/research/2026-08-15-next-steps-analysis.ko.md` — 과거 트랙 A~E (대부분 완료됨)
- 메모리 `production-readiness-audit-fixed.md`, `jsi-fastpath-optimization-complete.md`, `lynx-removed-2026-08-20.md` — 각 트랙 완료 상태

## 관련 리서치

- `thoughts/shared/research/2026-08-20_09-55-00_unimplemented-survey.md` (직전 전수조사)
- `docs/research/2026-08-15-next-steps-analysis.ko.md`

## 미해결 질문

- 이벤트 채널 설계 방향 — Tauri Channels식 ordered 채널을 코어 추상화로 올릴지, 호스트별 구현으로 둘지
- async 핸들러의 런타임 중립성 — tokio 의존 vs 실행기 주입 훅
- 프리빌트 배포 — napi-rs식 NPM 아키텍처 매트릭스를 어느 시점에 도입할지 (채택 신호 기준)
- E-8 영어화 범위 — README만 이중화할지 docs 전체를 영어 우선으로 전환할지
- Windows 검증 착수 시점 (Windows 머신/CI 러너 확보 전제)

---
date: 2026-08-21
author: loopy-lim
status: draft
type: feature
priority: high
---

# 성장 건덕지 전수 구현(Growth Closure) SPEC

리서치: `thoughts/shared/research/2026-08-21_18-50-00_growth-opportunities-survey.md` (6각도 병렬 조사, 70여 건)

## 문제

v0.2.0 발행 직후 전수조사에서 70여 건의 성장 후보를 확인했다. 그중 6건은 PR #29 감사 이후 새로 발견된 **실제 결함**이다 — release 빌드에서 capability 부여가 영원히 불가능한 것(기능이 prod에서 죽어 있음), 루트 README 퀵스타트가 컴파일 안 되는 것, `@rustra/react` 훅이 minify 환경에서 파손되는 것, 훅×Node/Bun 조합이 첫 호출부터 실패하는 것, devtools가 옵션을 탈락시키는 것, release.yml의 하드코딩 버전 대기 루프. 나머지는 구조적 갭이다: 이벤트·비동기 스토리가 절반이고, 시장 노출(crates.io 98 다운로드)이 품질 대비 0에 수렴하며, 핫패스에 남은 성능 부채(매 invoke 스키마 deep copy 등)와 CI 사각지대가 존재한다.

## 해결 목표

**현재:** 품질 게이트는 성숙했으나 결함 6건이 살아 있고, 이벤트는 RN에만 완결되며, async invoke가 호출당 스레드를 띄우고, Node transport가 호출마다 프로세스를 재시작한다. README가 한국어 단일 언어이고 crates.io 메타데이터가 비어 있으며, CI가 MSRV/napi/miri/bench 경로를 검증하지 않는다.
**목표:** 결함 6건 전부 수정되고, 이벤트 구독이 4호스트 전부에서 동작하며(코드젠 타입 안전 포함), 코어 안전성·성능 부채(probe 2회 실행, spawn 가드, 스키마 deep copy, caller-buffer)가 해소되고, JS 패키지의 조용한 드롭이 전부 loud/문서화되며, CI 사각지대가 메워지고, 잠재 사용자가 영어 README·배지·비교표·커뮤니티 인프라를 통해 프로젝트를 평가할 수 있다.

## 성공 기준 (워크스트림별)

### WS1 — 즉시 결함 수리 (6건, 최우선)

- [ ] release 빌드에서 `grant_capability`가 동작한다 — freeze 예외(빌더 시점 grant 또는 grant의 mutable 요구 완화)와 테스트(`crates/rustra/src/lib.rs:1414, 879-887`)
- [ ] `#[command(capability = "...")]` 속성이 문자열 이름 재결합 없이 매크로 시점에 권한을 등록한다 (오타 시 컴파일 에러)
- [ ] 루트 README 퀵스타트의 모든 Rust 예제가 실제 컴파일된다 (단일 Input 구조체 + `Result<O>` 계약 준수, `README.md:43,124`)
- [ ] `useCommand`/`useMutation`/testing `.mock()`이 `commandFn.name` 대신 minify-안전 식별자(코드젠 `commandId` 상수 또는 `fn.commandId` 규약)로 명령을 식별한다
- [ ] useCommand×Node/Bun 엔진 조합이 동작한다 — signal을 전달하되 abort 전에는 throw하지 않는 정책 통일 (node/bun/tauri `invoke`가 options를 받고 미abort signal은 무시, abort 시 `cancelled`)
- [ ] devtools instrumented 엔진이 options(signal/timeoutMs)를 보존한다 (`packages/devtools/src/index.ts:57-60`)
- [ ] release.yml의 crates 대기 루프가 동적 버전(워크스페이스 Cargo.toml 파싱)을 검사한다 (`.github/workflows/release.yml:108`)
- [ ] release.yml에 `NPM_CONFIG_PROVENANCE: true`가 설정된다
- [ ] CHANGELOG에 0.2.0 엔트리가 존재한다

### WS2 — 코어 안전성·정확성 (Rust)

- [ ] caller-buffer probe가 핸들러를 1회만 실행한다 (probe 결과 재사용 또는 단일 호출 프로토콜, `ffi.rs:520-556`)
- [ ] async invoke의 `thread::spawn` 실패가 catch_unwind로 잡히고 invocation이 취소 정리된다 (`ffi.rs:627-700`)
- [ ] async invoke가 페이로드 복사 전 `max_payload_bytes()`를 선검사한다 (`ffi.rs:640-656`)
- [ ] 패닉 에러 메시지 형식이 단일 포맷터로 통일된다 (`ffi.rs:297` vs `ffi.rs:538` vs `lib.rs:841-844`)
- [ ] `js_field_supported`가 `$ref`를 definitions까지 따라가 재검증한다 (`rkyv_codec.rs:604-612`) — $ref가 미지원 타입을 가리키면 typed fast-path가 켜지지 않는다
- [ ] 코어에 rkyv V2 FFI 심볼(generic + async + caller-buffer 변형)이 노출되어 calculator 예제의 복제 래퍼가 코어 심볼로 대체된다 (`examples/calculator/src/lib.rs:1093-1210`)
- [ ] 이벤트 emit 직렬화 실패가 `"{}"` 조용 폴백 대신 stderr 경고를 남긴다 (`lib.rs:679-686`)
- [ ] rkyv V2 에러 body가 잘릴 때 truncated 마커가 남는다 (`rkyv_codec.rs:360-372`)
- [ ] `rustra_ffi_free`의 release 역참조 위험이 문서화되고 최소 null/정렬 검사가 추가된다 (`ffi.rs:785-819`)
- [ ] 테스트 공백 5건이 메워진다: caller-buffer fuzz/robustness, caller-buffer×async 조합, Json 기본 디스패치, 이벤트 싱크 병렬 등록, Json/postcard 심볼 혼용

### WS3 — 코어·브릿지 성능

- [ ] `Command`의 스키마 `Value`가 `Arc<Value>`로 바뀌어 매 invoke deep copy가 제거된다 (`lib.rs:493-512`)
- [ ] `invoke_rkyv_v2` 디스패치가 u16→핸들러 직접 캐시로 단일 조회화된다 (`lib.rs:794-809`)
- [ ] rkyv V2 caller-buffer 변형(`invoke_rkyv_v2_into`)이 구현되어 JSI typed fast path가 malloc→memcpy→free 사이클을 벗어난다 (재사용 버퍼 설계 포함)
- [ ] N-API 어댑터가 String 대신 Buffer(또는 caller-buffer)를 반환한다 (`examples/calculator-napi/src/lib.rs:16-29`)
- [ ] caller-buffer JSON 직렬화가 임시 Vec 없이 caller 버퍼로 직접 기록된다 (io::Write 어댑터)

### WS4 — JS 패키지 완결

- [ ] `RustraErrorCode` 상수 집합(13종)이 `@rustra/types`에 노출되고 문서화된다 (`types/index.ts:124-126`)
- [ ] mock 엔진이 invokeBatch/options/calls 기록(signal 포함)/pre-aborted 처리를 지원한다 (`testing/index.ts:29-77`)
- [ ] contract-gate에 expect 바인딩(vitest/jest 양방향 matcher)이 제공된다 (`testing/contract-gate.ts`)
- [ ] react-native `RustraJSINative` 타입이 types의 단일 선언을 재사용한다 (3중 미러링 해소)
- [ ] `_utf8Encode`/postcard varint가 number[] 누적 대신 사전 크기 추정 Writer를 쓴다 (`types/index.ts:366-388`, `cli/codegen.ts:271-282`)
- [ ] useCommand cleanup 경쟁이 settled ref 패턴으로 막힌다 (`useCommand.ts:40-57`)
- [ ] `invokeTypedBatchById`가 C++ JSI 브릿지에 구현되어 배치 byId 경로가 활성화된다 (JS 분기는 이미 존재, `types/index.ts:1057-1063`)
- [ ] positional facade가 byId 진입 + options 전달 배선으로 개선되고 벤치마크에 측정치가 반영된다 (`generate.ts:1369-1447`)
- [ ] 배치 항목별 취소의 미지원이 명시적 계약(문서+테스트)으로 고정된다 (네이티브 구현은 별트랙 명시)
- [ ] typed(tier1) 경로의 취소 전파가 조건 완화로 확장되거나 얕은 취소 계약이 문서+테스트로 고정된다 (`types/index.ts:929-935`)
- [ ] `@rustra/testing`/`@rustra/devtools` README이 작성된다

### WS5 — 이벤트 스토리 (핵심 가치 갭)

- [ ] `@rustra/tauri`에 이벤트 구독 API(`subscribeEvent`, `rustra://` 채널 래핑)가 제공된다 (`compatibility-matrix.md:15`)
- [ ] `@rustra/node` subprocess transport에서 이벤트 폴링/전파가 동작한다 (러프 루프형 런타임과 짝)
- [ ] 이벤트 계약이 코드젠에 포함된다 — `emit` 이름/페이로드 타입이 schema.json에 정의되고 TS 타입+구독 헬퍼가 생성된다 (Rust bin + TS CLI dual-path)
- [ ] 이벤트 버스의 drop-oldest 의미론과 용량 정책이 문서화되고, 형폭 포화 카운터가 노출된다 (관측성)

### WS6 — 비동기 스토리

- [ ] FFI async invoke가 호출당 `thread::spawn` 대신 고정 워커 풀 + bounded channel을 쓴다 (백프레셔: 큐 가득 시 즉시 에러 프레임) (`ffi.rs:646-699`)
- [ ] `block_on` 실행기가 park 대신 waker 기반으로 동작하고 런타임 컨텍스트(tokio 등) 안에서 교착을 일으키지 않는다 (`executor.rs:21-32`) — 실행기 주입 훅 또는 개선된 기본 구현
- [ ] thread_local state가 spawn 태스크에서 유실되는 제약이 문서화되거나 해소된다 (`state.rs:60-85`)
- [ ] `@rustra/node`가 persistent 프로세스 + NDJSON 라인 프레이밍 transport를 제공한다 — Rust 예제에 루프형 stdio 런타임 추가, 요청 id 상관, 동시 invoke 안전 (lazy-respawn은 폴백 유지) (`node/index.ts:79-203`)

### WS7 — CI·인프라·문서·시장

- [ ] CI에 MSRV 1.87 레그가 추가된다 (`Cargo.toml:39` 계약 검증)
- [ ] cargo-deny(라이선스/밴/중복) 설정과 CI 잡이 추가된다
- [ ] SECURITY.md, CODEOWNERS, 이슈 템플릿, PR 템플릿이 추가된다
- [ ] consumer-smoke가 10개 패키지 전부를 npm pack 검사한다 (`ci.yml:230-246`)
- [ ] cargo audit이 주간 cron으로도 실행된다; dependabot에 github-actions 생태계가 추가된다
- [ ] bench.yml paths에 examples/react-native-calculator(JSI/C++)와 packages/cli가 포함되고 criterion baseline 복원이 동작한다
- [ ] miri 야간 잡(FFI 테스트 제외 설정 포함)이 추가된다
- [ ] fuzz 시드 corpus가 git에 등록되고 고아 corpus(invoke_postcard)가 정리된다
- [ ] napi 경로(test:runtime:node-napi)가 CI에 탑재되고 napi 2/3 버전 정합이 정리된다 (0바이트 index.d.ts 포함)
- [ ] docs/README.md 색인에 누락 4종이 포함된다
- [ ] react-native-setup.md의 Android 서술이 실제(Stable + CI Release APK)와 일치하고 Android 셋업 섹션이 재작성된다 (`react-native-setup.md:7,127`)
- [ ] 루트 README에 배지(CI/audit/crates/npm), 경쟁 비교표, 로드맵, FAQ가 추가되고 영어 섹션(또는 이중 README)이 제공된다
- [ ] crates.io 메타데이터(keywords/categories/description)와 GitHub topics/description이 설정된다
- [ ] benchmarks.md의 측정 세션 불일치(2.9µs vs 24.3µs 공존)가 정비되고 p99 열이 채워진다 (Bench 앱 p99 로깅 + transport-bench 통계 개선 포함)
- [ ] reference-app이 README + 독립 실행 가능한 형태로 승격된다
- [ ] typedoc 설정이 추가되어 API 레퍼런스가 생성 가능해진다 (게시는 CI 잡 추가까지만)
- [ ] unimplemented-closure 플랜 체크박스가 실제 상태로 폐쇄된다 (`thoughts/shared/plans/2026-08-20_unimplemented-closure-impl.md`)
- [ ] 할당 횟수/콜드스타트 측정이 benchmark 예제에 추가된다 (`examples/benchmark/src/main.rs`)
- [ ] CI에 windows-latest 확장(Node/Bun 런타임 게이트)이 추가된다

## 범위 제한

- **npm/crates.io 발행은 하지 않는다** — changeset 작성까지만 (발행은 별도 승인, 기존 관례)
- **Android/iOS 실기기·시뮬레이터 측정은 하지 않는다** — 기기 의존, 문서 반영까지만
- **Windows 실기기 수동 검증은 하지 않는다** — CI 러너 확장까지만
- **WASM/브라우저 호스트, Electron 전용 패키지는 별트랙** — 설계 문서에 로드맵으로만 기록
- **프리빌트 바이너리 npm 발행은 별도 승인** — 전략 문서 + CI 산출물 빌드까지만
- **무중단 핫 리로드 주입은 별트랙 유지**
- **배치 항목별 취소의 네이티브 구현(invokeTypedBatchAsync + 부분 reject)은 별트랙** — 계약 문서화만
- breaking change는 회피 — 공개 API는 확장 또는 문서화로 처리
- 성능 수치 목표(예: Nitro 격차 N배)는 설정하지 않는다 — 구현 + 측정 반영까지만

## 참고 자료

- 리서치 문서: `thoughts/shared/research/2026-08-21_18-50-00_growth-opportunities-survey.md` (A/B/C/D/E/F 항목별 파일:줄 근거)
- 결함 6건 근거: `lib.rs:1414`, `README.md:43,124`, `useCommand.ts:31,44`, `devtools/index.ts:57-60`, `release.yml:108`
- 이벤트 갭: `compatibility-matrix.md:15`, `events.rs:145`, `lib.rs:249`
- 성능 설계: `docs/plans/2026-08-18-perf-close-nitro-gap.md`, `docs/benchmarks.md:88-103`
- 코드젠 dual-path 관례: 메모리 `codegen-dual-path-regen` (Rust bin + TS CLI, generated/ prettier 제외, test:ts:node)
- 커밋 관례: lefthook prettier 재스테이징 없음 → 커밋 후 amend (메모리 `lefthook-prettier-amend`)
- 선행 SPEC: `thoughts/shared/specs/2026-08-20_unimplemented-closure.md` (26건 — 완료, 본 SPEC은 후속)

---
date: 2026-08-20
author: loopy-lim
status: draft
type: feature
priority: high
---

# 미구현 항목 전수 마감(Unimplemented Closure) SPEC

리서치: `thoughts/shared/research/2026-08-20_09-55-00_unimplemented-survey.md` (26건)

## 문제

전수조사 결과 26건의 미구현/결함이 확인됐다. 그중 2건은 실사용자에게 즉시 해로운 결함이다 — ① CLI rkyv 코드젠이 미지원 필드(`Option<T>`/`Vec<T>`/enum/map)를 경고 없이 삭제해 crud 예제의 와이어 프레임이 이미 깨져 있으며, ② Rust API 가이드의 26%가 실제 매크로 동작과 불일치해 신규 사용자가 첫 예제부터 컴파일에 실패한다. 나머지는 온보딩 끊김(Node transport 부재), 조용한 의미론적 드롭(signal/빈 Map), 고아 추상, 스테일 문서, 미완성 플랫폼 지원이다.

## 해결 목표

**현재:** 미지원 타입 필드가 코드젠에서 무음 삭제되고, 공식 가이드가 컴파일 안 되는 예제를 가르치며, Node 사용자가 "5분 온보딩"을 스스로 transport를 구현해야 완성할 수 있다. 계약 검증(contractHash)은 RN에서 켤 수 없고, 취소 전파는 일부 경로만 동작한다.
**목표:** 모든 명령이 정확히 인코딩/디코딩되거나 명시적 경고와 함께 폴백되고, 문서 전부가 실제 동작과 일치하며, Node/RN 사용자가 문서만으로 완결된 시작 경로를 밟을 수 있다. 조용한 드롭은 모두 loud error 또는 문서화된 매트릭스로 드러난다.

## 성공 기준 (워크스트림별)

### WS1 — 코드젠 정확성 (HIGH)

- [ ] `Option<T>`/`Vec<String>`/`Vec<Struct>`/enum 필드를 가진 명령이 더 이상 "부분 코덱"을 생성하지 않는다: 라운드트립 불가 명령은 레지스트리에서 제외되고 생성 시 `WARN` 로그가 나가며, 엔진 Tier 3 JSON 폴백이 처리한다 (crud 예제의 getItem/listItems/updateItem이 폴백으로 올바른 데이터 반환)
- [ ] 생성물 round-trip 스모크 테스트가 CI에 추가된다 — 예제 스키마 전체에 대해 "코덱 등록 명령은 인코딩→디코딩 round-trip 성공"을 검증
- [ ] `allOf`(intersection → `A & B`)와 integer enum(`1 | 2 | 3`)이 코드젠에서 지원된다 (Rust bin + TS CLI 양쪽, dual-path 일치)
- [ ] postcard 필드 순서(알파벳) 위반이 빌드 타임에 경고된다
- [ ] auth/streaming 예제의 `generated/`가 재생성되어 calculator/crud와 동일한 산출물 구조를 가진다
- [ ] `rustra init` 템플릿이 현재 발행 버전(0.1.3)을 참조한다
- [ ] `docs/internal/codegen.md` 제한사항 표가 갱신된다 (allOf/integer enum 해소, 낡은 oneOf/const 행 정정)

### WS2 — API 문서 정합성 (HIGH)

- [ ] `docs/rust-api-guide.md`의 모든 코드 예제가 실제 컴파일된다 — 스칼라 멀티파라미터/bare 반환/`#[bridge(rename_all)]`/`generate_to`/`register`/`build()` 함수 서술을 실제 API(`단일 Input 구조체`, `Result<O>` 강제, `generate_typescript()?.write_to_dir()`, `build!` 매크로)로 재작성. 구현됐으나 누락된 API(이벤트 버스, FFI, capability, freeze, tauri)를 부록에 추가
- [ ] `docs/compatibility-contract.md`의 RN 서술이 현행화된다 (RN JSI 네이티브 모듈 구현·검증 완료 사실 반영)
- [ ] `docs/security-audit.md`에서 삭제된 `runner/` 경로 참조가 제거된다
- [ ] 마스터플랜(`2026-05-14`) 진척 표가 실제 상태(streaming/auth/마이그레이션 완료)로 갱신된다
- [ ] `docs/README.md`에 rust-api-guide/release-procedure/security-audit가 목록된다
- [ ] `--cpp-output`이 `docs/extending/react-native-setup.md`와 getting-started에 문서화된다

### WS3 — 온보딩/DX 완결

- [ ] `@rustra/node`에 `createNodeProcessTransport`(napi 또는 subprocess)가 제공되고, getting-started의 Node 퀵스타트가 사용자 구현 없이 복붙 가능한 완결 코드가 된다
- [ ] 호환성 매트릭스 문서가 추가된다 — signal/취소/invokeBatch/이벤트 × 어댑터(node/bun/tauri/RN) 표. 조용한 드롭(node/bun의 signal 무시)은 가능하면 loud error로 전환하고, 전환 시 매트릭스에 반영
- [ ] `@rustra/react` 훅(useCommand/useMutation/useEvent/RustraProvider)을 사용하는 레퍼런스 앱 예제가 추가된다 (CRUD + 이벤트)

### WS4 — 취소/의미론 완성

- [ ] 취소 전파가 typed(tier 1)/tier 3 경로까지 확장된다 (`!onTypedPath` 조건 완화, 3-tier × 취소 매트릭스 테스트)
- [ ] tier-3 `getLiveSchema`가 `getSchema` 미노출 네이티브에서 빈 Map 대신 명시적 에러를 던진다
- [ ] `invokeTypedBatch`의 항목별 취소 지원 또는 명시적 "미지원 throw" 계약이 문서화·테스트된다

### WS5 — 고아 추상/잔여물 정리

- [ ] `contractHash` 검증이 RN에서 동작한다 — `RustraJSIBridge.cpp`에 `getContractHash` 배선 + 옵션 전달 (iOS/Android 공유 cpp)
- [ ] `RendererHost` trait 존속 결정이 문서화된다 — 공개 API라 제거하지 않되, 사용처(host 통합 지점)와 Lynx 제거 배경을 모듈 독에 기록하고 `#[allow(dead_code)]`/낡은 모듈 독을 정리
- [ ] `invokeAsync(payload, onDone): number` 옵셔널 메서드가 구현(JSI 배선)되거나 "호스트 구현 계약"으로 문서화된다
- [ ] Lynx 잔여물 제거 — `packages/lynx/dist/`(비추적), `Example.nitro.ts` 템플릿, `trust_baseline_ffi.rs` 낡은 모듈 독, "(T3 후속)" 낡은 마커 4곳
- [ ] `docs/plans/2026-08-10-rn-b1-verification.md` 23항목 체크리스트가 CI/벤치마크 대체 근거와 함께 폐쇄 처리된다

### WS6 — 플랫폼/검증 보강

- [ ] benchmark RSS 측정이 Linux(`/proc/self/statm`)에서도 동작한다 (Windows는 cfg 스텁 + 문서)
- [ ] Android JSI fastpath 재검증이 "측정 대기" 상태로 벤치마크 문서에 명시된다(기기 의존 — 측정 자체는 범위 밖)

### WS7 — 성능 후속 (의도적 유예였으나 목표상 구현)

- [ ] FFI caller-buffer fastpath: Rust malloc→복사→JS memcpy 3중 복사를 제거하는 caller-buffer FFI 변형이 구현되어 벤치마크에 반영된다 (`docs/benchmarks.md` Task 7 참조)
- [ ] 코드젠 positional facade(P2): 정적 명령이 `__rustraNative.xxx(a, b)` positional 시그니처로 JSI 직접 호출하도록 생성된다

### WS8 — rkyv Rust Tier 3 바이너리 확장

- [ ] Rust 디코더 Tier 3가 중첩 구조체/enum/`Option<T>`의 바이너리(postcard) 와이어를 지원한다 — 기존 JSON 폴백은 유지(스키마 미지원 시), 지원 범위 확장만

## 범위 제한

- **npm/crates 발행은 하지 않는다** — changeset 작성까지만 (발행은 별도 승인, 기존 관례)
- **무중단 핫 리로드 주입**(레지스트리 실행 중 주입)은 별트랙 유지 — 이번 범위 밖
- **Android 실기기/에뮬레이터 측정, iOS 디바이스 빌드**는 환경 의존이라 측정/검증 자체는 범위 밖 (문서화만)
- **Lynx 관련 어떤 것도 부활시키지 않는다** (잔여물 제거만)
- breaking change는 회피 — 공개 API(`RendererHost` 등)는 제거가 아닌 문서화/보강으로 처리
- 성능 목표 수치(예: Nitro 격차 N배)는 설정하지 않는다 — 기능 구현과 측정 반영까지만

## 참고 자료

- 리서치 문서: `thoughts/shared/research/2026-08-20_09-55-00_unimplemented-survey.md` (파일:줄 상세)
- 코드젠 결함 근원: `packages/cli/src/generate.ts:165-206`, 생성물 `examples/crud/generated/rkyv-codecs.ts:287,318,325-332`
- 폴백 선점 구조: `packages/types/src/index.ts:780-795` (Tier 3 JSON 폴백), `examples/crud/generated/rkyv-registry.ts:7`
- 매크로 실제 계약: `crates/rustra-macros/src/lib.rs:100-120,151-159,387`
- 코드젠 dual-path 재생성 관례: 메모리 `codegen-dual-path-regen` (Rust bin + TS CLI, generated/ prettier 제외, `test:ts:node`)
- 커밋 관례: lefthook prettier 재스테이징 없음 → 커밋 후 amend (메모리 `lefthook-prettier-amend`)
- 성능 후속 설계: `docs/plans/2026-08-18-perf-close-nitro-gap.md` Task 7, `docs/benchmarks.md:90-95`
- 취소 설계: `docs/plans/2026-08-18-followup3-typed-async-id-batch-cancel.md`
- Tier 3 설계: `crates/rustra/src/rkyv_codec.rs:22,44`

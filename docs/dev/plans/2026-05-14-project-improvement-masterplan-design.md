# Rustra-Bridge Project Improvement Masterplan

**Date**: 2026-05-14
**Status**: Approved
**진척 갱신**: 2026-08-15 — 항목별 상태는 아래 표 참조.

---

## Phase 1: 기반 인프라

### 1-1. GitHub Actions CI/CD

| 워크플로우    | 트리거           | 내용                                   |
| ------------- | ---------------- | -------------------------------------- |
| `ci.yml`      | PR, push to main | Rust 테스트, TS 빌드/테스트, 타입 체크 |
| `release.yml` | 태그 push        | npm 퍼블리싱 + crates.io 배포          |
| `bench.yml`   | main 머지        | 벤치마크 실행 및 리포트                |

### 1-2. 코드 품질 도구 (TypeScript)

- **ESLint 9 flat config** (`eslint.config.js`) — 타입스크립트, Node/Bun 환경
- **Prettier** — `printWidth: 100, singleQuote: true, trailingComma: "all"`
- **lint-staged + husky** — 커밋 전 자동 포맷팅 + 린트
- 루트 `package.json`에 `lint`, `format`, `format:check` 스크립트 추가

### 1-3. Rust 품질 도구

- **clippy** CI 통합 — `cargo clippy -- -D warnings`
- **rustfmt** — `cargo fmt --check`
- **cargo-deny** (선택) — 의존성 라이선스/취약점 검사

---

## Phase 2: 기능 완성도

### 2-1. 타입 매핑 확장 (`codegen.rs`)

| 타입                 | 현재      | 목표                                       |
| -------------------- | --------- | ------------------------------------------ |
| Tuple                | `unknown` | `[A, B, C]`                                |
| Map/Record           | 미지원    | `Record<string, T>`                        |
| Set                  | 미지원    | `Set<T>` (런타임 변환 포함)                |
| Recursive types      | 미지원    | self-referencing 구조                      |
| Discriminated unions | 미지원    | `{ type: "A", ... } \| { type: "B", ... }` |

### 2-2. React Native 완성

- Android 네이티브 구현 (Kotlin/JNI)
- RN 설정 가이드 문서화
- JSI 성능 최적화 (iOS/Android 동등 구현)

### 2-3. 에러 핸들링 강화

- 구조화된 에러 코드 확장 — 도메인별 세분화
- `retryable: boolean` + 권장 액션 메타데이터
- 트랜스포트 레이어 재시도 옵션

---

## Phase 3: DX/사용성

### 3-1. 예제 확장

| 예제      | 목적                               |
| --------- | ---------------------------------- |
| CRUD      | DB 연동 패턴 (생성/조회/수정/삭제) |
| Streaming | 이벤트 스트림/프로그레스 패턴      |
| Auth      | 세션/토큰 관리 패턴                |

### 3-2. 퍼블리싱 워크플로우

- **Changesets** 도입 — `@changesets/cli` 변경 로그 자동 생성
- 버전 관리 전략 — 패키지 간 의존성 버전 동기화
- npm 배포 자동화 — CI에서 changeset PR 머지 시 자동 publish
- crates.io 배포 — `rustra`, `rustra-macros`

### 3-3. CLI 개선

- `watch` 모드 — Rust 코드 변경 시 TS 자동 재생성
- `init` 명령어 — 프로젝트 스캐폴딩 (`rustra init my-project`)

---

## Phase 4: 아키텍처/기술부채

### 4-1. 매크로 코드 개선

- proc-macro 코드 문서 주석 보강
- 복잡한 파싱 로직 헬퍼 함수로 분리
- 컴파일 에러 메시지 개선 — 에러 위치 정확도 향상

### 4-2. 벤치마크 확장

- 큰 페이로드 테스트 (1KB, 10KB, 100KB, 1MB)
- 메모리 사용량 프로파일링
- 동시성 벤치마크 — 다중 invoke 동시 실행
- CI 벤치마크 회귀 감지

### 4-3. 계약(Contract) 강화

- 스키마 호환성 검사 엄격화 — 필드 삭제/변경 명시적 감지
- 런타임 계약 검증 — 개발 모드 request/response 스키마 검증
- 마이그레이션 가이드 문서화

---

## 우선순위 요약

| Phase | 영역              | 예상 공수 | 의존성       |
| ----- | ----------------- | --------- | ------------ |
| 1     | 기반 인프라       | 2-3일     | 없음         |
| 2     | 기능 완성도       | 1-2주     | Phase 1 권장 |
| 3     | DX/사용성         | 1주       | Phase 1 권장 |
| 4     | 아키텍처/기술부채 | 1주       | Phase 1 권장 |

Phase 1은 독립적으로 진행 가능하며, Phase 2-4는 Phase 1의 CI/린트 인프라가 있으면 더 안정적으로 진행할 수 있습니다.

---

## 진척 상태 (2026-08-15 갱신)

| 항목                                  | 상태      | 비고                                                               |
| ------------------------------------- | --------- | ------------------------------------------------------------------ |
| ci.yml (1-1)                          | ✅ 완료   | fmt/clippy/test + TS 전체 게이트 green                             |
| release.yml (1-1)                     | ✅ 완료   | 2026-08-15 추가 — changesets npm + crates.io 수동 잡               |
| bench.yml (1-1)                       | ✅ 완료   | 2026-08-15 추가 — 수동 트리거, 회귀 감지                           |
| ESLint/Prettier/lefthook (1-2, 1-3)   | ✅ 완료   | lefthook이 husky/lint-staged 역할 대체                             |
| Tuple/Map 타입 (2-1)                  | ✅ 완료   | codegen Map/Tuple 지원                                             |
| Set 타입 (2-1)                        | ✅ 완료   | 2026-08-15 `Set<T>` + postcard set\_\* kind (f48537ff)             |
| Recursive / Discriminated (2-1)       | ✅ 완료   | const 판별 필드 + allOf/integer enum (2026-08-20 코드젠 마감)      |
| RN Android 네이티브 (2-2)             | ✅ 완료   | Lynx 트랙에서 Android JNI 증명 (7/7) — runner/ 는 Lynx 제거로 삭제 |
| 에러 retryable 메타데이터 (2-3)       | ✅ 완료   | transport.\*/timeout retryable + TS `.retryable` 노출 (f48537ff)   |
| CRUD 예제 (3-1)                       | ✅ 완료   | examples/crud                                                      |
| Streaming/Auth 예제 (3-1)             | ✅ 완료   | examples/streaming, examples/auth (발행된 패턴 예제)               |
| Changesets (3-2)                      | ⚠️ 도입됨 | config 존재, 0.1.2/0.1.3은 changeset 범프로 발행                   |
| npm 배포 (3-2)                        | ✅ 완료   | @rustra/\* 10종 0.1.3 발행                                         |
| crates.io 배포 (3-2)                  | ✅ 완료   | rustra / rustra-macros 0.1.3 발행                                  |
| CLI watch (3-3)                       | ✅ 완료   | `rustra generate --watch`                                          |
| CLI init (3-3)                        | ✅ 완료   | `rustra init <dir>` 스캐폴딩 (f48537ff)                            |
| 큰 페이로드 벤치마크 (4-2)            | ✅ 완료   | docs/benchmarks.md 페이로드 scaling                                |
| 메모리 프로파일링 / 동시성 벤치 (4-2) | ❌ 미완료 | 후보 과제                                                          |
| CI 벤치마크 회귀 감지 (4-2)           | ✅ 완료   | bench.yml (2026-08-15)                                             |
| 스키마 호환성 검사 (4-3)              | ✅ 완료   | schema-diff breaking change 검출                                   |
| 런타임 계약 검증 (4-3)                | ✅ 완료   | contractHash + createValidatedEngine                               |
| 마이그레이션 가이드 (4-3)             | ✅ 완료   | docs/migration-guide.md                                            |

계획 외 달성: rkyv V2 무직렬화 경로, RN JSI fast path, FFI trust hardening,
온디바이스 벤치마크(iOS Direct C++ 0.95µs). (Lynx 어댑터+4플랫폼 러너 템플릿은
2026-08-20 Lynx 제거로 삭제 — 4표면 → 3플랫폼 재편.)

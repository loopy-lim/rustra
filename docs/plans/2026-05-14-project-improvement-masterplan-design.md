# Rustra-Bridge Project Improvement Masterplan

**Date**: 2026-05-14
**Status**: Approved

---

## Phase 1: 기반 인프라

### 1-1. GitHub Actions CI/CD

| 워크플로우 | 트리거 | 내용 |
|---|---|---|
| `ci.yml` | PR, push to main | Rust 테스트, TS 빌드/테스트, 타입 체크 |
| `release.yml` | 태그 push | npm 퍼블리싱 + crates.io 배포 |
| `bench.yml` | main 머지 | 벤치마크 실행 및 리포트 |

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

| 타입 | 현재 | 목표 |
|---|---|---|
| Tuple | `unknown` | `[A, B, C]` |
| Map/Record | 미지원 | `Record<string, T>` |
| Set | 미지원 | `Set<T>` (런타임 변환 포함) |
| Recursive types | 미지원 | self-referencing 구조 |
| Discriminated unions | 미지원 | `{ type: "A", ... } \| { type: "B", ... }` |

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

| 예제 | 목적 |
|---|---|
| CRUD | DB 연동 패턴 (생성/조회/수정/삭제) |
| Streaming | 이벤트 스트림/프로그레스 패턴 |
| Auth | 세션/토큰 관리 패턴 |

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

| Phase | 영역 | 예상 공수 | 의존성 |
|---|---|---|---|
| 1 | 기반 인프라 | 2-3일 | 없음 |
| 2 | 기능 완성도 | 1-2주 | Phase 1 권장 |
| 3 | DX/사용성 | 1주 | Phase 1 권장 |
| 4 | 아키텍처/기술부채 | 1주 | Phase 1 권장 |

Phase 1은 독립적으로 진행 가능하며, Phase 2-4는 Phase 1의 CI/린트 인프라가 있으면 더 안정적으로 진행할 수 있습니다.

# rustra-bridge 종합 문서화 설계

## 목표

rustra-bridge의 문서를 체계적으로 재편한다. 사용자용(라이브러리 사용법, 확장 가이드)과 기여자용(아키텍처, 내부 구조)을 분리하고, 모든 문서를 한국어로 작성한다.

## 독자

| 독자              | 필요한 정보                              | 추천 경로                   |
| ----------------- | ---------------------------------------- | --------------------------- |
| 라이브러리 사용자 | API 사용법, adapter 선택, transport 교체 | Getting Started → Extending |
| 프로젝트 기여자   | 아키텍처, crate 구조, codegen, 테스트    | Architecture → Internal     |

## 언어

모든 새 문서는 한국어. 과거 연구 문서는 원문 보존.

## 과거 문서 처리

`docs/`에 있는 과거 연구 문서는 `docs/research/`로 이동하여 보존한다. 과거 crate명(engine-core, engine-contract 등)을 사용하더라도 수정하지 않는다.

## 문서 구조

```txt
docs/
  README.md                         문서 인덱스 (한국어)
  architecture.md                   아키텍처 개요
  getting-started.md                사용자 가이드
  extending/
    transport-guide.md              transport 교체/확장 가이드
    adding-host.md                  새 host 추가 가이드
  internal/
    crate-structure.md              crate/패키지 관계
    codegen.md                      codegen 로직 설명
    testing.md                      테스트 전략
  compatibility-contract.md         기존 (유지, 영어)
  research/                         과거 문서 보존
    rust-local-engine-experiment-handoff.ko.md
    rust-owned-contract-package-pattern.ko.md
    tauri-like-single-invoke-architecture.ko.md
    ios-local-engine-benchmark-notes.md
    json-command-binary-payload-architecture.ko.md
    rn-rust-native-bridge-comparison.ko.md
    benchmark-plan.md
    rust-local-engine-vs-native-bridges.md
```

## 각 문서 내용

### docs/README.md (문서 인덱스)

- rustra 한 줄 소개
- 독자별 추천 읽기 경로
- 전체 문서 목록 (링크)

### docs/architecture.md (아키텍처 개요)

- 전체 데이터 흐름도 (ASCII)
  Rust command → Package → generate_typescript() → types.ts/commands.ts → adapter → host
- EngineClient 단일 인터페이스 설명
- crate/패키지 관계
- 계약 불변식: generated code는 host를 모름
- transport 레이어 분리 원칙

### docs/getting-started.md (사용자 가이드)

- 설치 (Cargo.toml 설정)
- 최소 예제 (calculator 재구성)
  - Rust 타입 정의
  - #[command] 함수
  - Package builder
  - TypeScript 생성
- adapter 선택 가이드 (Node, Bun, Tauri, RN)
- 실행 및 테스트

### docs/extending/transport-guide.md (transport 교체 가이드)

- transport 개념 설명
- 현재 transport 구현 현황표
- 교체 절차 (단계별)
- 예시: Bun FFI 교체 (실제 코드)
- 예시: Node napi-rs 교체 (실제 코드)

### docs/extending/adding-host.md (새 host 추가 가이드)

- EngineClient 구현 조건
- packages/ 아래 새 adapter 만들기
- C FFI / stdio 진입점 선택 기준
- 테스트 추가

### docs/internal/crate-structure.md

- 각 crate/package의 책임과 의존성
- 빌드 의존성 그래프

### docs/internal/codegen.md

- schema → TS 타입 매핑 규칙
- command 이름 변환 (snake_case → camelCase)
- contract hash 생성
- 현재 지원 타입 vs 미지원 타입

### docs/internal/testing.md

- test:compat 구조
- adapter 테스트 vs runtime 테스트
- Tauri smoke 테스트
- RN 상태 (adapter-only, runtime 대기중)

## 갱신 대상 기존 파일

| 파일                          | 작업                          |
| ----------------------------- | ----------------------------- |
| 루트 README.md                | 한국어 재작성, 현재 구현 기준 |
| crates/rustra/README.md       | 한국어, API 개요              |
| packages/\*/README.md (4개)   | 한국어, adapter 역할 명확화   |
| examples/calculator/README.md | 한국어                        |

## 작업 분할

agent 병렬 실행으로 3개 트랙을 동시에 진행:

1. **아키텍처 트랙**: architecture.md + internal/ 3개 파일
2. **사용자 트랙**: getting-started.md + extending/ 2개 파일
3. **갱신 트랙**: 루트 README + crate/package/example README 갱신 + docs/README.md + research/ 이동

## 승인 기준

- 모든 새 문서가 실제 코드 기반으로 정확하게 작성됨
- cargo test --workspace 통과
- npm run test:compat 통과
- 과거 연구 문서가 docs/research/에 보존됨

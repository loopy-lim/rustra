# rustra 문서

rustra는 Rust 패키지를 한 번 정의하면 host-neutral TypeScript 클라이언트를 자동 생성하는 브릿지 프레임워크다.

## 읽기 경로

### 라이브러리 사용자

1. [아키텍처 개요](architecture.md) — 전체 구조와 핵심 개념 파악
2. [시작하기](getting-started.md) — 설치 및 첫 패키지 만들기
3. [Transport 교체 가이드](extending/transport-guide.md) — Bun FFI, Node napi-rs 등 transport 교체
4. [새 Host 추가 가이드](extending/adding-host.md) — Electron, Deno 등 새 host adapter 추가

### 프로젝트 기여자

1. [아키텍처 개요](architecture.md) — 전체 구조와 핵심 개념 파악
2. [Crate 및 Package 구조](internal/crate-structure.md) — 각 crate/package의 책임과 의존성
3. [TypeScript 코드 생성](internal/codegen.md) — schema → TS 타입 매핑, command 이름 변환
4. [테스트 구조](internal/testing.md) — 테스트 계층, 파일별 역할, 실행 명령어

## 전체 문서 목록

| 문서                                                  | 대상   | 내용                                                             |
| ----------------------------------------------------- | ------ | ---------------------------------------------------------------- |
| [아키텍처 개요](architecture.md)                      | 전체   | 데이터 흐름, EngineClient 계약, transport 분리 원칙              |
| [시작하기](getting-started.md)                        | 사용자 | 설치, 최소 예제, TS 통합, 에러 처리, adapter 선택, 실행          |
| [Transport 교체 가이드](extending/transport-guide.md) | 사용자 | Bun FFI, Node napi-rs 교체, 선택 기준                            |
| [새 Host 추가 가이드](extending/adding-host.md)       | 사용자 | adapter 만들기, Rust 진입점 선택, 테스트 추가                    |
| [Crate 및 Package 구조](internal/crate-structure.md)  | 기여자 | 각 crate/package 책임, 빌드 의존성                               |
| [TypeScript 코드 생성](internal/codegen.md)           | 기여자 | codegen 파이프라인, 타입 매핑, 제한사항                          |
| [테스트 구조](internal/testing.md)                    | 기여자 | 테스트 계층, 스크립트 체인, host별 상태                          |
| [호환성 계약](compatibility-contract.md)              | 기여자 | EngineClient 안정 계약, runtime acceptance gates                 |
| [계약 마이그레이션 가이드](migration-guide.md)        | 전체   | 스키마 breaking change 검출(rustra diff)·해결 레시피·롤아웃 순서 |
| [벤치마크](benchmarks.md)                             | 전체   | 어댑터별 성능 비교, 오버헤드 분석, 페이로드 확장성               |
| [기여 가이드](../CONTRIBUTING.md)                     | 기여자 | 개발 환경, 커밋 규칙, 디버깅, 릴리즈                             |

## 연구 배경

[docs/research/](research/)에는 초기 iOS PoC에서 나온 bridge/benchmark/transport 연구 문서가 있다. 현재 구현과 crate명이 다를 수 있지만, 설계 판단 근거로 보존한다.

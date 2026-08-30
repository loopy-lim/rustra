# 버전 및 호환성 정책

이 문서는 각 버전 bump가 무엇을 보장하는지, 항목을 어떻게 폐기(deprecated)하는지,
어떤 표면이 안정성 보장에서 제외되는지 정의한다. CI 게이트와 아래 실험 표면의
기준 문서다. 발행 절차(무엇을 어떤 순서로 내보내는지)는
[릴리즈 절차](release-procedure.md)에서, 스키마 수준 breaking change 검출은
[계약 마이그레이션 가이드](migration-guide.md)에서 다룬다.

## 호환성 보장 범위

| 표면                                                      | 마이너 릴리즈 내 보장                                                                                  | Breaking change 요구 조건                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Wire format (릴리즈된 스키마의 rkyv V2 / postcard 바이트) | 스키마가 릴리즈되는 순간부터 안정: 동일 스키마 + contract hash에 대해 생성된 바이트는 계속 디코딩된다. | 메이저 버전. pre-1.0에서는 마이그레이션 노트를 동반한 마이너. |
| Contract hash 알고리즘                                    | 호환성 핵심: 스키마 해시 입력 정의는 릴리즈별로 고정된다.                                              | 메이저 버전. pre-1.0에서는 마이그레이션 노트를 동반한 마이너. |
| FFI 심볼 시그니처 (`rustra_ffi_*` C ABI)                  | 추가만 허용. 기존 심볼은 이름·파라미터 목록·호출 규약을 유지한다.                                      | 제거와 시그니처 변경은 아래 폐기 절차를 거친 뒤 메이저로.     |
| 생성 산출물 (TypeScript / C++ / RN 생성 파일)             | 동일 설정으로 재생성하면 drop-in으로 교체된다.                                                         | 메이저 버전. pre-1.0에서는 마이그레이션 노트를 동반한 마이너. |
| 공개 Rust API (`crates/rustra`, `rustra-macros` export)   | 표준 semver.                                                                                           | 메이저 버전.                                                  |
| 공개 TypeScript API (`@rustra/*` 패키지 export)           | 표준 semver.                                                                                           | 메이저 버전.                                                  |

어떤 보장에도 해당하지 않는 것:

- 내부 모듈. `crates/rustra/src/__private` 아래 전체를 포함한다.
- `#[doc(hidden)]` Rust 항목과 `@internal` 태그가 붙은 TypeScript 항목.
- 위 표면을 통해서만 도달할 수 있는 것들.

## 폐기(deprecation) 절차

1. 표시한다. Rust 항목에는 대체재를 가리키는 note와 함께 `#[deprecated]`를,
   TypeScript 항목에는 JSDoc `@deprecated`를 붙인다. `#[doc(hidden)]`을 함께
   쓸 수는 있지만 attribute를 대체하지 못한다.
2. 알린다. 폐기 버전의 릴리즈 노트에 항목과 대체재를 명시한다.
3. 유지한다. 폐기된 항목은 최소 1 마이너 릴리즈 동안 남는다.

pre-1.0 규칙: 이전 릴리즈에서 폐기되었던 항목은 마이너 릴리즈에서 제거할 수
있으며, 제거는 CHANGELOG와 — 소비자가 조치해야 하는 경우 —
`docs/migrations/<from>-to-<to>.md`에 문서화한다.

현재 상태: `RendererHost`는 `#[doc(hidden)]`이자 `#[deprecated]`
("RendererHost is retained for Rustra 0.x compatibility; prefer a
host-specific adapter boundary") 상태다. 0.x 사이클이 끝날 때까지 유지하며,
여기서 제거를 제안하지 않는다.

## 실험 표면

실험 항목은 안정화될 때까지 어떤 릴리즈에서든 변경되거나 깨질 수 있다. 표시는
명시적으로 한다: "experimental"이 포함된 doc comment와 아래 표 항목. 항목이 이
표를 떠나는 유일한 경로는 위 보장 범위에 들어가는 것이며, 그 이후 변경은 폐기
절차를 따른다.

| 항목                    | 상태        | 비고                                                                                        |
| ----------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `rustra_ffi_hot_reload` | 계획 / 실험 | 이 문서 작성 시점에는 존재하지 않는다. 계약이 깨질 수 있는 상태로 시작하도록 미리 등록한다. |

## MSRV 정책

워크스페이스 MSRV는 Rust 1.88이다: 루트 `Cargo.toml`이
`rust-version = "1.88"`을 설정하고 멤버 crate는 `rust-version.workspace = true`로
상속받는다. 이 고정은 edition 2024(1.85)에 let-chains(1.88, `rustra-macros`에서
사용)을 더한 요구치다.

MSRV bump는 마이너 릴리즈에서만 하고, 패치 릴리즈에서는 하지 않는다. API를
건드리지 않더라도 소비자 툴체인을 깰 수 있으므로 bump는 마이너 릴리즈의
변경이다.

## 릴리즈 번호 체계

프로젝트는 0.x다. 공개된 9개 `@rustra/*` npm 패키지의 버전은 changeset으로
결정된다: main에 changeset 파일이 존재하면 `release.yml`이 version-packages
PR(`chore: version packages`)을 열고, 이를 병합하면 버전 필드와 CHANGELOG가 일괄 갱신된다. crates.io 발행은
수동이다 — [릴리즈 절차](release-procedure.md)가 지정한 순서대로 crate별로
`cargo publish`를 실행하며, 발행된 버전은 삭제하거나 교체할 수 없다.

위 pre-1.0 규칙에 따라 wire format이나 contract hash 변경은 명시적인
마이그레이션 노트와 함께 마이너로 발행된다. 동일한 변경이 1.0 이후라면 메이저
버전이 필요하다.

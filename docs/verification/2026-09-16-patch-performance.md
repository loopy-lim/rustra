# 0.10.2 성능 패치 검증

기준판은 발행된 0.10.1, `1f277de2e68e2242b7a6503e6e0ab731833e60e3`다. 후보 구현과 [SPEC](../specs/2026-09-16-patch-performance.md), [PLAN](../plans/2026-09-16-patch-performance.md)은 이 문서와 같은 변경에 포함된다.

## 구현 및 호환성

- Weak IR 역참조와 codec 소유 재귀 대상 테이블로 강한 참조 순환 없이 direct serde를 지원한다. 마지막 소유자가 사라졌을 때 재귀·상호재귀 그래프가 해제되는 회귀 검사가 있다.
- optional 필드의 임시 버퍼·복사를 제거하고 예상 다음 struct 필드는 바로 찾는다. sequence 용량 힌트는 남은 입력으로 제한한다.
- map 중복 키를 거부하고 순서가 다른 정상 키는 허용한다. 0–2개 키는 별도 set을 할당하지 않으며 큰 map의 초기 예약은 64개로 제한한다.
- 공개 API, FFI ABI, wire 형식과 입력·출력 제한은 유지한다. API snapshot 변경은 비공개 complex codec 내부 항목이다.
- 입력 또는 출력이 재귀 스키마이면 양쪽 codec에 호환 fallback을 적용한다. nested nullable, flatten, typed map key, const, caller buffer 및 handler 단일 실행을 검사한다. 직접 경로 실패 후 Value 경로를 시도하는 타입/오류 입력은 추가 비용이 생길 수 있다. 핸들러 재실행은 없다.
- 독립 코드 검토에서 발견한 nullable/flatten/map 키/const 및 입력·출력 쌍의 호환 문제를 수정했고 최종 검토의 차단 사항은 없다.

## 로컬 검증

- 최종 runtime의 debug lib 테스트 211개 통과.
- `cargo test -p rustra -p rustra-macros -p rustra-naming --release --locked` 통과. 24개 suite 총335개 성공·0개 실패이며 release lib 175개, 통합·naming·문서 테스트를 포함한다. 기존 문서 예제 2개 ignored. release에서 제외되는 debug 전용 테스트 helper의 기존 dead-code 경고가 있으나 실패는 없다.
- `cargo clippy -p rustra -p rustra-macros -p rustra-naming --all-targets --locked -- -D warnings`, `cargo fmt --all -- --check` 통과.
- API snapshot 일치, 400줄 모듈 한도 및 benchmark workflow 검사 통과.
- 재귀 fixture가 추가된 `invoke_complex_serde` fuzz target 빌드 및 로컬 1,000회 smoke 통과. 로컬 smoke는 coverage 계측이 없어 정식 fuzz 증거로 세지 않는다.

## 성능 수용

[원본 JSON](../benchmark-receipts/2026-09-16-patch-performance-ab.json)과 [표·재현 방법](../benchmarks.ko.md)에 기록했다. 동일 환경·동일 fixture에서 독립 프로세스 각 5회씩 교차 실행했고 14개 case의 원시 추정값을 모두 남겼다. 시간 측정과 할당 계측은 별도 실행 파일을 사용한다. 측정 전후 소스·manifest·harness·바이너리 hash가 일치했다. 후보는 커밋 전 상태이므로 source hashes가 식별 근거이며 base HEAD만으로 후보를 식별하지 않는다. complex 측정 후 crate manifest에 tree 벤치 등록만 추가했다. 런타임 소스는 두 측정 내내 동일하며 tree receipt가 최종 manifest와 추가 harness를 기록한다.

재귀 깊이 1/8/16은 각각 78.56%/78.66%/78.06%, 64 KiB optional 문자열은 50.36%, 32필드 struct는 59.56% 지연이 감소했다. 깊이 8 할당은 81→11회다. 대조군은 2.88–9.60% 느려져 사전 10% 한도 안이다. oneOf는 +9.60%로 경계에 가까우며, 64키 map은 +6.24%와 할당 1회 증가가 있다. 더 빠른 case만 골라 전체 개선으로 일반화하지 않는다.

[중단된 초기 진단](../benchmark-receipts/2026-09-16-patch-performance-diagnostic.json)의 map/oneOf 회귀는 후보 수정의 근거로 보존했다. 최종 5회 비교에 합치거나 성공 근거로 사용하지 않았다.

## 복잡한 트리 추가 검증

균형 31/255/1,023/8,191노드, 넓은 1,025노드, 편향 15단계, 512바이트 label을 가진 255노드의 7개 형상을 추가했다. echo/전체 입력 검색/보관된 트리 ID 조회/순수 DFS의 28개 case는 같은 마지막 노드 검색을 사용한다. release 통합 fixture 테스트가 독립 wire 바이트, 노드 수·순서·형상, 검색 결과·방문 수, depth 1–40의 정확한 오류를 검증했다. 기본 codec depth 32에서 이 복합 노드의 허용 깊이는 15다. 새 bench/example/test clippy 및 build 통과.

독립 정적 검토에서 공통 fixture helper hash 누락을 발견해 보완했다. 수정 전 첫 baseline 과정은 중단하고 [진단 기록](../benchmark-receipts/2026-09-16-tree-performance-diagnostic.json)으로 보존하며 최종 수용 근거에 사용하지 않는다. resident와 순수 DFS는 메모리 배치가 달라 시간의 단순 차감을 호출 overhead로 해석하지 않는다. 초기 트리 보관/클론은 시간 측정 밖이다.

트리 [최종 5+5회 receipt](../benchmark-receipts/2026-09-16-tree-performance-ab.json)의 28개 case는 모두 10% 회귀 예산 안이다. 균형 8,191노드 echo는 25.805→8.675 ms(-66.38%), 전체 입력 검색은 13.235→4.776 ms(-63.92%)다. 7개 형상 echo는 63.50–66.38%, search는 59.80–63.92% 개선됐다. resident/pure DFS는 -1.59~+2.12% 범위다. 동일한 트리의 후보 resident 조회는20.459 µs이며 초기 보관 비용과 변경/잠금 비용은 포함하지 않는다. 순수 탐색은 할당0, resident는 응답할당1회다. 새 Criterion case는 원격 첫 실행에서 기준선을 생성하므로 첫 CI 성공을 Linux A/B 결과로 해석하지 않는다.

## 발행 및 남은 증거

이 기록 작성 시점은 PR 통합 전이다. 최종 main SHA의 CI와 정식 Release가 새로 실행하는 Miri, ASan/LSan, 3개 fuzz target을 통과해야 Rust `rustra`, `rustra-macros`, `rustra-naming` 0.10.2를 발행한다. 발행 후 `scripts/audit-release-registry.mjs`로 버전·latest·VCS SHA·checksum·yanked를 확인한다. npm 변경은 없고 독립 버전을 유지한다. 배포 완료 여부는 해당 Actions와 레지스트리 감사 결과로 판단한다.

Linux는 Alpha다. 코어 fixture 결과는 JS/호스트 경계, 실제 앱 p95, 실기기, CPU/RSS·에너지, 장시간 운용을 검증하지 않는다. 로드맵 G3나 전체 로드맵 완료를 뜻하지 않는다.

## PR CI의 Android 환경 수정

첫 PR CI [35055712343](https://github.com/loopy-lim/rustra/actions/runs/35055712343)에서 Android 두 잡은 runtime 빌드 전 SDK 설치 단계에서 `Failed to find package 'tools'`로 실패했다. [setup-android v4의 공식 입력](https://github.com/android-actions/setup-android/blob/v4/action.yml)은 기본 `tools platform-tools`를 `packages`로 덮어쓸 수 있다. 두 잡 모두 `platform-tools`를 명시하고, action이 설치하는 cmdline-tools 및 다음 단계의 NDK/platform/build-tools 설치는 유지한다. 변경은 CI 설정뿐이며 측정한 Rust 소스·manifest·harness는 바뀌지 않는다. 해결 여부는 후속 전체 CI의 SDK 설치와 Android 빌드·기동 검사로 판정한다.

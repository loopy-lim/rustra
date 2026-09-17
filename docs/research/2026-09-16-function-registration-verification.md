# 일반 함수 등록 — 구현 및 성능 검증

2026-09-16 KST. 승인된 일반 동기 함수 등록 기능의 구현과 로컬 검증을 완료했다.
사용법은 [일반 함수 등록](../function-registration.ko.md), 원시 측정값·검증 요약·변경
소스 해시는 [JSON receipt](./2026-09-16-function-registration-verification.json)에 있다.

## 구현 결과

```rust
fn add(a: i32, b: i32) -> i32 { a + b }
fn reset() {}

let package = rustra::Package::builder("app")
    .function("add", add)
    .function("reset", reset)
    .build();
```

생성된 TypeScript는 `await add(2, 3)`와 `await reset()`으로 호출한다.

- 인자 0~12개, 일반 반환값과 반환값 없는 함수를 지원한다. 입력·출력 래퍼 구조체와
  Rustra 매크로, `Result` 반환을 요구하지 않는다.
- 실패할 수 있는 함수는 `.try_function(name, handler, map_error)`로 등록한다.
  `.function`은 `Result`를 자동으로 풀지 않는다.
- 안전한 `Fn` 트레잇 어댑터가 기존 명령 실행 경로를 재사용한다. 기존 command
  API와 메타데이터는 유지하며, 새 명령의 `functionArgs`를 계약 해시에 포함한다.
- 양쪽 명령 생성기가 위치 인자와 `Promise<void>`를 만든다. 인자 이름은
  `arg0`, `arg1`이며 Rust 소스의 이름을 읽지는 않는다.
- 지원하는 최상위 튜플·스칼라·unit·컬렉션을 바이너리로 처리한다. 스칼라 튜플은
  커서 인코더와 요청 버퍼를 재사용하고, Rust는 호출자가 제공한 응답 버퍼에 쓴다.
- Node와 Tauri JSON 어댑터는 인자가 없는 함수의 명시적인 `null`을 보존한다.

## 측정 조건과 결과

환경: Darwin arm64, Rust/Cargo 1.98.0, Bun 1.4.1, Node 22.21.1.
CPU 모델명은 sandbox에서 `sysctl` 조회가 허용되지 않아 기록하지 못했다.
컨트롤러의 빌드·테스트가 끝난 후 Rust, JS 순으로 측정했다. 다른 시스템 활동을
통제한 실험실 측정은 아니며, 아래 수치는 이 로컬 실행의 결과다.

### Rust: 같은 덧셈을 수행하는 두 등록 API

`20 + 22`의 값과 응답 바이트를 측정 전에 검증했다. Criterion은 항목마다
1초 예열, 3초 측정, 100개 표본을 사용했다. 표는 회귀 기울기 추정값과 95% 신뢰구간이다.

| 경로 | 일반 함수 ns/호출 | 기존 구조체 command ns/호출 |
| --- | ---: | ---: |
| 새 응답을 할당하는 `invoke_frame` | 45.436 [45.310, 45.582] | 46.067 [45.910, 46.248] |
| 응답 버퍼를 재사용하는 `invoke_frame_into` | 15.452 [15.405, 15.510] | 15.366 [15.346, 15.390] |
| JSON 입력 생성 + `invoke_json` | 49.150 [48.993, 49.338] | 332.72 [324.85, 340.01] |

일반 함수의 응답 버퍼 재사용은 할당 경로보다 이 작업에서 약 **2.94배** 빨랐다.
같은 버퍼 경로에서 두 등록 API의 비용은 비슷했다. JSON 항목은 인자 배열 또는
필드 이름이 있는 객체를 `serde_json::Value`로 만드는 비용을 포함한다. 입력 표현이
다르므로 JSON 수치를 함수 어댑터 자체의 개선율로 해석하면 안 된다.

준비와 검증을 제외하고 실제 할당자를 계측한 테스트 결과:

| Rust 성공 응답 경로 | 힙 할당 | 핸들러 실행 |
| --- | ---: | ---: |
| 스칼라, 충분한 응답 버퍼 | 0회 | 1회 |
| unit, 정확히 8바이트 응답 버퍼 | 0회 | 1회 |
| 새 응답 할당 | 1회 | 1회 |
| 응답 버퍼 부족 시 폴백 | 1회 | 1회 |

### JavaScript: 생성된 요청 인코더

실제 Rust 스키마에서 생성한 `add` 코덱을 Bun에서 실행했다. 두 번 예열하고,
실행 순서를 번갈아 20개 표본을 수집했다. 표본마다 50,000번 실행하며 입력값을
변경하고 결과 바이트를 checksum에 반영했다.

| 경로 | 중앙값 ns/요청 | 표본 최솟값–최댓값 |
| --- | ---: | ---: |
| `encode` | 417.11 | 387.24–439.88 |
| 재사용 버퍼의 `encodeInto` | 49.18 | 39.60–66.27 |

이 요청 인코딩 작업의 중앙값 기준 약 **8.48배** 차이다. 측정에는 바이트를 확인하는
view 접근이 포함된다. 실제 전송의 정확한 크기 `ArrayBuffer` 복사, Promise,
브리지와 Rust 호출은 포함하지 않는다. 전체 JS 경로의 무할당을 주장하지 않는다.

## 검증 결과

| 검사 | 결과 |
| --- | --- |
| 전체 `rustra` 테스트 및 doctest | 373 통과, 2 ignored, 실패 0 |
| types | 271 통과 |
| CLI | Node 318 + Bun 34 통과 |
| 실제 함수 통합 | 18개 명령, 308개 검증 통과 |
| 기존 예제 코드 생성 | 6개 예제 재현 일치, 생성물 수정 없음 |
| workspace TS 빌드, Rustfmt, Clippy `-D warnings` | 통과 |
| API surface, architecture, docs, release coherence, diff 검사 | 통과 |
| 독립 전체 변경 리뷰와 수정 재검토 | Spec PASS / Quality PASS, 남은 지적 0 |

통합 검사는 CLI와 Rust가 생성한 명령 wrapper를 CLI가 생성한 타입 정의와 함께
컴파일하고 실행한다. 정적·라이브 코덱, 버퍼 재사용, 네이티브 capability 거절 시
폴백, 실제 Rust 프로세스로의 Node JSON 요청, Tauri JSON 어댑터를 확인한다.
생성 C++는 JSI shim과 컴파일해 새 함수가 지원하지 않는 네이티브 코덱을 광고하지
않는지 확인했다. 실제 React Native 런타임 실행 검사는 아니다.

마지막 깊이 경계 수정 전에도 Node Bun 74 통과(29 skip), Node 실제 런타임 71 통과,
Tauri 47 통과를 확인했다. 해당 어댑터 소스는 이후 변경하지 않았다. 마지막 수정
후에는 위 전체 Rust/types/CLI와 통합 검사를 다시 실행했다.

회귀 검사는 닫힌 구조체, Option/Vec의 참조 깊이, i8 경계값, 고정 배열, unit,
오류 변환, 비유한 숫자, 인자 개수, 작은 응답 버퍼를 포함한다. 기존 깊은 구조체의
요청 `[1,0,6,8,10]`과 응답 `[1,0,0,0,0,0,0,0,6,8,10]`을 실제 Rust와
정적·라이브 TS에서 유지하며, 생성 디코더의 중첩 변수 충돌도 수정했다.

## 재현과 남은 범위

작업 디렉터리: `.worktrees/function-registration`, 브랜치: `codex/function-registration`.
기준 커밋: `1f277de2e68e2242b7a6503e6e0ab731833e60e3`. 변경은 아직 커밋하지 않았으므로
기준 커밋만으로 측정 소스를 식별할 수 없다. JSON receipt의 변경 코드·테스트 55개
파일 해시와 manifest SHA-256을 함께 사용한다.

```sh
bun run test:functions
bun scripts/function-registration-integration.ts --cpp
cargo test -p rustra --locked
cargo bench -p rustra --bench function_dispatch
bun scripts/function-registration-integration.ts --bench
```

전체 검증은 root와 두 RN 예제에서 `bun install --frozen-lockfile --ignore-scripts`로
의존성을 준비했다. Node 실제 런타임 검사는 calculator Rust 빌드와 해당 TS 컴파일이
선행되어야 한다. 전체 예제 freshness는 기본 Cargo target 디렉터리에서 실행한다.

이번 완료 범위는 일반 동기 함수 등록 기능이다. 실제 RN/Tauri 앱·기기 성능,
패키지 설치 소비자와 레지스트리 배포, 1.0 준비 완료를 검증한 것은 아니다.
문자열·컬렉션의 소유 메모리와 작은 버퍼 폴백은 할당할 수 있다. 비동기 일반 함수,
소스 인자 이름 반영, 새 네이티브 raw 단축 경로는 후속 범위다.

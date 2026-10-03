[English](./README.md)

# rustra

하나의 Rust 코어 → Node, Bun, Tauri, React Native 어디서든 동작하는 타입 안전
클라이언트 — compact 바이너리 와이어 위에서, CI에서 breaking 스키마 변경을
막는 계약 게이트로 지켜진다.

[![CI](https://github.com/loopy-lim/rustra/actions/workflows/ci.yml/badge.svg)](https://github.com/loopy-lim/rustra/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@rustra/types)](https://www.npmjs.com/package/@rustra/types)
[![crates.io](https://img.shields.io/crates/v/rustra.svg)](https://crates.io/crates/rustra)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Rust에서 한 번 정의한다:

```rust
#[bridge_type]
struct AddNumbersInput { a: i64, b: i64 }
#[bridge_type]
struct AddNumbersOutput { sum: i64 }

#[command]
fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput { sum: input.a + input.b })
}
```

어떤 호스트에서든 호출한다. `rustra codegen`은 플랫폼별 타입 안전 클라이언트를
생성한다 — 같은 계약, 같은 바이너리 와이어:

```ts
import { addNumbers } from './generated/node.js';

const { sum } = await addNumbers({ a: 42, b: 58 });
```

구조체 없이 쓰고 싶다면? 같은 코어에 일반 Rust 함수도 그대로 등록된다:

```rust
fn add(a: i32, b: i32) -> i32 { a + b }

let package = Package::builder("app.functions")
    .function("add", add)
    .build();
```

`PackageBuilder::function`은 매크로 없이 0~12개 위치 인자 함수를 등록한다 —
래퍼 구조체도 `#[bridge_type]`도 필요 없다. async 핸들러나 상태 주입이
필요하면 `#[command]` 매크로 경로를 쓴다. 자세한 내용:
[일반 함수 등록](docs/function-registration.ko.md).

아래 성능 수치는 저장소에 검증 근거로 남아 있는 값을 그대로 인용한 것이다
(참고: [벤치마크 하이라이트](docs/marketing/benchmark-highlights.md)):

- 요청 페이로드: Frame 와이어에서 **4 B** vs JSON **47 B** — 약 11.8× 작음
  (페이로드 바이트 기준이며 end-to-end RTT가 아님)
- 코어 왕복: 평균 **134 ns** — JSON 경로보다 약 8.9× 빠름
- Node N-API Frame 핫 경로: **793,185 ops/s** (원샷 경로 363/s 대비 약 2,188×)
- React Native: Nitro HybridObject와 **±5%** 이내 패리티 (iOS 시뮬레이터)

처음이라면? [시작하기](docs/getting-started.ko.md)에서 한 명령으로 첫
Rust→TypeScript 호출을 만든다.

## 작동 방식

```
Rust #[command] 정의 → TypeScript 클라이언트 자동 생성 → 각 플랫폼 어댑터로 실행
```

- Rust 쪽에서 `#[command]`로 함수를 정의
- `generate_typescript()`가 계약을 `schema.json`으로 발행하고, `rustra codegen`이
  그 파일에서 타입 안전 TS 클라이언트 코드를 렌더링
- Node, Bun, Tauri, React Native 어댑터가 동일한 `EngineClient` 인터페이스로 라우팅
- 일반 Rust 함수도 그대로 — `PackageBuilder::function`으로 매크로 없이 0~12 인자
  함수를 등록한다 ([일반 함수 등록](docs/function-registration.ko.md))

## 왜 rustra인가 (비교)

단일 Rust 코어를 여러 JS 호스트에 잇는 도구는 각자 다른 지점을 타협한다:

|                               | **rustra**                                                            | napi-rs                                           | Nitro Modules | Tauri commands | tauri-specta |
| ----------------------------- | --------------------------------------------------------------------- | ------------------------------------------------- | ------------- | -------------- | ------------ |
| 단일 Rust 코어 × 멀티 호스트  | ✅ Node/Bun/Tauri/RN                                                  | Node (+ Electron)                                 | RN 중심       | Tauri 전용     | Tauri 전용   |
| 타입 안전 코드젠 (양방향)     | ✅ 커맨드+이벤트                                                      | Rust 구조체에서 TS 정의 생성 (어트리뷰트 매크로)¹ | ✅            | ❌ (수동)      | ✅           |
| compact 바이너리 와이어       | ✅ Frame ([JSON 대비 요청 와이어 11.8× 작음](docs/wire-format.ko.md)) | JSON/Buffer                                       | JSI 객체      | JSON IPC       | JSON IPC     |
| 계약 게이트 (breaking change) | ✅ `rustra diff` + contract hash                                      | ❌                                                | ❌            | ❌             | 부분         |
| 취소/타임아웃/배치 시맨틱     | ✅ 매트릭스로 문서화                                                  | 직접 구현                                         | 직접 구현     | ❌             | ❌           |

rustra의 선택: **RPC 표면 전체(정의→코드젠→와이어→검증)를 하나의 계약으로
소유**한다. 명령 호출과 계약 검증은 호스트 간 공통으로 유지하고, 취소·이벤트·채널
같은 capability 차이는 [호환성 매트릭스](docs/compatibility-matrix.ko.md)에 명시한다.

¹ 2026-09-05 napi-rs 문서 대조 검증: napi-rs는 어트리뷰트 매크로(`#[napi(object)]`)
로 Rust 구조체에서 TypeScript 정의를 생성한다 — "수동" 표기는 이를 과소 평가한
것이었다. rustra 셀의 차별점은 타입·이벤트·검증 게이트가 모든 호스트에서 하나의
공유 스키마로 나온다는 것이지, 다른 도구에 코드젠이 없다는 주장이 아니다.

## 5분 퀵스타트

Rust와 Bun 1.4 이상이 설치되어 있으면 다음 명령으로 프로젝트 생성부터 첫 호출까지 실행한다:

```bash
bunx --bun @rustra/cli@0.12.0 init my-project --setup
# Bun FFI를 쓰려면: bunx --bun @rustra/cli@0.12.0 init my-bun-project --host bun --setup
```

`--setup`은 클라이언트 생성, 의존성 설치, Rust 빌드, 스캐폴드의 `echo` 데모 실행을
한 번에 한다. `my-project/src/lib.rs`를 수정한 뒤:

```bash
cd my-project
bun run start
```

`start`는 setup과 데모를 다시 실행하며, `bun run setup`은 데모 없이 준비만 한다.
실패하면 오류를 해결하고 출력된 `rustra setup` 명령으로 재시도한다. RN/Tauri의
setup은 연동을 준비하고 남은 네이티브 앱 작업을 안내한다. 실기기·WebView 런타임
검증을 대신하지는 않는다.

발행 패키지 대신 이 저장소 체크아웃을 체험하려면 `bun run try:node` 또는
`bun run try:bun`을 실행한다 — 독립 예제를 만들고 체크아웃 패키지를 설치한 뒤
첫 Rust 호출을 실행한다.

내부 동작은 이렇다: 스캐폴드의 Rust 프로브가 `schema.json`을 발행하고,
`rustra codegen`이 그 단일 파일에서 모든 TS 표면을 렌더링한다. 설정은 프로젝트
루트의 `rustra.json`이다:

```json
{
  "schema": "./generated/schema.json",
  "output": "./generated",
  "node": {}
}
```

```bash
bunx --bun @rustra/cli@0.12.0 codegen --config rustra.json   # 모든 표면 렌더링
bunx --bun @rustra/cli@0.12.0 dev --config rustra.json       # Rust 감시 + 재생성
bunx --bun @rustra/cli@0.12.0 generate --config rustra.json --check   # CI 동기화 게이트
```

→ 전체 워크스루: [시작하기 가이드](docs/getting-started.ko.md)
([10분 요약](docs/getting-started.md#10-minute-summary)).

### 설치

```toml
[dependencies]
rustra = "0.12.0"
serde = { version = "1", features = ["derive"] }
schemars = { version = "0.8", features = ["derive"] }
```

설치 버전은 현재 Rust·npm manifest를 기준으로 한다. 어댑터는 독립 버전이며,
manifest 기반 [호환 표](docs/compatibility-matrix.ko.md)를 설치 기준으로 삼는다.

```bash
bun add @rustra/node@0.11.0          # Node.js
bun add @rustra/bun@0.11.0           # Bun
bun add @rustra/tauri@0.10.0         # Tauri
bun add @rustra/react-native@0.10.0  # React Native
bun add @rustra/testing@0.7.2        # Mock 엔진 (테스트)
bun add @rustra/devtools@0.7.2       # 호출 관측성 (개발)
```

네이티브 라이브러리·JS 어댑터·생성물은 함께 갱신한다 —
[마이그레이션 가이드](docs/migration-guide.ko.md)와
[0.11 → 0.12 마이그레이션 노트](docs/migrations/0.11-to-0.12.ko.md)를 참고한다.

## 자세한 내용은 문서에서

이전 README가 담고 있던 전체 섹션은 각각 docs로 옮겨졌고, CI 문서 게이트로
동기화를 유지한다:

| 주제                                           | 현재 위치                                                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Rust API (`#[command]`, `build!`, 제네릭)      | [Rust API 가이드](docs/rust-api-guide.ko.md)                                                                           |
| 호스트별 이벤트와 채널                         | [이벤트·채널 가이드](docs/events-and-channels.ko.md)                                                                   |
| React Native 설정 (iOS JSI / Android)          | [RN 설정 가이드](docs/extending/react-native-setup.ko.md)                                                              |
| 기존 Tauri 앱에 rustra 얹기                    | [Tauri 설정 가이드](docs/extending/tauri-setup.ko.md)                                                                  |
| transport 교체 (napi-rs, FFI)                  | [Transport 가이드](docs/extending/transport-guide.ko.md)                                                               |
| 성능 표와 검증 근거                            | [벤치마크](docs/benchmarks.ko.md) · [벤치마크 하이라이트](docs/marketing/benchmark-highlights.md)                      |
| 와이어 포맷과 11.8× 주장의 범위                | [와이어 포맷](docs/wire-format.ko.md)                                                                                  |
| 로드맵 상태와 릴리스 이력                      | [로드맵 스펙](docs/specs/2026-09-14-rustra-roadmap.md) · [로드맵 상태](docs/verification/2026-09-16-roadmap-status.md) |
| 버전 관리와 폐기 정책                          | [버전 정책](docs/versioning-policy.ko.md)                                                                              |
| 마이그레이션 노트 (0.3→0.4, 0.5→0.6, post-0.9) | [마이그레이션 가이드](docs/migration-guide.ko.md) · [마이그레이션 노트](docs/migrations/)                              |
| 위협 모델과 보안 감사                          | [위협 모델](docs/threat-model.ko.md) · [보안 감사](docs/security-audit.ko.md) · [보안 정책](.github/SECURITY.md)       |
| 호스트별 검증 근거                             | [검증 체크리스트](docs/verification-checklist.ko.md) · [호환성 매트릭스](docs/compatibility-matrix.ko.md)              |
| 에러 코드와 처리                               | [에러 코드](docs/error-codes.ko.md)                                                                                    |
| `rustra doctor` / `dev` / drift 게이트         | [개발 허들 가이드](docs/development-hurdles.ko.md)                                                                     |
| 아키텍처와 transport 분리                      | [아키텍처 개요](docs/architecture.ko.md)                                                                               |
| 크레이트·패키지 구조                           | [크레이트 구조](docs/dev/internal/crate-structure.ko.md)                                                               |
| 실행 가능한 예제 (Node/Bun/Tauri/RN)           | [예제 갤러리](docs/README.ko.md#예제-갤러리)                                                                           |

## 실사용 예시

생성된 host 진입점이 연결을 소유하므로 제품 코드에는 transport 설정이 남지 않는다.
아래 코드는 모두 같은 Rust `addNumbers` 명령을 호출한다.

```ts
// Node 배치 작업 — 기본 one-shot 경로는 저빈도 CLI에 적합하다.
import { addNumbers, rustra } from './generated/node.js';

try {
  const { value } = await addNumbers({ a: 20, b: 22 });
  console.log(value);
} finally {
  rustra.dispose();
}
```

요청이 계속 들어오는 서버에서는 `createNodeLoopTransport`를, 마이크로초 단위 호출이
필요하면 N-API Frame fast-path를 선택한다. 실제 코드는
[`node-app.ts`](examples/calculator/apps/node-app.ts)와 성능별 선택을 담은
[`node-performance.ts`](examples/calculator/apps/node-performance.ts)에 있다.
Bun FFI, Tauri WebView, React Native JSI equivalents는
[예제 갤러리](docs/README.ko.md#예제-갤러리)에 있다 — 실제 WebView IPC 근거를 포함한
[Tauri 계산기](examples/tauri-calculator/)와
[Expo](examples/react-native-calculator/App.tsx) /
[bare RN](examples/react-native-bare-calculator/App.tsx) 계산기도 포함된다.

## 문서

전체 문서는 [`docs/`](docs/README.ko.md)에 있다 — 허브는 Tauri, React Native,
Node/Bun 사용자별 읽기 경로를 제공한다.

| 문서                                                                | 내용                                                        |
| ------------------------------------------------------------------- | ----------------------------------------------------------- |
| [시작하기](docs/getting-started.ko.md)                              | 설치, 첫 패키지 만들기, 어댑터 선택                         |
| [이벤트·채널 가이드](docs/events-and-channels.ko.md)                | 호스트별 `subscribeEvent`/`createChannel` 사용법            |
| [아키텍처 개요](docs/architecture.ko.md)                            | 데이터 흐름, EngineClient 계약, transport 분리              |
| [Transport 교체 가이드](docs/extending/transport-guide.ko.md)       | Bun FFI, Node napi-rs 교체                                  |
| [React Native 설정 가이드](docs/extending/react-native-setup.ko.md) | iOS JSI 모듈 설정, 사용법, 트러블슈팅                       |
| [Tauri 설정 가이드](docs/extending/tauri-setup.ko.md)               | 기존 Tauri 앱에 rustra 얹기, 파일별 워크스루                |
| [개발 허들 가이드](docs/development-hurdles.ko.md)                  | doctor, 통합 codegen, drift, native 경계, mock 엔진         |
| [API 레퍼런스(생성)](docs/README.ko.md#api-레퍼런스typedoc)         | 모든 `@rustra/*` 패키지의 TypeDoc HTML — `bun run docs:api` |
| [새 Host 추가 가이드](docs/extending/adding-host.ko.md)             | Electron, Deno 등 새 어댑터 추가                            |
| [전체 문서 목록](docs/README.ko.md)                                 | 사용자 / 기여자별 읽기 경로                                 |

## 기여

[CONTRIBUTING.md](CONTRIBUTING.md)를 참고한다. 저장소 개발 전제 조건과 워크스페이스
명령(Rust 1.95.0, Node 22.6+, Bun 1.4+)은 같은 문서와
[시작하기 전제 조건](docs/getting-started.ko.md#전제-조건)에 정리되어 있다.

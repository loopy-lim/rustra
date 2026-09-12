# @rustra/cli

rustra-bridge의 TypeScript 코드 제너레이션 CLI입니다. Rust 백엔드가 내보낸
`schema.json`으로부터 타입 안전 클라이언트(commands/types/contract/frame codec)를 생성합니다.

## 사용법

```sh
# 1. schema + TS/C++/RN 통합 생성
rustra codegen --config rustra.json

# 2. schema만 이미 있고 생성물을 다시 렌더링
rustra generate --schema ./generated/schema.json --output ./src/generated

# 3. C++ 코덱(RN JSI fast path용) 동시 생성
rustra generate --schema ./gen/schema.json --output ./src/generated --cpp-output ./ios

# 4. 개발 모드 (Rust 소스 변경 감시 + 통합 codegen)
rustra dev --config rustra.json

# 5. 생성물 동기화 검증 (CI 게이트용)
rustra generate --config rustra.json --check

# 6. 스키마 버전 간 breaking change 검증 (CI 게이트용)
rustra diff --old ./schema.v1.json --new ./schema.v2.json

# 7. 새 프로젝트 스캐폴드 초기화
rustra init my-app
```

전체 옵션은 `rustra --help`로 확인하세요.

**실험적 dylib dev 타깃**: `rustra dev`에서 `dev.target: "dylib"`를 쓰면 엔진
코어를 cdylib 으로 빌드해 네이티브 hot-core 스왑 루프에 쓸 수 있습니다 — 호스트가
`RUSTRA_HOT_CORE`로 아티팩트를 받아 재시작 없이 반영합니다(parity 게이트는 wasm
타깃과 동일하게 결합). 동작 예제는
[tauri-calculator 예제](../../examples/tauri-calculator/README.ko.md)와
[hot-core 설계](../../docs/plans/2026-09-09-native-hot-core-design.md)를
참고하세요. dylib 루프는 별도 config 파일로 유지하고(예: `dev.target: "dylib"`를
넣은 `rustra.hot.json`) `rustra dev --config rustra.hot.json`으로 실행하세요 —
공유 config는 기본 `native` 타깃을 유지합니다(tauri-calculator 예제가 쓰는
패턴).

## 라이브러리 API

CLI와 동일한 생성기를 프로그램에서 직접 사용할 수 있습니다:

```ts
import { generateTypesTs, generateCommandsTs, diffSchemas } from '@rustra/cli';
```

| 모듈              | 내용                                                     |
| ----------------- | -------------------------------------------------------- |
| `generate`        | types/commands/contract/frame codec/registry 생성 함수군 |
| `schema`          | `PackageSchema` 파싱·검증                                |
| `schema-diff`     | 스키마 버전 간 breaking change 검출 (`diffSchemas`)      |
| `validate-engine` | 런타임 invoke 검증 엔진 래퍼 (`createValidatedEngine`)   |

## 관련 문서

- [rustra-bridge](https://github.com/loopy-lim/rustra#readme)
- `docs/getting-started.md` — 전체 파이프라인 (Rust `generate_typescript` → CLI)

`rustra dev --config rustra.json`은 설정 변경을 다시 읽고 새로 생기거나 삭제·교체된
소스 경로를 감시합니다. 100 ms마다 파일 상태를 비교하므로 Node/Bun에서
`fs.watch` 감시 자원이 부족해져도 네이티브 감시 핸들에 의존하지 않습니다.

`uniffi` 프로젝트의 `rustra codegen --check`는 Rust mirror와
schema/TypeScript/C++ 생성물을 검사합니다. 실제 Kotlin·Swift·헤더·modulemap까지
검사하는 별도 CI 게이트는 `rustra codegen --check-bindings`입니다. 이 옵션은
`--check`를 포함하며 라이브러리를 빌드하고 빈 임시 디렉터리에서 bindgen을 실행한 뒤
`uniffi.output`의 전체 경로와 바이트를 비교합니다. 커밋된 파일은 바꾸지 않습니다.
일반 생성도 새 산출물 검증을 마친 뒤에만 바인딩 디렉터리를 교체하며 오래된 파일을
제거합니다. 라이브러리는 Cargo가 보고한 실제 경로를 사용하고, 프로젝트의 빌드
타깃이 달라도 bindgen은 Rust 호스트 타깃으로 실행합니다.

### 바인딩 출력 경계

`uniffi.output`은 바인딩 전용 디렉터리여야 한다. CLI는 Rust probe 실행 전에
경로를 정규화하여 schema·TypeScript 출력과의 중첩, Cargo manifest·Rust 소스 루트를
덮는 경로를 거부한다. `uniffi/` 또는 `src/bindings/`처럼 별도 하위 디렉터리를 사용한다.
전체 디렉터리를 교체하므로 수동 작성 파일을 함께 두지 않는다. 감시는 바인딩 출력과
그 교체용 임시 디렉터리를 제외한다.

### 저장소 검사 런타임

저장소의 TypeScript 프로세스 테스트는 Node 22의 `--experimental-strip-types`를
사용한다. 발행된 CLI의 Node 18 최소 지원 계약과 별개다. `test:codegen-fresh`는
CLI를 빌드한 뒤 Node에서 6개 설정 예제를 검사하고, `test:bindings-fresh`는
UniFFI 설정 예제만 골라 실제 Swift/Kotlin 생성을 검사한다.

### Hot-core 라이브러리 보관 진단

hot-core는 이미 로드한 라이브러리의 심볼 안전성을 위해 프로세스 종료까지 라이브러리를
보관한다. `rustra::hot_core::retained_library_stats()`의 `libraries`는 실패한 심볼
바인딩을 포함한 누적 보관 로드 수, `artifact_bytes`는 로드한 파일 크기의 합이다.
메모리 상주량(RSS)을 측정한 값이 아니다. `restart_recommended()`는 누적 32회부터
true이며, 32회마다 로그로 호스트 재시작을 권고한다. 메모리를 해제하려면 개발 호스트를
재시작한다. 코어 객체를 drop해도 라이브러리는 언로드하지 않는다.

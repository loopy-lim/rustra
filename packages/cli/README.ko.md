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

# @rustra/cli

rustra-bridge의 TypeScript 코드 제너레이션 CLI입니다. Rust 백엔드가 내보낸
`schema.json`으로부터 타입 안전 클라이언트(commands/types/contract/rkyv codec)를 생성합니다.

## 사용법

```sh
# 1. 코드 생성 (기본)
rustra generate --schema ./generated/schema.json --output ./src/generated

# 2. C++ 코덱(RN JSI fast path용) 동시 생성
rustra generate --schema ./gen/schema.json --output ./src/generated --cpp-output ./ios

# 3. 개발 모드 (Rust 소스 변경 감시 + 자동 재빌드 및 재생성)
rustra dev --backend ./backend --app ./app

# 4. 스키마 버전 간 breaking change 검증 (CI 게이트용)
rustra diff --old ./schema.v1.json --new ./schema.v2.json

# 5. 새 프로젝트 스캐폴드 초기화
rustra init --name my-app
```

전체 옵션은 `rustra --help`로 확인하세요.

## 라이브러리 API

CLI와 동일한 생성기를 프로그램에서 직접 사용할 수 있습니다:

```ts
import { generateTypesTs, generateCommandsTs, diffSchemas } from '@rustra/cli';
```

| 모듈              | 내용                                                    |
| ----------------- | ------------------------------------------------------- |
| `generate`        | types/commands/contract/rkyv codec/registry 생성 함수군 |
| `schema`          | `PackageSchema` 파싱·검증                               |
| `schema-diff`     | 스키마 버전 간 breaking change 검출 (`diffSchemas`)     |
| `validate-engine` | 런타임 invoke 검증 엔진 래퍼 (`createValidatedEngine`)  |

## 관련 문서

- [rustra-bridge](https://github.com/loopy-lim/hostra#readme)
- `docs/getting-started.md` — 전체 파이프라인 (Rust `generate_typescript` → CLI)

# 개발 허들 완화 설계

- 날짜: 2026-08-29
- 상태: 사용자 승인 후 구현 전 설계
- 범위: CLI 진단, 설정 기반 codegen, 개발 감시, drift 게이트, init/RN 템플릿, 사용자 문서

## 1. 문제 정의

현재 rustra는 Rust 애플리케이션 코드에서 `schema.json`을 만들고, CLI가 그
스키마에서 TypeScript/C++ 산출물을 만드는 구조다. 저장소에는 이미
`rustra generate`, `rustra dev`, `rustra init`, 복합 binary codec, Tier 3 JSON
fallback, RN generated autolinking, `clean:*` 명령이 있다. 하지만 다음 허들이
사용자에게 한 번에 보이지 않거나 수동 순서에 남아 있다.

1. 프로젝트가 실제로 사용하는 host에 따라 필요한 툴체인을 선별해 진단하는
   명령이 없다.
2. `rustra dev`가 관례적인 `backend/app` 디렉터리와 `generate` Cargo binary를
   전제로 하며, 기존 `rustra.json`과 파이프라인 설정을 공유하지 않는다.
3. Rust schema 단계와 TS/C++ codegen 단계를 별도 명령으로 기억해야 한다.
4. generated 산출물이 현재 schema와 다른지 CI에서 읽기 전용으로 검사하는
   표준 명령이 없다.
5. 템플릿과 문서에 현재의 독립 버전 정책, RN native build 경계, complex
   codec/Tier 3 선택 규칙이 일관되게 반영되지 않은 부분이 있다.

## 2. 목표와 비목표

### 목표

- 첫 실행 전에 현재 host 구성에 맞는 누락 도구와 해결 방법을 알려준다.
- `rustra.json` 하나로 Rust schema 생성부터 모든 generated 산출물 생성을
  재현한다.
- 개발 중 Rust 변경을 자동으로 감지하고, 실패한 단계가 다음 변경에서
  다시 실행되도록 한다.
- CI에서 generated 파일과 계약 drift를 fail-closed 방식으로 검출한다.
- `rustra init`의 첫 실행 경로가 설치, 진단, codegen, 개발 감시 순서를
  직접 안내한다.
- 문서가 현재 구현된 완화책과 아직 제거할 수 없는 경계를 구분한다.

### 비목표

- 임의의 사용자 Rust command를 범용 prebuilt staticlib로 제공하지 않는다.
  staticlib은 사용자의 command와 schema를 포함하므로 앱별 산출물이다.
- Expo Go에서 사용자 JSI native module을 실행하도록 우회하지 않는다.
  Expo Go는 앱별 native module을 포함하지 않으므로 development build가
  필요하다.
- FFI 포인터를 없애거나 Rust의 cross-language 입력을 borrowed/reference
  타입으로 허용하지 않는다. 이 경계는 소유권과 ABI 안전성의 계약이다.
- `command_id`를 무제한으로 늘리거나 release registry mutation을 허용하지
  않는다.
- 네트워크를 통해 툴체인을 자동 설치하거나, 사용자의 시스템 파일을
  자동 삭제하지 않는다.

## 3. 설계 개요

### 3.1 명령 표면

기존 명령은 유지하고 다음 두 명령을 추가한다.

```text
rustra doctor [--config rustra.json] [--format text|json] [--strict]
rustra codegen --config rustra.json [--check]
rustra dev --config rustra.json [--inspect]
```

`rustra codegen`은 다음 순서를 단일 진입점으로 소유한다.

```text
config 읽기
  -> Rust generator 실행
  -> schema.json 확인
  -> TS/C++/host entry 생성
  -> generated manifest 기록 또는 --check 비교
```

기존 `rustra generate --config`는 schema를 입력으로 하는 하위 단계로
유지한다. 기존 직접 사용자는 변경 없이 동작해야 한다.

### 3.2 설정 확장

기존 `schema`, `output`, host 설정은 유지한다. Rust 단계의 모호함을 없애기
위해 선택적 `codegen` 설정을 추가한다.

```json
{
  "schema": "./generated/schema.json",
  "output": "./generated",
  "codegen": {
    "rustManifest": "./Cargo.toml",
    "rustPackage": "rustra-app",
    "rustBinary": "generate"
  },
  "reactNative": {}
}
```

규칙:

- `rustManifest`가 없으면 config 디렉터리부터 상위로 Cargo workspace를
  탐색한다.
- `rustPackage`가 없으면 manifest에 해당하는 package를 선택한다.
- `rustBinary`가 없으면 `generate`를 우선 선택하고, 하나의 binary만 있으면
  그것을 선택한다. 여러 후보면 후보 목록과 설정 예시를 포함한 오류를
  반환한다.
- 경로와 이름은 기존 host 설정과 같은 안전한 문자열 검증을 적용한다.
- config의 `codegen`이 없으면 기존의 `cargo run --bin generate` 관례를
  사용하되, 자동 추론 결과를 출력한다.

설정 오류는 추측해서 실행하지 않고 다음과 같은 actionable error를 낸다.

```text
codegen.rust_binary_ambiguous
  found: generate, app
  set: codegen.rustBinary
```

### 3.3 `rustra doctor`

doctor는 config의 host를 읽어 필요한 검사만 실행한다. `node`, `bun`만
사용하는 프로젝트가 Xcode나 Android NDK 경고를 받지 않도록 host별 조건부
검사를 적용한다.

#### 공통 검사

- `rustc`와 `cargo` 존재 여부
- `rustc --version`이 workspace MSRV 1.88 이상인지
- Node.js 18 이상 또는 Bun 실행 가능 여부
- config 파일, Cargo manifest, Rust generator target 해석 가능 여부
- schema/output 경로의 읽기·쓰기 가능 여부

#### host별 검사

- React Native iOS: macOS, `xcodebuild`, CocoaPods(`pod`), 필요한 Apple
  target 도구
- React Native Android: Java 17, Android SDK/`adb`/`sdkmanager`, pinned
  NDK `27.1.12297006`, Rust Android targets
- Tauri: macOS/Linux/Windows별 시스템 빌드 도구의 존재 여부
- Node/Bun: 선택한 executable 또는 cdylib target의 해석 가능 여부

doctor 결과는 공통 결과 모델을 사용한다.

```ts
type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';

interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  required: boolean;
  summary: string;
  detail?: string;
  fix?: string[];
}
```

text 출력은 사람이 읽기 쉽게, `--format json`은 IDE/CI가 소비하기 쉽게
한다. `--strict`에서는 warning도 exit 1로 승격한다. doctor는 설치나 삭제를
하지 않는다.

### 3.4 통합 codegen과 dev 감시

`rustra codegen`은 child process를 직접 shell 문자열로 조합하지 않고
`spawn` 인자 배열로 실행한다. 단계별 로그에는 다음을 표시한다.

```text
[rustra] Rust schema: cargo run --manifest-path ... --bin generate
[rustra] TypeScript/C++: @rustra/cli generate --config ...
[rustra] generated: 8 files, contract hash <short hash>
```

`rustra dev --config`는 config의 Rust source/package/output을 사용한다.
Rust source와 generator 관련 manifest가 바뀌면 Rust 단계부터 실행하고,
schema만 최신이면 TS/C++ 단계만 실행한다. 실행 중인 pipeline은 debounce와
single-flight를 사용한다.

- 작업 중 추가 변경이 들어오면 완료 뒤 한 번 더 dirty 상태를 검사한다.
- Rust 단계가 실패하면 TS 단계는 실행하지 않는다.
- TS 단계가 실패해도 감시 프로세스는 종료하지 않고 오류를 기록한다.
- 다음 source 변경 또는 명시적 재시도에서 실패한 단계를 재실행한다.
- `SIGINT`에서 child process를 정리하고 정상 종료한다.

기존 `--backend`와 `--app` 옵션은 하위 호환을 위해 유지한다. `--config`와
함께 사용하면 config가 우선이며, 충돌은 명시적으로 오류 처리한다.

### 3.5 drift 검사

`rustra generate --check --config`는 현재 schema를 읽어 모든 예상 generated
파일을 메모리에서 렌더링하고 디스크 내용과 byte 단위로 비교한다. 파일이
없거나 추가/변경되면 다음 정보를 출력한다.

- 누락 파일
- 예상하지 않은 generated 파일
- 변경된 파일
- 현재 schema contract hash와 generated contract hash

`rustra codegen --check`는 사용자 Rust generator를 먼저 실행한 뒤, 그 결과
schema를 기준으로 TS/C++/RN 산출물을 같은 방식으로 검사한다. Rust generator는
사용자 코드이므로 schema 파일을 갱신할 수 있고, 이 단계까지 포함한 완전한
CI drift 검사는 git diff로 확인한다. TS/C++/RN 검사 자체는 읽기 전용이다.
CI는 다음처럼 호출한다.

```bash
bun run doctor -- --config rustra.json --strict
bun run codegen -- --config rustra.json --check
git diff --exit-code -- generated modules
```

생성 파일 전체를 추적하는 프로젝트와 일부만 추적하는 프로젝트가 있으므로,
CLI는 삭제나 git index 조작을 하지 않는다. generated manifest에는 schema
hash, generator version, file list를 기록해 stale CLI 사용을 진단할 수 있게
한다.

### 3.6 `rustra init` 및 RN 템플릿

init이 만드는 `package.json`은 다음의 동일한 진입점을 갖는다.

```json
{
  "scripts": {
    "doctor": "rustra doctor --config rustra.json",
    "codegen": "rustra codegen --config rustra.json",
    "codegen:check": "rustra codegen --config rustra.json --check",
    "dev": "rustra dev --config rustra.json"
  }
}
```

첫 실행 안내는 `bun install -> bun run doctor -> bun run codegen -> cargo
run` 순서다. RN config에는 필요한 `codegen` Rust manifest를 기록하고,
development build 명령과 Expo Go 비지원 이유를 표시한다. iOS/Android
프로젝트를 자동 생성하거나 기존 native 파일을 덮어쓰지는 않는다.

### 3.7 prebuilt 정책

문서와 doctor에서 다음을 명확히 구분한다.

| 대상                                 | 범위      | 처리                                        |
| ------------------------------------ | --------- | ------------------------------------------- |
| CLI JavaScript                       | 공통      | npm에서 설치 가능                           |
| Rustra RN 공통 adapter/native bridge | 공통 소스 | package에 포함, 앱 빌드 시 플랫폼 컴파일    |
| 사용자 Rust command staticlib        | 앱별      | 로컬 또는 CI에서 빌드                       |
| 사용자별 플랫폼 artifact             | 앱별      | 추후 CI artifact/package 흐름으로 확장 가능 |

따라서 “프리빌트가 없어서 Rust가 필요하다”는 문장을 일반화하지 않고,
“사용자 command를 포함한 native artifact는 빌드가 필요하다”로 수정한다.
공통 adapter prebuild만 추가해도 사용자 Rust staticlib과 contract가 없어
RN 앱이 완성되는 것은 아니므로, 이를 현재 작업의 성공 기준으로 삼지 않는다.

## 4. 타입·런타임·안전성 문서 정책

### 4.1 타입 경계

`#[command]`의 cross-language 입력/출력은 `DeserializeOwned`, `Serialize`,
`JsonSchema`, `'static` 계약을 따른다. borrowed reference, closure, `dyn Trait`
를 직접 허용하지 않는 이유는 JS/FFI 수명과 ownership을 호출 경계 밖으로
유출하지 않기 위해서다. 문서는 “Rust가 약해서 안 된다”가 아니라 “ABI
경계에서 소유 타입으로 변환해야 한다”고 설명한다.

### 4.2 3-tier codec

- Tier 1: 검증된 primitive/postcard 또는 raw fast path
- Tier 2: schema-driven complex binary route
- Tier 3: binary route가 지원하지 못하는 schema와 runtime 등록 명령의
  JSON-in-binary fallback

깊은 중첩, struct-valued map, data enum이 무조건 JSON으로 떨어진다는 표현을
삭제한다. 현재 complex IR과 native-safe C++ marshalling이 지원하는 범위는
Tier 2로 간다. 다만 JSON fallback은 남아 있으며, 성능 비교는 benchmark
receipt의 대표 payload와 빌드 모드를 함께 표기한다.

### 4.3 Runtime registry

`command_id`는 u16이고 `u16::MAX`를 exhausted sentinel로 예약하므로 실제
동적 할당 상한은 65,534개다. `unregister`한 ID는 재사용하지 않는다.
debug에서는 mutation을 허용하고 release에서는 registry를 frozen으로 만든다.
문서와 doctor/diagnostic은 이 정책을 plugin hot injection의 일반 기능처럼
표현하지 않는다.

### 4.4 Unsafe FFI

unsafe를 “없애는” 대신 다음 증거를 유지한다.

- 각 FFI public entry의 Safety contract
- owned/caller-buffer 포인터의 해제 규칙
- Rust unit/integration, C++ codec, sanitizer/fuzz가 적용되는 경로
- 실제 기기와 simulator/build의 증거를 서로 대체하지 않는 문서

## 5. 오류 처리와 호환성

- config 오류: 명령 실행 전 fail, 안정적인 error id와 수정 예시 출력
- 도구 누락: doctor에서 `fail`과 fix 명령 출력
- Rust generator 실패: schema가 갱신되지 않았음을 표시하고 TS 단계 생략
- generated drift: `--check` exit 1, 파일별 차이를 요약
- contract mismatch: 기존 runtime `contract.mismatch` 계약 유지
- release registry mutation: 기존 `registry.frozen` 계약 유지
- prebuilt 미지원: 실패로 위장하지 않고 앱별 native build 필요 경고로 출력

새 CLI 결과의 error id와 JSON schema는 테스트로 고정한다. 기존 error code와
직접 generate API는 하위 호환을 유지한다.

## 6. 검증 계획

### CLI 단위 테스트

- config의 codegen Rust target 자동 선택/모호성/안전한 경로 검증
- doctor 결과 모델과 host별 skip/pass/fail/strict exit code
- version parser: Rust 1.88 pass, 그 미만 fail
- `--format json`이 안정적인 schema를 출력하는지 검증
- codegen 단계 실행 순서, 실패 시 후속 단계 생략, 재시도 계획
- generated `--check`의 누락/변경/추가 파일 검출
- init template에 doctor/codegen/dev script와 config가 포함되는지 검증

### 저장소 검증

```bash
bun run --cwd packages/cli build
bun run --cwd packages/cli test
bun run test:release-tools
bun run test:types
bun run test:packages
cargo test --workspace
cargo clippy --all-targets -- -D warnings
bun run codegen:check
```

실제 RN 검증에서는 doctor의 정적 결과와 iOS simulator/Android 실기기
runtime을 별도 receipt로 남긴다. doctor pass는 native runtime 성공을
증명하지 않는다.

## 7. 구현 순서

1. CLI config 타입/공통 process runner와 doctor 결과 모델
2. `rustra doctor`와 테스트
3. config 기반 Rust target 해석 및 `rustra codegen`
4. `generate --check`와 generated manifest/drift 테스트
5. `rustra dev --config` single-flight/retry/signal 처리
6. init/RN template 갱신
7. README, getting-started, migration, RN setup, complex codec, docs index
   정정
8. 전체 테스트와 문서의 예제 명령 검증

이 순서는 공통 CLI 계약을 먼저 고정해 템플릿과 문서가 임의의 shell 순서를
복제하지 않도록 한다.

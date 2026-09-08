# 커맨드별 타입화 에러 — 설계 (2026-09-07)

상태: 설계 확정. 리서치 근거: `docs/research/2026-09-07-typed-error-codesgen.md`.
경쟁 격차 정의: `docs/research/2026-09-07-competitive-landscape.md` #2 — "경쟁
대부분이 에러를 타입으로 노출, rustra 는 제네릭 `{code,message}` → string 비교
분기. 구현 비용 대비 가치 최고."

## 문제

Rust 핸들러는 `RustraError::custom("math.divide_by_zero", …)`처럼 **도메인 코드를
이미 반환하고 있고** 와이어(rkyv V2 postcard `{code,message}`, JSON 폴백 Display
재분할)와 4개 호스트 전부가 코드를 손실 없이 `RustraCommandError.code`까지
전달한다(리서치 1.3/3.3). 그러나:

1. **선언 부재** — `Command` 구조체와 schema.json 명령 항목에는 "이 커맨드가 어떤
   에러 코드를 반환할 수 있는가"를 기록하는 필드가 없다(command_types.rs:1-35,
   실측 divide 스키마 엔트리 키 6개뿐).
2. **타입 부재** — 생성된 클라이언트는 `Promise<Output>`만 선언하고, TS 호출자는
   `err.code === 'math.divide_by_zero'` 문자열 비교로 분기한다
   (journey.test.ts:187 등). 코드 오타는 컴파일 타임에 잡히지 않는다.
3. 문서 수준에서도 동일 취약 — getting-started.md:1065와 rust-api-guide.md:510이
   실제 예제 코드(`math.divide_by_zero`)와 어긋나는 오타 코드 `"division.by_zero"`
   를 게시 중이다(리서치 3.2).

해결 목표: **런타임 에러 계약(와이어/호스트/`RustraCommandError`/`normalizeRustraError`)
은 한 글자도 바꾸지 않고**, 선언→스키마→코드젠 화살을 추가해 커맨드별 에러 코드를
TS 리터럴 유니언 + 타입 가드로 좁힌다.

## 설계

### A. 스키마 `"errors"` 필드 — 코드 전용 named variant

명령 스키마 항목에 조건부 배열 필드를 추가한다(선언 없으면 미기록 — platforms
관례, package_schema.rs:161-169. 기존 패키지의 계약 해시 불변):

```json
{
  "name": "divide",
  "commandId": 10,
  "inputType": "DivideInput",
  "outputType": "DivideOutput",
  "inputSchema": { ... },
  "outputSchema": { ... },
  "errors": [
    { "code": "math.divide_by_zero", "description": "0으로 나눌 때", "retryable": false }
  ]
}
```

- variant 구성: `code`(필수, dot-notation 문자열), `description`(선택 — 생성
  JSDoc으로), `retryable`(선택, 기본 false — JSDoc/문서 메타데이터로만 소비,
  런타임 `isRetryableCode`는 무변경).
- **payload 스키마는 v1에 없다.** 와이어 에러 프레임은 `{code, message}`뿐이고
  payload를 실을 수 없다(rkyv_error.rs:6-17). payload 스키마를 선언하게 하면
  실제로 도달하지 않는 타입을 약속하는 거짓 계약이 된다. payload 타이핑은 와이어
  확장을 수반하는 후속 트랙으로 남긴다(남는 일 참조).
- 형식 안정성: `description`/`retryable`은 키를 항상 둘 다 기록한다(스키마
  바이트 안정성 — 조건부는 "errors 필드 자체"와 배열 원소 수준에서만).

### B. Rust 빌더 API — `command_errors` + `CommandErrorVariant`

기존 관례 정합(`command_doc`의 사후 체이닝 — builder_commands.rs:46-56,
`require_capability`의 `&'static str` 코드 — builder_capabilities.rs):

```rust
/// 커맨드가 반환할 수 있는 도메인 에러 코드의 선언 — const 문맥 구성 가능.
pub struct CommandErrorVariant { /* code: &'static str, description, retryable */ }

impl CommandErrorVariant {
    pub const fn new(code: &'static str) -> Self;
    pub const fn describe(mut self, text: &'static str) -> Self;
    pub const fn retryable(mut self) -> Self;
}

impl PackageBuilder {
    /// 커맨드에 에러 코드 선언을 추가한다. register!/build! 체인 뒤에도 붙을 수 있다.
    pub fn command_errors(mut self, name: &str, errors: &[CommandErrorVariant]) -> Self;

    /// #[command(error(...))] 메타데이터 연결 — None이면 no-op (platform_meta_if 관례).
    pub fn errors_meta_if(
        mut self,
        name: &str,
        errors: Option<&'static [CommandErrorVariant]>,
    ) -> Self;
}
```

- `Command.error_variants: Vec<CommandErrorVariant>` 필드 추가
  (command_types.rs — `platforms` 필드 추가와 동일한 방식, build_command 기본값
  빈 벡터).
- **패닉 조건(loud-fail, house 관례)**:
  - 등록되지 않은 명령 이름 (command_doc과 동일 — 빌더 체인 오류 은폐 방지)
  - 빈 `errors` 슬라이스
  - 코드가 `^[a-z][a-z0-9_.]*$` 위반 — TS 파서의 코드 토큰 판정(errors.ts:71)과
    동일 기준. 위반 코드는 JSON 폴백 경로에서 code/message 분할에 실패해
    `invoke.failed`로 뭉개지므로 선언 단계에서 거부한다.
  - 같은 명령 내 중복 코드.
- **런타임 검증은 하지 않는다**(YAGNI — E절): 선언은 계약 문서이지 핸들러 반환값
  검사기가 아니다. 핸들러가 미선언 코드를 반환해도 와이어는 그대로 흘러간다
  (모르는 코드 수신 정책은 E절).
- 배치: `crates/rustra/src/builder_errors.rs` 신설 + `builder.rs` include
  (builder_platform.rs 패턴), `CommandErrorVariant`는 `error.rs`에 정의하고
  prelude 재수출(`Platform` 재수출 관례, prelude.rs:5). `platform_command_impl`이
  스텁 교체 시 `platforms`를 보존하듯(builder_platform.rs:109,123),
  `platform_command_impl`/교체 경로에서 `error_variants`도 보존한다.

### C. 매크로 — `#[command(error("code", …))]`

`CommandAttr`에 `error(...)` 목록 파싱 추가(macro_command_support.rs —
`platform(...)` 파싱과 동일 구조). 속성은 **코드 문자열 목록만** 받는다(설명/
retryable 메타데이터는 빌더 `command_errors`로):

```rust
#[command(error("math.divide_by_zero"))]
fn divide(input: DivideInput) -> Result<DivideOutput> { … }

// register!/build! 체인이 자동 연결:
//   .errors_meta_if(#meta_ident, #errors_ident)
```

- `__RUstra_errors_{fn}` 상수(`&'static [CommandErrorVariant]`)를 심고
  register!/build! 체인에 `.errors_meta_if(...)` 1줄 추가(macro_register.rs:102,
  macro_build.rs:99 체인에 병렬).
- 지원 키 안내 메시지 갱신("unsupported `#[command]` key; supported keys: `name`,
  `capability`, `platform`, `error`" — macro_command_support.rs:60-64).
- `CommandErrorVariant`의 const 생성자(A절)가 매크로 생성 코드의 const 상수에서
  바로 구성 가능하게 한다.

### D. TS 코드젠 — 조건부 `errors.ts` + 타입 가드

`events.ts` 관례(generate-surface.ts:36, cli-generate-files.ts:95-96)를 그대로
따른다: **에러 선언이 1건이라도 있으면** `errors.ts`를 생성하고, 없으면 파일을
만들지 않는다(선언 없는 패키지는 기존 출력과 바이트 동일 — 재생성 유발 없음).

커맨드당 3종 출력(이름 규칙: `math.divide_by_zero` → `MathDivideByZero`
— `RustraErrorCode.TransportTimeout`('transport.timeout') 관례, errors.ts:155-156):

```ts
import { RustraCommandError } from '@rustra/types';

const divideErrorCodes: ReadonlySet<string> = new Set(['math.divide_by_zero']);

/** divide가 반환할 수 있는 도메인 에러 코드 (Rust 선언 기준). */
export const DivideErrorCode = {
  /** 0으로 나눌 때 — non-retryable. */
  MathDivideByZero: 'math.divide_by_zero',
} as const;
export type DivideErrorCode = (typeof DivideErrorCode)[keyof typeof DivideErrorCode];

/** code 리터럴로 좁혀진 divide의 에러 (discriminated by `code`). */
export type DivideError = RustraCommandError & { readonly code: DivideErrorCode };

/** catch 분기용 타입 가드 — 미선언 코드(신규 네이티브 등)는 false. */
export function isDivideError(error: unknown): error is DivideError {
  return error instanceof RustraCommandError && divideErrorCodes.has(error.code);
}
```

- **유니언의 좁힘 원리**: `DivideError`는 `code` 리터럴 유니언으로 판별되는
  교차 타입이다. `isDivideError` 가드 통과 후 `if (err.code ===
DivideErrorCode.MathDivideByZero)` 분기는 리터럴 좁힘이 되고, 오타는 컴파일
  에러난다.
- **`commands.ts`/`types.ts`는 바이트 불변** — 에러 표면은 별도 파일로. 생성
  헬퍼(`invokeGenerated*`)와 `RustraCommandError`/`normalizeRustraError`/
  `parseRustraErrorString`/`isRetryableCode` 런타임은 전부 무변경(기존 에러 계약
  무변경 원칙).
- 가드의 `instanceof RustraCommandError` 전제는 리서치 3.2/3.3에서 검증: 모든
  호스트 경로가 `RustraCommandError`(또는 그 서브클래스)로 승격한다.
  TimeoutError/CancelledError도 서브클래스라 `instanceof` 성립(errors.ts:26-42).
- CLI `CommandSchema` 타입에 `errors?: CommandErrorSchema[]` 추가
  (packages/cli/src/schema.ts). `parsePackageSchema`는 알 수 없는 필드를 이미
  통과시키므로(schema-validation.ts:118) 구 CLI 포워드 호환은 자동 성립.
- `commandFunctionName`과 같은 계층에 코드→PascalCase 키 매핑 헬퍼를 두고,
  매핑 충돌(서로 다른 코드가 같은 PascalCase로 수렴)은 **코드젠 에러로
  loud-fail**(게이트가 잡음). 정확 중복 코드는 Rust 빌더가 이미 패닉(B절).
- rkyv-codecs/registry/C++ 렌더러는 무변경 — 입력·출력 스키마만 소비(리서치 4).

### E. 코드 네임스페이스와 모르는 코드 수신 정책(forward compat)

1. **도메인 vs 프레임워크 코드**: `errors` 선언은 커맨드의 **도메인** 에러
   표면만 담는다. 프레임워크 코드(`cancelled`, `transport.error`,
   `transport.timeout`, `internal`, `command.invalid_args`, `payload.too_large`,
   `capability.denied`, `platform.unavailable` — error.rs 코드 테이블 및 JS 전용
   코드군, errors.ts:138-205)는 어느 커맨드에서든 발생할 수 있으므로 유니언에
   자동 포함하지 **않는다**(포함시 모든 유니언이 동일 접두 블록으로 부풀고
   버전 결합만 생긴다). 프레임워크 코드 분기는 기존대로 `RustraErrorCode`
   상수 비교.
2. **빌트인 코드 재선언은 허용** — 커맨드가 도메인 의미로 `payload.too_large`
   계열을 명시적으로 돌려주는 경우 유니언에 그대로 들어간다(중복은 B절 패닉의
   '정확 중복' 기준이라 충돌 없음).
3. **모르는 코드 수신**: 신규 네이티브(에러 선언 추가) + 구 JS(가드 없음) 조합은
   애초에 가드가 없어 문제 없음. 그 반대(구 네이티브 + 신 JS)는 스키마에 errors가
   없어 errors.ts가 생성되지 않는다. **동일 계약 내에서 핸들러가 미선언 코드를
   반환하는 경우** 가드는 false — 호출자는 폴백으로 `err.code` 문자열 분기(기존
   패턴) 또는 `RustraErrorCode` 비교. 타입은 폐쇄 유니언이지만 런타임은 개방
   계약임을 가드 JSDoc에 명시한다.
4. **계약 해시**: errors 추가는 schema.json 변경 → 계약 해시·핫리로드 와이어
   서명 변경(package_schema.rs:60-77, 193-196). 의도된 계약 진화로,
   `contract.mismatch` 게이트와 `rustra diff`가 기존대로 검출한다.

### F. 하지 않을 것 (YAGNI)

- **에러 payload 스키마/직렬화** — 와이어가 `{code,message}`뿐이라 불가능하고,
  가능하게 하려면 에러 프레임 확장(후보: `err_len` 뒤 postcard 필드 추가)이
  필요하다. 별도 트랙.
- **런타임 코드 검증** — 핸들러 반환값을 선언 집합과 대조하지 않는다. 계약
  수준 드리프트는 `rustra diff`/contract 게이트 몫.
- **폐쇄 유니언에 프레임워크 코드 자동 포함** — E-1 근거로 불가.
- **`isRetryableCode`/retryable 와이어 의미 변경** — 선언의 `retryable`은
  문서/코드젠 메타데이터로만 소비. 커스텀 코드의 인스턴스 retryable은 여전히
  코드 기반 도출 외길(리서치 1.3).
- **에러 클래스 상속 체계/커스텀 서브클래스 팩토리** — `RustraCommandError`
  단일 클래스 + 가드 원칙. TimeoutError/CancelledError 선례는 "와이어 값 유지 +
  서브클래스"였지만 그 수혜는 범용 코드에 국한한다는 판단(커맨드별 서브클래스
  N개는 번들링·트리셰이킹·직렬화 표면 손해).
- **매크로 속성의 인라인 메타데이터**(`error(code, description = "…")`) —
  속성은 코드 목록만, 상세는 빌더 체인(C절). 파서 단순성.
- **C++/코덱/호스트 변경** — 전부 무변경(리서치 결론).
- **errors 필드의 schema-diff 특수 표시** — 일반 필드 추가로 표시되면 족하다.

## 남는 일 (후보 후속)

- 에러 payload 와이어 확장 + payload 스키마 타이핑 (F절 1항의 후속)
- 커맨드별 에러 선언을 `rustra inspect`/devtools 표면에 노출
- 생성 가드의 배치 헬퍼(여러 커맨드 에러를 한 번에 좁히는 유틸) — 수요 실증 후
- platforms의 TS 코드젠 소비(리서치 2.1의 미착지 슬라이스)와 동시 진행 가능

## 하위 호환성

- 신규 스키마 필드는 **조건부** — 선언 없는 기존 패키지의 schema.json/계약 해시/
  생성물은 바이트 불변(platforms·events 섹션 관례).
- 구 CLI가 신규 스키마를 읽으면 `errors`를 조용히 무시(schema-validation.ts:118)
  — 드리프트 게이트가 schema.json 원문 비교로 잡아주므로 혼합 상태도 검출 가능.
- 신 CLI가 구 스키마를 읽으면 errors.ts 미생성 — 기존 출력과 동일.
- Rust 빌더/매크로 추가는 순수 신규 메서드/속성 키 — 기존 체인 무영향.
  api-surface 스냅샷에는 신규 심볼로 등장(갱신 필요).

---
date: 2026-09-16
researcher: codex
git_commit: 6694a9420812bd2cb7e9f1151876030c581072e5
topic: 'Rustra 매크로 없이 일반 Rust 함수의 다중 인자와 반환값을 등록하는 방법'
status: research-complete
---

# 매크로 없이 일반 Rust 함수를 연결할 수 있는가

## 결론

**가능하다.** `fn add(a: i32, b: i32) -> i32`를 그대로 두고, 등록 API 내부에서 인자를 해체하고 반환값을 감싸면 된다. 함수의 인자 수마다 tuple marker를 가진 trait 구현을 제공하는 방식은 axum과 Bevy의 공식 구현에 이미 있다. 사용자에게 `#[rustra::command]`나 `register!`를 요구할 언어적 이유는 없다. 다만 **Rust 함수 호출 가능성, 와이어 타입 변환, 이름 메타데이터는 각각 해결해야 한다.** 아래 API는 제안이며 현재 Rustra에 구현되어 있지 않다. [axum Handler](https://docs.rs/axum/latest/axum/handler/trait.Handler.html#about-type-parameter-t), [Bevy SystemParamFunction](https://docs.rs/bevy_ecs/latest/bevy_ecs/system/trait.SystemParamFunction.html)

권고는 **일반 반환값을 받는 generic 등록 + 오류를 처리하는 명시적 등록 모드**다. 다중 인자와 `Result` 강제를 함께 없앨 수 있다. 함수 파라미터 이름까지 자동 수집하려는 요구는 선택적 소스 코드 생성으로 확장한다. `1.0`이나 대규모 소스 분석기를 선행 조건으로 둘 필요는 없다. 이 우선순위는 조사 결과에 따른 설계 판단이다.

## 1. 현재 제약은 Rustra가 정한 표면이다

현재 `#[command]`는 반환형이 `Result<O>`인지를 검사하고, 데이터 인자가 둘 이상이면 오류를 낸다. 반면 내부 handler의 요구는 `Fn(I) -> rustra::Result<O>`이다. 일반 함수 바깥의 어댑터가 `I`를 여러 값으로 나누고 `O`를 `Ok(O)`로 감싸면 도메인 함수는 이 제약을 몰라도 된다. 현재 builder는 입력에 `DeserializeOwned + JsonSchema`, 출력에 `Serialize + JsonSchema`를 요구한다. [매크로 분석](../../crates/rustra-macros/src/macro_command.rs), [handler trait](../../crates/rustra/src/private.rs), [등록 builder](../../crates/rustra/src/builder_commands.rs)

따라서 “반환값에 제약이 없다”는 목표는 **`rustra::Result`와 전용 Output 구조체를 강제하지 않는다**로 정의하는 편이 정확하다. 직렬화·스키마·소유권 또는 별도 handle/DTO 변환 규칙까지 없어지는 것은 아니다. 사용자 타입은 기존 Serde/Schemars 구현을 쓰거나 경계에서 지원 타입으로 변환해야 한다. Rustra 매크로를 쓰지 않는 것과 모든 derive 매크로를 쓰지 않는 것도 별개다. [현재 타입 경계](../../crates/rustra/src/builder_commands.rs)

## 2. 다중 인자: tuple marker로 함수 타입을 등록한다

핵심 형태는 다음과 같다. 개념 설명용이며 Rustra 제품 코드가 아니다.

```rust
trait Call<Args> {
    type Output;
    fn call(&self, args: Args) -> Self::Output;
}

impl<F, A, B, O> Call<(A, B)> for F
where
    F: Fn(A, B) -> O,
{
    type Output = O;
    fn call(&self, (a, b): (A, B)) -> O {
        self(a, b)
    }
}
```

`Call<()>`, `Call<(A,)>`, `Call<(A, B)>`처럼 trait의 인자에 arity와 타입을 넣는다. `impl<F> Handler for F where F: Fn(...)`만 여러 개 나열하면 구현이 겹칠 수 있지만, marker가 구현을 구분한다. axum 문서는 이것이 coherence 규칙을 위한 장치이며 보통 호출자가 marker를 명시하지 않아도 추론된다고 설명한다. [axum Handler의 T 설명](https://docs.rs/axum/latest/axum/handler/trait.Handler.html#about-type-parameter-t), [Rust 구현 일관성 규칙](https://doc.rust-lang.org/reference/items/implementations.html#trait-implementation-coherence)

내부의 반복 구현은 라이브러리 자체 매크로나 코드 생성으로 작성할 수 있다. Bevy는 실제로 0–16개 인자 구현을 생성한다. 사용자에게 매크로 문법이 노출되는 것은 아니다. stable Rust에서 일반 함수 호출 문법을 쓰고 arity별 구현을 준비하는 접근이며, 임의 tuple을 `Fn::call`로 호출하는 nightly API에 의존할 필요가 없다. [Bevy 구현](https://docs.rs/bevy_ecs/0.19.1/src/bevy_ecs/system/function_system.rs.html#950), [std Fn](https://doc.rust-lang.org/std/ops/trait.Fn.html)

**주의:** 내부 marker tuple이 곧 공개 와이어 배열이어야 한다는 뜻은 아니다. 등록 시 `a`, `b` 이름을 받으면 `{a, b}` 객체를 디코딩한 뒤 내부 tuple로 호출할 수 있다. 단순 tuple을 기존 builder에 연결하는 실험과 모든 Rustra 코덱·스키마·생성 클라이언트에서 다중 인자를 지원하는 제품 변경은 증거 범위가 다르다. 이는 현재 `I` 중심 경계를 유지하는 설계 제안이다. [현재 command 생성 경계](../../crates/rustra/src/command_build.rs)

## 3. 반환값: 자동 변환의 두 문제를 구분해야 한다

| 원래 함수 반환형          | 권고 등록 의미                                      | 남는 조건                                 |
| ------------------------- | --------------------------------------------------- | ----------------------------------------- |
| `T`                       | 성공 payload로 변환                                 | `T`의 직렬화·스키마 지원 또는 변환기      |
| `()` / 반환형 생략        | 정상 완료                                           | wire null과 클라이언트 void 표현의 일관성 |
| `Result<T, E>`            | fallible 모드에서 `Ok` payload / `Err` bridge error | `E`를 공용 오류 코드·메시지로 매핑        |
| `async fn -> T`           | async 모드에서 await 후 성공 payload                | 실행기·취소·스레드 이동 정책              |
| `async fn -> Result<T,E>` | async fallible 모드                                 | 위 두 조건의 결합                         |

이 표는 제안하는 경계 정책이다. async 함수가 `Future<Output = T>`를 반환하는 함수로 해석된다는 점은 Rust Reference가 설명한다. axum도 `F -> Fut`, `Fut: Future<Output = Res>`, `Res: IntoResponse`를 분리한다. 반환 타입은 자유롭게 구성하되 프레임워크 경계의 변환 조건은 남는 구조다. [Rust async 함수](https://doc.rust-lang.org/reference/items/functions.html#async-functions), [axum handler 구현](https://docs.rs/axum/latest/src/axum/handler/mod.rs.html#227-234)

### 구현 충돌과 추론 모호성은 별개다

- **같은 trait에 blanket 구현:** `impl<T: Serialize> IntoOutput for T`와 `impl<T,E> IntoOutput for Result<T,E>`는 직렬화 가능한 `Result`에서 겹친다. 일반 `T`와 `Future` 전용 처리도 같은 식으로 단순 병합할 수 없다. 일반형에서 특수형을 자동 우선시키는 specialization을 stable 전제로 삼으면 안 된다. [Rust coherence](https://doc.rust-lang.org/reference/items/implementations.html#trait-implementation-coherence), [specialization 상태](https://doc.rust-lang.org/beta/unstable-book/language-features/specialization.html)
- **marker / 목표 타입을 추가:** 구현 충돌을 피할 수 있다. Bevy의 `IntoResult<Out>`는 `IntoResult<T> for T`와 `IntoResult<T> for Result<T, BevyError>`를 함께 제공한다. 따라서 “plain과 Result를 함께 지원하는 건 불가능”이라는 결론은 틀리다. [Bevy IntoResult 구현](https://docs.rs/bevy_ecs/0.19.1/src/bevy_ecs/system/function_system.rs.html#588-612)
- **그러나 선택이 자동으로 유일해지지는 않는다:** `Result<T,E>`는 “전체 Result를 데이터로 반환”하는 목표와 “T를 반환하고 E는 오류로 처리”하는 목표를 모두 만족할 수 있다. 반환 목표가 builder의 타입에서 드러나지 않으면 추론이 모호해질 수 있다. 이번 임시 실험에서는 실제로 `Result<i32,String>` 등록이 `E0283`을 냈다(아래 실험 기록). 일반 직렬화형인 Future도 sync/async marker 양쪽 후보가 될 수 있다는 점은 위 구현과 trait 규칙에 근거한 추론이며, 그 조합까지 실험한 것은 아니다.

axum은 모든 직렬화 타입에 대한 blanket `IntoResponse`를 제공하는 방식이 아니다. `()`, `String` 등의 응답과 `Result<T,E>` 변환을 정의하고, `Result`의 양쪽에 `IntoResponse`를 요구한다. 따라서 axum의 간결한 표면을 “임의 Serialize DTO와 임의 E가 무조건 자동 판별된다”는 근거로 쓰면 안 된다. [axum IntoResponse 구현](https://docs.rs/axum-core/latest/src/axum_core/response/into_response.rs.html#126-180)

## 4. 권고 사용자 표면 — 미구현 예시

```rust
// 도메인 함수에는 Rustra 속성이나 Result 강제가 없다.
fn add(a: i32, b: i32) -> i32 { a + b }
fn reset() {}
fn read(path: String) -> std::io::Result<String> {
    std::fs::read_to_string(path)
}

// 아래는 제안 API다. 현재 Rustra API가 아니다.
builder
    .function("add", add)
    .function("reset", reset)
    .try_function("read", read, map_io_error);
```

추천 정책은 다음과 같다.

1. `function`은 반환값을 payload로 취급한다. `try_function`은 오류 처리 의미와 mapper를 명시한다. 원래 도메인 함수는 그대로 유지한다.
2. async도 먼저 `async_function` / `async_fallible_function` 또는 명시적 adapter로 제공한다. 다중 arity, 반환 의미, 실행기 선택을 한 번에 추론시키는 API를 초기 성공 조건으로 두지 않는다.
3. 기본 경로는 인자를 위치로 받아 이름을 반복 작성하지 않는다. 생성 TS의 표시 이름은 `arg0`, `arg1`로 둘 수 있다. 원래 `a`, `b` 이름이나 명명된 객체 입력이 필요할 때만 선택적으로 이름을 제공하거나 CLI 소스 분석을 쓴다. 기본 arity 범위를 문서화하고, 선택적 이름의 개수·중복·빈 이름을 검사한다. `State<T>` 주입을 추가한다면 wire 데이터 인자와 구분하는 marker와 규칙을 정의한다.
4. 등록과 함께 doc/capability/platform/error metadata를 연결할 수 있게 한다. 기존 매크로가 보존하는 접근 제어를 일반 함수 경로에서 누락시키면 안 된다. [기존 메타데이터 생성](../../crates/rustra-macros/src/macro_command.rs)

## 5. 인자 이름 자동 수집은 소스 코드 생성 영역이다

`Fn(A,B)->O` trait bound는 타입과 호출 가능성을 알려 주지만 원래 소스의 `a`, `b` 식별자를 조회하는 API는 제공하지 않는다. 함수 포인터는 함수 정체성이 알려져 있지 않을 수 있고, `type_name` 문자열은 진단용이며 형식이 보장되지 않는다. 따라서 `type_name::<F>()`를 파싱해서 안정적인 명령 이름·인자 이름 계약을 만드는 것은 권고하지 않는다. 명시적 이름이나 소스 메타데이터가 필요하다는 판단이다. [std Fn](https://doc.rust-lang.org/std/ops/trait.Fn.html), [함수 포인터](https://doc.rust-lang.org/reference/types/function-pointer.html), [type_name 보장 범위](https://doc.rust-lang.org/std/any/fn.type_name.html)

CLI나 `build.rs`가 Rust 소스를 읽으면 함수의 이름·입력 패턴·반환형 표기를 수집하고 adapter를 생성할 수 있다. `syn`은 이런 구문 트리를 제공한다. 다만 이것은 **구문 분석**이므로 컴파일러가 해석한 전체 타입 정보를 얻었다고 간주해서는 안 된다. [syn](https://docs.rs/syn/latest/syn/), [syn Signature](https://docs.rs/syn/latest/syn/struct.Signature.html)

| 코드 생성 쟁점                                | 필요한 처리                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cfg`, feature, target별 함수 존재            | 생성 결과가 실제 컴파일 조건과 일치해야 한다. build script의 `cfg!`는 host를 보므로 target은 `CARGO_CFG_*`로 읽는다. [Cargo build scripts](https://doc.rust-lang.org/cargo/reference/build-scripts.html), [조건부 컴파일](https://doc.rust-lang.org/reference/conditional-compilation.html)                                 |
| `type Reply = Result<...>` / `use ... as ...` | 표기에 `Result`가 없거나 다른 타입이 그 이름을 쓸 수 있다. 문자열 판별은 충분하지 않다. 반환 의미를 명시하거나, 생성 adapter의 타입 판정을 rustc에 맡기는 설계가 필요하다. [타입 별칭](https://doc.rust-lang.org/reference/items/type-aliases.html)                                                                         |
| 다른 모듈 타입·비공개 함수                    | 원래 모듈의 scope와 visibility를 보존하거나 공개 등록 함수/DTO 경계를 둔다. 별도 crate에서 private API를 읽고 호출할 수 있다고 가정하면 안 된다. [Rust privacy](https://doc.rust-lang.org/reference/visibility-and-privacy.html)                                                                                            |
| 입력 destructuring / generic 함수             | `(x,y): Pair`에 붙일 공개 인자 이름, generic 함수의 구체 타입을 정해야 한다. 초기 지원 범위를 명시하고 모호하면 위치를 포함한 오류를 내는 편이 낫다. [함수 파라미터와 generics](https://doc.rust-lang.org/reference/items/functions.html#function-parameters)                                                               |
| 생성물 반영·재생성                            | build script는 `OUT_DIR`에 출력하고 `rerun-if-changed`를 연결한다. CLI 생성은 정상 소스 모듈로 연결하고 stale 검사를 둔다. 완전한 사용자 무매크로 요구라면 `include!`까지 사용자가 작성하게 하는 대신 CLI가 모듈 연결을 생성할 수 있다. [Cargo build scripts](https://doc.rust-lang.org/cargo/reference/build-scripts.html) |

**권고:** 먼저 컴파일러 추론을 이용하는 generic 등록을 기반으로 만든다. 인자 이름 반복이 실제로 불편하면 소스 생성기가 위 명시적 등록 코드를 대신 출력하도록 한다. 처음부터 별도의 Rust 의미 분석기를 만들거나, 함수의 원래 서명을 Rustra 규격으로 바꾸게 할 이유는 없다.

## 6. 현재 Rustra에 연결한 임시 실험

부모 작업에서 Rust 1.98과 현재 저장소의 `rustra` path dependency로 임시 소비자 `/tmp/rustra-function-api-spike`를 실행했다. 이 연구 작업에서는 그 소스와 실행 로그를 직접 읽어 아래 범위를 확인했다. 임시 파일은 저장소 산출물이 아니므로 이후 삭제될 수 있다.

- **구현:** `Call<Args>`의 0/1/2/3개 인자 구현을 직접 작성하고, `.function(name, f)` / `.try_function(name, f, map_error)` 확장 trait을 기존 `.command`에 연결했다. 도메인 함수와 arity adapter 모두 Rustra 함수 매크로를 사용하지 않았다. custom `User`만 `Serialize + JsonSchema`를 derive했다.
- **통과:** 일반 `i32`, `String`, `()`, tuple, `Vec`, `Option`, custom `User` 반환, `Result<i32,DivideError>` 성공·오류 매핑, 부족한 인자 거부를 포함한 JSON 호출 검증 12개. Rust 측 스키마와 TypeScript types/commands 생성도 warning 없이 완료했다.
- **생성 클라이언트의 현재 형태:** 생성된 메서드는 `add(input: Tuple_of_int32_and_int32, options?)`이다. `add(a,b)`가 생성된 것은 아니다. 원래 Rust 다중 인자의 arity·이름과 “사용자가 단일 tuple 인자를 받는 함수”를 구분하는 메타데이터를 두고, 클라이언트 facade가 값을 wire 입력으로 묶는 별도 변경이 필요하다. [생성 commands](/tmp/rustra-function-api-spike/generated-commands.ts)
- **실패 재현:** 별도 `ambiguous.rs`에서 `IntoReturn<T> for T`와 `IntoReturn<T> for Result<T,E>` 구현 자체는 성립했지만, `register(fallible)`의 `Result<i32,String>` 반환에서 목표 `O`를 추론하지 못해 `E0283: multiple impls ... IntoReturn<_>`가 발생했다.
- **범위:** 입력은 JSON 배열(무인자는 null)이었다. 명명된 객체 인자, JS의 `api.add(a,b)` facade, async, Rustra MSRV, 나머지 wire codec, native host, 모바일 기기는 이 실험의 검증 대상이 아니었다. 0–16개 지원은 공식 선례에 근거한 확장 방향이며 실제 임시 구현은 0–3개다.

실험 원본: [main.rs](/tmp/rustra-function-api-spike/src/main.rs), [성공 로그](/tmp/rustra-function-api-spike/run.log), [추론 모호성 소스](/tmp/rustra-function-api-spike/src/bin/ambiguous.rs), [E0283 로그](/tmp/rustra-function-api-spike/ambiguous.log).

## 검증 범위와 선행 조사

이 문서는 현재 저장소의 제한과 공식 문서·소스 조사, 위 임시 실험의 소스·로그 확인을 근거로 한다. 제품 코드는 변경하지 않았다. 제안 API의 명명된 인자·오류 진단·async 생명주기·전체 호스트 지원은 별도 구현과 검증이 필요하다.

[2026-09-03 조사](2026-09-03-16-00-00-dx-macro-first-assessment.md)는 당시의 macro-first 보일러플레이트 축소를 평가했다. 이번 질문은 일반 Rust 함수 보존이 목적이므로 당시의 매크로 확장 우선순위를 그대로 적용하지 않았다. 선행 문서의 doc comment 소비자 부재 주장은 문서 말미에서 정정되어 있으며 이번 결론의 근거로 쓰지 않았다.

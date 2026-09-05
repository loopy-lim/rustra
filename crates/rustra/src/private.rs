use schemars::JsonSchema;
use serde::{Serialize, de::DeserializeOwned};

pub use crate::executor::block_on;

pub trait CommandInput: DeserializeOwned + JsonSchema + 'static {}
impl<T: DeserializeOwned + JsonSchema + 'static> CommandInput for T {}

pub trait CommandOutput: Serialize + JsonSchema + 'static {}
impl<T: Serialize + JsonSchema + 'static> CommandOutput for T {}

/// 등록 가능한 명령 핸들러 마커 — 모든 `Fn` 핸들러에 blanket impl 된다.
///
/// (감사 #5) `#[command(capability = "...")]` 래퍼는 `unsafe fn` 으로 생성되어
/// `Fn` 을 구현하지 않으므로, 이 트레잇이 붙은 등록 바운드는 그런 함수를
/// 거부하면서 아래 메시지로 capability 계약을 이름한다 — 조용한 공개 명령화
/// 대신 컴파일 에러.
#[diagnostic::on_unimplemented(
    message = "cannot register this function as a plain command: `#[command(capability = \"...\")]` functions are `unsafe fn` so the capability cannot be silently dropped",
    label = "capability-declaring command is not a plain `Fn` handler",
    note = "register it with `rustra::register!(builder, fn_name)` or `rustra::build!(\"pkg\", fn_name)` — the macro wires the capability as deny-by-default",
    note = "or register a capability-free function with `.command_fn`/`.command`"
)]
pub trait CommandHandler<I, O>: Fn(I) -> crate::Result<O> + Send + Sync + 'static {}
impl<I, O, F: Fn(I) -> crate::Result<O> + Send + Sync + 'static> CommandHandler<I, O> for F {}

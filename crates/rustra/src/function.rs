//! Safe arity adapters for ordinary synchronous functions.
use crate::{DeserializeOwned, JsonSchema};

/// Implementation detail used to infer a function's owned argument tuple.
/// Safe `Fn` implementations only: unsafe command wrappers cannot satisfy this bound.
#[doc(hidden)]
pub trait Function<Args>: sealed::Sealed<Args> + Send + Sync + 'static {
    type Output;
    const ARITY: u8;
    fn call(&self, args: Args) -> Self::Output;
}

mod sealed {
    pub trait Sealed<Args> {}
}
impl<F, O> sealed::Sealed<()> for F where F: Fn() -> O + Send + Sync + 'static {}

impl<F, O> Function<()> for F
where
    F: Fn() -> O + Send + Sync + 'static,
{
    type Output = O;
    const ARITY: u8 = 0;
    fn call(&self, (): ()) -> O {
        self()
    }
}

macro_rules! impl_function {
    ($arity:expr; $($arg:ident),+) => {
        impl<F, O, $($arg),+> sealed::Sealed<($($arg,)+)> for F
        where F: Fn($($arg),+) -> O + Send + Sync + 'static,
              $($arg: DeserializeOwned + JsonSchema + 'static,)+ {}
        impl<F, O, $($arg),+> Function<($($arg,)+)> for F
        where
            F: Fn($($arg),+) -> O + Send + Sync + 'static,
            $($arg: DeserializeOwned + JsonSchema + 'static,)+
        {
            type Output = O;
            const ARITY: u8 = $arity;
            #[allow(non_snake_case)]
            fn call(&self, ($($arg,)+): ($($arg,)+)) -> O { self($($arg),+) }
        }
    };
}
impl_function!(1; A0);
impl_function!(2; A0, A1);
impl_function!(3; A0, A1, A2);
impl_function!(4; A0, A1, A2, A3);
impl_function!(5; A0, A1, A2, A3, A4);
impl_function!(6; A0, A1, A2, A3, A4, A5);
impl_function!(7; A0, A1, A2, A3, A4, A5, A6);
impl_function!(8; A0, A1, A2, A3, A4, A5, A6, A7);
impl_function!(9; A0, A1, A2, A3, A4, A5, A6, A7, A8);
impl_function!(10; A0, A1, A2, A3, A4, A5, A6, A7, A8, A9);
impl_function!(11; A0, A1, A2, A3, A4, A5, A6, A7, A8, A9, A10);
impl_function!(12; A0, A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11);

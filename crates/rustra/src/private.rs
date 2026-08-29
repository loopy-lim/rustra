use schemars::JsonSchema;
use serde::{Serialize, de::DeserializeOwned};

pub use crate::executor::block_on;

pub trait CommandInput: DeserializeOwned + JsonSchema + 'static {}
impl<T: DeserializeOwned + JsonSchema + 'static> CommandInput for T {}

pub trait CommandOutput: Serialize + JsonSchema + 'static {}
impl<T: Serialize + JsonSchema + 'static> CommandOutput for T {}

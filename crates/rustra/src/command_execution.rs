/// Producer-side execution contract retained even when an async macro creates a
/// synchronous adapter. Absence of this metadata means unknown, never Sync.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommandExecution {
    Sync,
    Async,
}

impl CommandExecution {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Sync => "sync",
            Self::Async => "async",
        }
    }
}

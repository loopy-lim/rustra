//! State management and dependency injection for Rustra commands.

use std::any::{Any, TypeId};
use std::cell::RefCell;
use std::collections::HashMap;
use std::ops::Deref;
use std::sync::Arc;

pub type StateMap = HashMap<TypeId, Arc<dyn Any + Send + Sync>>;

thread_local! {
    static CURRENT_STATES: RefCell<Option<Arc<StateMap>>> = const { RefCell::new(None) };
}

/// Shared state wrapper managed by a Rustra [`Package`].
///
/// Injected into `#[command]` handlers automatically when declared as a parameter.
///
/// ## Example
///
/// ```rust
/// use rustra::prelude::*;
///
/// struct Database {
///     url: String,
/// }
///
/// #[bridge_type]
/// struct QueryInput { id: String }
/// #[bridge_type]
/// struct QueryOutput { found: bool }
///
/// #[command]
/// fn query_item(input: QueryInput, db: State<Database>) -> Result<QueryOutput> {
///     Ok(QueryOutput { found: !db.url.is_empty() })
/// }
/// ```
#[derive(Clone, Debug)]
pub struct State<T: Send + Sync + 'static>(pub Arc<T>);

impl<T: Send + Sync + 'static> State<T> {
    pub fn new(val: T) -> Self {
        Self(Arc::new(val))
    }

    pub fn inner(&self) -> &Arc<T> {
        &self.0
    }
}

impl<T: Send + Sync + 'static> Deref for State<T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

/// Sets the current state context during command execution.
pub fn with_state_context<R>(states: &Arc<StateMap>, f: impl FnOnce() -> R) -> R {
    struct ResetGuard(Option<Arc<StateMap>>);
    impl Drop for ResetGuard {
        fn drop(&mut self) {
            let prev = self.0.take();
            CURRENT_STATES.with(|cell| {
                *cell.borrow_mut() = prev;
            });
        }
    }

    let prev = CURRENT_STATES.with(|cell| cell.borrow_mut().replace(states.clone()));
    let _guard = ResetGuard(prev);
    f()
}

/// Retrieves a managed state of type `T` from the current invocation context.
pub fn get_state<T: Send + Sync + 'static>() -> Option<State<T>> {
    CURRENT_STATES.with(|cell| {
        let guard = cell.borrow();
        let map = guard.as_ref()?;
        let any_arc = map.get(&TypeId::of::<T>())?.clone();
        let concrete_arc = any_arc.downcast::<T>().ok()?;
        Some(State(concrete_arc))
    })
}

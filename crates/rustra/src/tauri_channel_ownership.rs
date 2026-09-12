//! Revocable channel leases live in the caller's resource table.
use std::collections::BTreeMap;
use std::sync::{
    Arc, Mutex, Weak,
    atomic::{AtomicBool, Ordering},
};
use tauri::{Manager, Runtime};

#[derive(Clone)]
struct Owner {
    resource: tauri::ResourceId,
    webview: Option<String>,
    window: Option<String>,
    active: Arc<AtomicBool>,
    release: Arc<dyn Fn() + Send + Sync>,
    alive: Arc<dyn Fn() -> bool + Send + Sync>,
}

#[derive(Default)]
struct Owners(Mutex<BTreeMap<u32, Owner>>);

struct ChannelLease {
    handle: u32,
    owners: Weak<Owners>,
    active: Arc<AtomicBool>,
}

impl tauri::Resource for ChannelLease {}
impl Drop for ChannelLease {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        // Drop captured resources outside the map lock.
        let removed = self.owners.upgrade().and_then(|owners| {
            owners
                .0
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&self.handle)
        });
        crate::channels::host().drop_channel(self.handle);
        drop(removed);
    }
}

fn owners<R: Runtime>(app: &tauri::AppHandle<R>) -> Arc<Owners> {
    if let Some(state) = app.try_state::<Arc<Owners>>() {
        return state.inner().clone();
    }
    app.manage(Arc::new(Owners::default()));
    app.state::<Arc<Owners>>().inner().clone()
}

// Hold the resource table until sender publication completes. Resource teardown
// cannot drop a lease before its sender exists; the map serializes explicit
// navigation/exit cleanup against publication. Never call a sender under either lock.
pub(super) fn publish_app<R: Runtime>(
    app: &tauri::AppHandle<R>,
    handle: u32,
    publish: impl FnOnce(Arc<AtomicBool>),
) {
    let owners = owners(app);
    let active = Arc::new(AtomicBool::new(true));
    let mut table = app.resources_table();
    let resource = table.add(ChannelLease {
        handle,
        owners: Arc::downgrade(&owners),
        active: active.clone(),
    });
    let app = app.clone();
    let mut entries = owners.0.lock().unwrap_or_else(|p| p.into_inner());
    entries.insert(
        handle,
        Owner {
            resource,
            webview: None,
            window: None,
            active: active.clone(),
            release: Arc::new(move || {
                let lease = app.resources_table().take::<ChannelLease>(resource);
                drop(lease);
            }),
            alive: Arc::new(|| true),
        },
    );
    publish(active);
}

pub(super) fn publish_webview<R: Runtime>(
    webview: &tauri::Webview<R>,
    handle: u32,
    publish: impl FnOnce(Arc<AtomicBool>),
) {
    let owners = owners(webview.app_handle());
    let active = Arc::new(AtomicBool::new(true));
    let mut table = webview.resources_table();
    let resource = table.add(ChannelLease {
        handle,
        owners: Arc::downgrade(&owners),
        active: active.clone(),
    });
    let captured = webview.clone();
    let window = webview.window();
    let label = webview.label().to_owned();
    let mut entries = owners.0.lock().unwrap_or_else(|p| p.into_inner());
    entries.insert(
        handle,
        Owner {
            resource,
            webview: Some(label.clone()),
            window: Some(window.label().to_owned()),
            active: active.clone(),
            release: Arc::new(move || {
                let lease = captured.resources_table().take::<ChannelLease>(resource);
                drop(lease);
            }),
            alive: Arc::new(move || window.webviews().iter().any(|view| view.label() == label)),
        },
    );
    publish(active);
}

pub(super) fn drop_app<R: Runtime>(app: &tauri::AppHandle<R>, handle: u32) -> bool {
    let owner = owners(app)
        .0
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&handle)
        .cloned();
    let Some(owner) = owner.filter(|owner| owner.webview.is_none()) else {
        return false;
    };
    let lease = app.resources_table().take::<ChannelLease>(owner.resource);
    lease.is_ok()
}

pub(super) fn drop_webview<R: Runtime>(webview: &tauri::Webview<R>, handle: u32) -> bool {
    let owner = owners(webview.app_handle())
        .0
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&handle)
        .cloned();
    let Some(owner) = owner.filter(|owner| owner.webview.as_deref() == Some(webview.label()))
    else {
        return false;
    };
    let mut table = webview.resources_table();
    if !table
        .get::<ChannelLease>(owner.resource)
        .is_ok_and(|lease| lease.handle == handle)
    {
        return false;
    }
    let lease = table.take::<ChannelLease>(owner.resource);
    drop(table);
    lease.is_ok()
}

fn clear_matching<R: Runtime>(app: &tauri::AppHandle<R>, matches: impl Fn(&Owner) -> bool) {
    let owners = owners(app);
    let removed = {
        let mut entries = owners.0.lock().unwrap_or_else(|p| p.into_inner());
        let handles: Vec<_> = entries
            .iter()
            .filter(|(_, owner)| matches(owner))
            .map(|(handle, _)| *handle)
            .collect();
        handles
            .into_iter()
            .filter_map(|handle| {
                entries.remove(&handle).map(|owner| {
                    owner.active.store(false, Ordering::Release);
                    (handle, owner)
                })
            })
            .collect::<Vec<_>>()
    };
    for (handle, owner) in removed {
        crate::channels::host().drop_channel(handle);
        (owner.release)();
    }
}

pub(crate) fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("rustra-channel-ownership")
        .on_webview_ready(|webview| {
            clear_matching(webview.app_handle(), |owner| {
                owner.webview.as_deref() == Some(webview.label())
            });
        })
        .on_navigation(|webview, _| {
            clear_matching(webview.app_handle(), |owner| {
                owner.webview.as_deref() == Some(webview.label())
            });
            true
        })
        .on_event(|app, event| match event {
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } => {
                clear_matching(app, |owner| owner.window.as_deref() == Some(label));
            }
            // Child WebViews can close independently of their parent window.
            tauri::RunEvent::MainEventsCleared => clear_matching(app, |owner| !(owner.alive)()),
            tauri::RunEvent::Exit => clear_matching(app, |_| true),
            _ => {}
        })
        .on_drop(|app| clear_matching(&app, |_| true))
        .build()
}

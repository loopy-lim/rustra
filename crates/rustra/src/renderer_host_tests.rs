use super::*;
use std::sync::Mutex;

/// 테스트용 mock host. 수행된 연산 순서와 메시지를 기록하고, 파괴된 surface 에
/// 대한 연산은 거부한다. capabilities 는 생성 시 주입한다.
struct MockHost {
    caps: RendererCapabilities,
    log: Mutex<Vec<String>>,
    messages: Mutex<Vec<HostMessage>>,
}

/// MockHost 가 다루는 surface — 정수 토큰.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MockSurface {
    id: u32,
    destroyed: bool,
}

/// MockHost 가 load 하는 bundle — 바이트.
#[derive(Debug, Clone, PartialEq, Eq)]
struct MockBundle(Vec<u8>);

impl MockHost {
    fn new(caps: RendererCapabilities) -> Self {
        Self {
            caps,
            log: Mutex::new(Vec::new()),
            messages: Mutex::new(Vec::new()),
        }
    }

    fn recorded(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }

    fn messages(&self) -> Vec<HostMessage> {
        self.messages.lock().unwrap().clone()
    }
}

impl RendererHost for MockHost {
    type Surface = MockSurface;
    type Bundle = MockBundle;

    fn create_surface(&self, options: SurfaceOptions) -> Result<Self::Surface> {
        // u16 command_id 공간과 무관한 단순 카운터 — atomic 없이 log 길이로 결정.
        let id = (self.log.lock().unwrap().len() + 1) as u32;
        self.log
            .lock()
            .unwrap()
            .push(format!("create_surface({options})"));
        Ok(MockSurface {
            id,
            destroyed: false,
        })
    }

    fn load(&self, surface: &Self::Surface, bundle: Self::Bundle) -> Result<()> {
        if surface.destroyed {
            return Err(surface_destroyed("load"));
        }
        self.log.lock().unwrap().push(format!(
            "load(surface={}, {} bytes)",
            surface.id,
            bundle.0.len()
        ));
        Ok(())
    }

    fn send_message(&self, surface: &Self::Surface, message: HostMessage) -> Result<()> {
        if surface.destroyed {
            return Err(surface_destroyed("send_message"));
        }
        let kind = message.kind();
        self.log
            .lock()
            .unwrap()
            .push(format!("send_message(surface={}, {kind})", surface.id));
        self.messages.lock().unwrap().push(message);
        Ok(())
    }

    fn resize(&self, surface: &Self::Surface, size: Size) -> Result<()> {
        if surface.destroyed {
            return Err(surface_destroyed("resize"));
        }
        self.log
            .lock()
            .unwrap()
            .push(format!("resize(surface={}, {size})", surface.id));
        Ok(())
    }

    fn set_visibility(&self, surface: &Self::Surface, visible: bool) -> Result<()> {
        if surface.destroyed {
            return Err(surface_destroyed("set_visibility"));
        }
        self.log
            .lock()
            .unwrap()
            .push(format!("set_visibility(surface={}, {visible})", surface.id));
        Ok(())
    }

    fn destroy(&self, surface: Self::Surface) -> Result<()> {
        if surface.destroyed {
            return Err(surface_destroyed("destroy"));
        }
        self.log
            .lock()
            .unwrap()
            .push(format!("destroy(surface={})", surface.id));
        Ok(())
    }

    fn capabilities(&self) -> RendererCapabilities {
        self.caps
    }
}

#[test]
fn lifecycle_create_load_message_destroy() {
    let host = MockHost::new(RendererCapabilities {
        evaluate_script: true,
        ..Default::default()
    });
    let opts = SurfaceOptions {
        size: Size {
            width: 780,
            height: 1688,
        },
        transparent: false,
        scale: 2.0,
    };
    let surface = host.create_surface(opts).unwrap();
    host.load(&surface, MockBundle(b"TEST-BUNDLE".to_vec()))
        .unwrap();
    host.send_message(
        &surface,
        HostMessage::Event {
            name: "tick".into(),
            payload: vec![1, 2, 3],
        },
    )
    .unwrap();
    host.send_message(
        &surface,
        HostMessage::InvokeResponse {
            request_id: 7,
            payload: vec![0u8; 8],
        },
    )
    .unwrap();
    host.resize(
        &surface,
        Size {
            width: 10,
            height: 10,
        },
    )
    .unwrap();
    host.set_visibility(&surface, true).unwrap();
    host.destroy(surface).unwrap();

    let log = host.recorded();
    assert_eq!(
        log,
        vec![
            "create_surface(780x1688 @2)",
            "load(surface=1, 11 bytes)",
            "send_message(surface=1, Event)",
            "send_message(surface=1, InvokeResponse)",
            "resize(surface=1, 10x10)",
            "set_visibility(surface=1, true)",
            "destroy(surface=1)",
        ],
        "lifecycle order must match the canonical create→load→send→resize→vis→destroy flow"
    );
    assert_eq!(host.messages().len(), 2);
}

#[test]
fn destroyed_surface_rejects_operations() {
    let host = MockHost::new(RendererCapabilities::default());
    let surface = host.create_surface(SurfaceOptions::default()).unwrap();
    // Simulate destroy by constructing a destroyed surface view. The trait takes
    // &Surface for ops, so we make a destroyed copy to exercise the guard.
    let dead = MockSurface {
        id: surface.id,
        destroyed: true,
    };
    let err = host
        .send_message(
            &dead,
            HostMessage::ChannelFrame {
                stream_id: 1,
                frame: vec![],
            },
        )
        .unwrap_err();
    assert_eq!(err.code(), "renderer.surface_destroyed");
    let err = host
        .resize(
            &dead,
            Size {
                width: 1,
                height: 1,
            },
        )
        .unwrap_err();
    assert_eq!(err.code(), "renderer.surface_destroyed");
}

#[test]
fn capabilities_default_is_deny_by_default() {
    // deny-by-default: 아무 capability 도 켜지지 않은 상태가 기본값.
    let caps = RendererCapabilities::default();
    assert!(!caps.evaluate_script);
    assert!(!caps.navigation);
    assert!(!caps.cookies);
    assert!(!caps.browser_history);
    assert!(!caps.devtools);
}

#[test]
fn capability_gating_present_only_host_blocks_eval() {
    // present-only renderer (pure RGBA blit): evaluate_script = false.
    let present_only = MockHost::new(RendererCapabilities::default());
    assert!(
        !host_supports_eval(&present_only),
        "present-only renderer must NOT be asked to eval JS"
    );
    // JS-capable renderer: 런타임 eval 가능 → evaluate_script = true.
    let js_capable = MockHost::new(RendererCapabilities {
        evaluate_script: true,
        ..Default::default()
    });
    assert!(
        host_supports_eval(&js_capable),
        "JS-capable renderer must report eval support"
    );
}

#[test]
fn host_message_kind_classification() {
    assert_eq!(
        HostMessage::InvokeResponse {
            request_id: 0,
            payload: vec![]
        }
        .kind(),
        MessageKind::InvokeResponse
    );
    assert_eq!(
        HostMessage::Event {
            name: "x".into(),
            payload: vec![]
        }
        .kind(),
        MessageKind::Event
    );
    assert_eq!(
        HostMessage::ChannelFrame {
            stream_id: 0,
            frame: vec![]
        }
        .kind(),
        MessageKind::ChannelFrame
    );
}

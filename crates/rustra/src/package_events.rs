impl Package {
    /// JS 로 푸시할 이벤트를 발행한다.
    ///
    /// 커맨드 핸들러 안에서 호출한다. 페이로드는 `Serialize` 가능한 값이면
    /// 무엇이든 JSON 으로 직렬화된다.
    ///
    /// # 전달 경로 (상호 배타적)
    ///
    /// - [`Package::set_event_sink`] 로 싱크가 설치되어 있으면 **즉시 콜백 호출**.
    ///   이때 이벤트 버스에는 쌓이지 않는다(푸시+폴링 이중 수신 방지).
    /// - 싱크가 없으면 기존대로 [`Package::event_bus`] 큐에 쌓이고, 호스트
    ///   어댑터가 폴링해 플랫폼 푸시 채널(Tauri `emit`, RN `DeviceEventEmitter`)
    ///   로 전달한다.
    ///
    /// ```rust
    /// # use rustra::prelude::*;
    /// # #[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
    /// # #[serde(rename_all = "camelCase")]
    /// # struct ProgressInput { total: i64 }
    /// # #[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
    /// # #[serde(rename_all = "camelCase")]
    /// # struct ProgressOutput { done: bool }
    /// #[command]
    /// fn start_work(input: ProgressInput) -> Result<ProgressOutput> {
    ///     let pkg = current_package(); // 어댑터가 주입한 핸들
    ///     for i in 0..input.total {
    ///         pkg.emit("progress.tick", serde_json::json!({ "value": i }));
    ///     }
    ///     Ok(ProgressOutput { done: true })
    /// }
    /// # fn current_package() -> rustra::Package { unimplemented!() }
    /// ```
    pub fn emit<E: Serialize>(&self, event: impl Into<String>, payload: E) {
        let name = event.into();
        let json = serde_json::to_string(&payload).unwrap_or_else(|e| {
            // 직렬화 불가 페이로드를 조용히 빈 JSON 로 보내던 폴백 — 최소한 stderr
            // 경고를 남겨 스트리밍 유즈케이스에서 유실이 관측되게 한다.
            eprintln!("rustra: event '{name}' payload failed to serialize: {e}");
            "{}".to_string()
        });
        if self.events.deliver_via_sink(&name, &json) {
            return; // 싱크 경로 — 버스 우회 (이중 전달 방지)
        }
        self.events.bus.emit(name, json);
    }

    /// 푸시 전달 [`events::EventSink`] 를 설치/교체/해제한다.
    ///
    /// 빌드 이후 언제든 호출 가능하다(`Package` 는 `Arc` 내부 상태를 공유하므로
    /// clone 에서 설정해도 원본을 포함한 모든 clone 에 적용된다).
    /// `Some(sink)` 를 넘기면 이후 `emit` 은 싱크를 즉시 호출하고 **이벤트 버스에
    /// 쌓지 않는다** — 폴링(`take_pending_events`)과 푸시를 동시에 쓰는 호스트에서
    /// 같은 이벤트가 두 번 수신되는 것을 방지하는 계약이다. `None` 을 넘기면
    /// 즉시 폴링 경로로 돌아간다(버스 용량/drop-oldest 정책도 그대로).
    ///
    /// 싱크 콜백은 `emit` 을 호출한 스레드에서 실행되며, 패닉하면 stderr 에
    /// 로그만 남고 `emit` 은 정상 복귀한다(자세한 계약은 [`events::EventSink`]).
    ///
    /// ```rust
    /// # use rustra::prelude::*;
    /// # use std::sync::{Arc, Mutex};
    /// let pkg = Package::builder("example.stream").build();
    /// let seen = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
    /// let sink_seen = Arc::clone(&seen);
    /// pkg.set_event_sink(Some(Arc::new(move |name: &str, payload: &str| {
    ///     sink_seen.lock().unwrap().push((name.to_string(), payload.to_string()));
    /// })));
    /// pkg.emit("tick", serde_json::json!({ "value": 1 }));
    /// assert_eq!(seen.lock().unwrap().len(), 1);
    /// assert!(pkg.event_bus().take_pending_events().is_empty()); // 버스 우회
    /// pkg.set_event_sink(None);
    /// pkg.emit("tick", serde_json::json!({ "value": 2 }));
    /// assert_eq!(pkg.event_bus().take_pending_events().len(), 1); // 폴링 복귀
    /// ```
    /// # 동시성
    ///
    /// 설정/해제 시점(부트스트랩·종료) 호출을 전제로 한다. 교체 직후 진행 중이던
    /// `emit` 은 이전 경로(구 싱크 또는 버스)로 전달될 수 있으나, 이벤트별
    /// 정확히 한 번 전달은 항상 유지된다.
    pub fn set_event_sink(&self, sink: Option<events::EventSink>) {
        *self
            .events
            .sink
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = sink;
    }

    /// 이벤트 버스에 대한 접근자 — 호스트 어댑터 폴링용.
    ///
    /// 반환된 [`events::EventBus`]는 `Arc` 공유 클론이므로 어댑터에 저장해
    /// 자유롭게 폴링(`take_pending_events`)할 수 있다. 싱크가 설치된 동안에는
    /// `emit` 이 버스를 건너뛰므로 큐가 비어 있다.
    pub fn event_bus(&self) -> &events::EventBus {
        &self.events.bus
    }
}

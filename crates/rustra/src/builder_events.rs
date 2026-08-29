impl PackageBuilder {
    /// 이벤트 버스 큐의 최대 수용량을 설정합니다 (기본값: 1024).
    pub fn event_capacity(mut self, capacity: usize) -> Self {
        self.event_capacity = capacity.max(1);
        self
    }

    /// (이벤트 계약) `Package::emit` 으로 발행될 이벤트를 타입과 함께 선언한다.
    ///
    /// 선언된 이벤트는 schema.json 의 최상위 `events` 섹션에 이름/페이로드
    /// 스키마로 기록되고, TS 코드젠(@rustra/cli)이 이벤트 타입과 구독 헬퍼를
    /// 생성한다 — 커맨드와 동일한 "한 번 정의하면 어디서든 타입 안전" 계약을
    /// 이벤트에도 적용하는 진입점이다. 선언하지 않은 이벤트도 emit 은 가능하다
    /// (하위호환) — 코드젠 산출물에 타입이 없을 뿐이다.
    ///
    /// ```rust
    /// # use rustra::prelude::*;
    /// # #[derive(Debug, Serialize, Deserialize, JsonSchema)]
    /// # #[serde(rename_all = "camelCase")]
    /// # struct ProgressPayload { pub value: i64 }
    /// let pkg = Package::builder("example.stream")
    ///     .event::<ProgressPayload>("progress.tick")
    ///     .build();
    /// // emit("progress.tick", ProgressPayload { value: 1 }) 의 페이로드 타입이
    /// // schema.json/TS 코드젠에 노출된다.
    /// # let _ = pkg;
    /// ```
    pub fn event<E: JsonSchema>(mut self, name: &str) -> Self {
        let (schema, defs) = schema_value::<E>();
        self.events.insert(
            name.to_string(),
            json!({ "payload": schema, "definitions": defs }),
        );
        self
    }

    /// (T2, OTA) 스키마 버전 — 구 JS 클라이언트의 stale 감지에 사용된다.
    /// 코드젠이 SCHEMA_VERSION 으로 노출하고, 엔진이 live schema 의 버전과
    /// 비교해 JS > native 인 경우 경고한다. 기본 1.
    pub fn schema_version(mut self, version: u32) -> Self {
        self.schema_version = version;
        self
    }

    /// 공유 상태를 패키지에 등록합니다.
    ///
    /// 등록된 상태는 `State<T>` 파라미터를 받는 `#[command]` 핸들러에
    /// 자동으로 주입됩니다.
    pub fn manage<T: Send + Sync + 'static>(mut self, state: T) -> Self {
        self.states
            .insert(std::any::TypeId::of::<T>(), Arc::new(state));
        self
    }
}

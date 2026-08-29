impl Package {
    /// 패키지의 고유 식별자(ID)를 반환합니다.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// 새로운 [`PackageBuilder`]를 생성합니다.
    ///
    /// `id`는 패키지를 식별하는 고유 문자열입니다. 역방향 도메인 표기법을 권장합니다
    /// (예: `"com.example.calculator"`).
    pub fn builder(id: impl Into<String>) -> PackageBuilder {
        PackageBuilder {
            id: id.into(),
            commands: BTreeMap::new(),
            next_command_id: 1,
            id_aliases: Vec::new(),
            event_capacity: 1024,
            events: BTreeMap::new(),
            schema_version: 1,
            states: state::StateMap::new(),
        }
    }

    /// 패키지에 등록된 `State<T>` 인스턴스를 조회합니다.
    pub fn state<T: Send + Sync + 'static>(&self) -> Option<State<T>> {
        let any_arc = self.states.get(&std::any::TypeId::of::<T>())?.clone();
        let concrete_arc = any_arc.downcast::<T>().ok()?;
        Some(State(concrete_arc))
    }

    /// 타입이 지정된 명령을 호출합니다.
    pub fn invoke<I, O>(&self, name: &str, input: I) -> crate::Result<O>
    where
        I: Serialize,
        O: DeserializeOwned,
    {
        let params = serde_json::to_value(input).map_err(RustraError::invalid_args)?;
        let result = self.invoke_json(name, params)?;
        serde_json::from_value(result).map_err(RustraError::internal)
    }
}

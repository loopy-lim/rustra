impl Package {
    /// JSON [`Value`]를 직접 전달하여 명령을 호출합니다.
    ///
    /// [`invoke`](Package::invoke)의 비제네릭 버전으로, JSON 기반 라우팅에 사용됩니다.
    pub fn invoke_json(&self, name: &str, params: Value) -> crate::Result<Value> {
        if self.is_frozen() {
            // 제품 경로는 immutable snapshot 안의 Command를 직접 빌린다. 매 호출
            // Arc clone/drop은 같은 refcount cache line을 모든 CPU가 갱신하게 해
            // 병렬 처리량을 역확장시키므로 frozen hot path에서는 피한다.
            let command = self
                .frozen_registry
                .get()
                .and_then(|registry| registry.commands.get(name))
                .ok_or_else(|| self.command_not_found(name))?;
            return self.invoke_json_command(command, params);
        }

        // 개발용 mutable 경로는 핸들러 실행 중 잠금을 hold하지 않도록
        // Command를 clone-out한다(재진입 register/unregister 교착 방지).
        let command = {
            let state = self
                .state
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state
                .commands
                .get(name)
                .ok_or_else(|| self.command_not_found(name))?
                .clone()
        };
        self.invoke_json_command(command.as_ref(), params)
    }

    #[inline]
    fn invoke_json_command(&self, command: &Command, params: Value) -> crate::Result<Value> {
        // Runtime Authority: deny-by-default — capability 가 요구되는데 부여되지
        // 않았으면 핸들러를 호출하지 않고 capability.denied 를 반환한다.
        self.capability_satisfied(command)?;
        with_state_context(&self.states, || (command.invoke)(params))
    }

    /// command_id로 명령 이름을 조회합니다.
    pub fn resolve_command_id(&self, id: u16) -> Option<String> {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .id_to_name
            .get(&id)
            .cloned()
    }

    /// 등록된 명령 이름을 안정적인 선언 순서(BTreeMap 키 순서)로 반환합니다.
    /// 호스트의 진단 UI와 command.not_found 오류 제안에 사용합니다.
    pub fn command_names(&self) -> Vec<String> {
        if self.is_frozen() {
            return self
                .frozen_registry
                .get()
                .map(|registry| registry.commands.keys().cloned().collect())
                .unwrap_or_default();
        }
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .commands
            .keys()
            .cloned()
            .collect()
    }

    fn command_not_found(&self, name: &str) -> RustraError {
        let names = self.command_names();
        let available = if names.is_empty() {
            "none".to_owned()
        } else {
            names.join(", ")
        };
        let suggestion = names
            .iter()
            .filter_map(|candidate| {
                let distance = edit_distance(name, candidate);
                let threshold = 2.max(name.chars().count() / 3);
                (distance <= threshold).then_some((distance, candidate))
            })
            .min_by_key(|(distance, _)| *distance)
            .map(|(_, candidate)| format!(" Did you mean '{candidate}'?"))
            .unwrap_or_default();
        RustraError::custom(
            "command.not_found",
            format!("command not found: {name}. Available commands: {available}.{suggestion}"),
        )
    }
}

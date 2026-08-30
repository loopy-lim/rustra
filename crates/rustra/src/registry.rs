use super::*;

impl Package {
    /// 런타임 mutation을 영구적으로 비활성화한다.
    ///
    /// release 빌드에서는 `build()` 시점에 이미 동결되어 있다. debug 빌드에서
    /// prod 동작을 시뮬레이션하거나 런타임에 명시적으로 잠그고 싶을 때 사용한다.
    /// 한 번 동결하면 해제할 수 없다.
    pub fn freeze(&self) {
        // registry writer와 직렬화한 뒤 frozen을 publish한다. mutation 쪽도
        // writer를 얻은 뒤 다시 검사하므로, ensure_mutable → lock 사이에
        // freeze가 끼어든 뒤 명령이 등록되는 TOCTOU가 없다.
        let state = self
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _ = self.frozen_registry.set(FrozenRegistry::from_state(&state));
        self.frozen.store(true, Ordering::Release);
    }

    /// 패키지가 동결되어 런타임 mutation이 불가능한지 여부.
    pub fn is_frozen(&self) -> bool {
        self.frozen.load(Ordering::Acquire)
    }

    fn ensure_mutable(&self) -> crate::Result<()> {
        if self.is_frozen() {
            Err(RustraError::custom(
                "registry.frozen",
                "package is frozen; runtime mutation disabled",
            ))
        } else {
            Ok(())
        }
    }

    /// Runtime Authority: capability 를 부여한다 (deny-by-default 해제).
    ///
    /// `required_capability` 가 `Some(cap)` 인 명령은 `cap` 이 부여되기 전까지
    /// `capability.denied` 로 거부된다 — 핸들러는 아예 호출되지 않는다. 이 메서드로
    /// `cap` 을 granted 집합에 추가하면 이후 해당 명령이 허용된다.
    ///
    /// 동결(freeze)은 레지스트리 **구조** mutation(register/unregister/replace)에만
    /// 적용된다 — grant는 런타임 권한 부여이므로 동결과 무관하게 허용한다. 그렇지
    /// 않으면 release 빌드(`build()` 시점 동결)에서 권한을 부여할 방법이 없어
    /// deny-by-default 가 deny-forever 가 된다.
    pub fn grant_capability(&self, cap: &str) -> crate::Result<()> {
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.granted_capabilities.insert(cap.to_string());
        Ok(())
    }

    /// `cap` 이 현재 부여되어 있는지 (읽기 전용, 동결 무관).
    pub fn has_capability(&self, cap: &str) -> bool {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .granted_capabilities
            .contains(cap)
    }

    /// `command` 가 요구하는 capability 가 현재 부여되어 있는지 검사한다.
    /// capability 가 `None` 이면 항상 허용.
    pub(crate) fn capability_satisfied(&self, command: &Command) -> crate::Result<()> {
        if let Some(required) = command.required_capability {
            let granted = self
                .state
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .granted_capabilities
                .contains(required);
            if !granted {
                return Err(RustraError::capability_denied(format!(
                    "command requires capability '{required}' which was not granted"
                )));
            }
        }
        Ok(())
    }

    /// 런타임에 명령을 등록한다.
    ///
    /// 같은 이름이 이미 존재하면 핸들러를 덮어쓴다. 이때 기존 `command_id`가 유지되어
    /// 바이너리 경로의 기존 호출자가 그대로 동작한다. 동결 상태면 `registry.frozen`,
    /// `command_id` 공간이 소진되면 `registry.id_exhausted` 에러를 반환한다.
    pub fn register<I, O, F>(&self, name: &str, handler: F) -> crate::Result<()>
    where
        I: DeserializeOwned + JsonSchema + 'static,
        O: Serialize + JsonSchema + 'static,
        F: Fn(I) -> crate::Result<O> + Send + Sync + 'static,
    {
        self.ensure_mutable()?;
        let name = name.to_string();
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.ensure_mutable()?;
        // 같은 이름이면 기존 command_id 재사용(stable id). 새 이름이면 단조 증가 ID 할당.
        let command_id = match state.commands.get(&name).map(|c| c.command_id) {
            Some(existing) => existing,
            None => {
                let id = state.next_command_id;
                // u16::MAX 는 exhausted sentinel 로 예약 (할당 불가).
                if id == u16::MAX {
                    return Err(RustraError::custom(
                        "registry.id_exhausted",
                        "command_id u16 space exhausted (max 65534 commands)",
                    ));
                }
                state.next_command_id = id + 1;
                id
            }
        };
        // (T2-1) 동적 명령도 정적 명령과 동일한 라우트 선택을 받는다 — JS 코덱
        // 지원 형태면 postcard binary 핸들러, 아니면 complex codec, 둘 다
        // 미지원일 때만 Tier 3 JSON. 와이어 분기는 `build_command` 가 JS 코드젠
        // 지원 판정을 미러해 결정하므로 JS 엔진과의 정합은 유지된다(T2-3 에서
        // JS 측 라우팅이 따라온다).
        let command = Arc::new(build_command::<I, O, F>(command_id, handler));
        state.id_to_command.insert(command_id, Arc::clone(&command));
        state.commands.insert(name.clone(), command);
        state.id_to_name.insert(command_id, name);
        state.live_schema_cache = None;
        state.schema_generation = state.schema_generation.wrapping_add(1);
        Ok(())
    }

    /// `#[command]` 함수를 이름 자동 추론으로 런타임 등록한다.
    pub fn register_fn<I, O, F>(&self, handler: F) -> crate::Result<()>
    where
        I: DeserializeOwned + JsonSchema + 'static,
        O: Serialize + JsonSchema + 'static,
        F: Fn(I) -> crate::Result<O> + Send + Sync + 'static,
    {
        let name = command_name_from_handler::<F>();
        self.register::<I, O, F>(&name, handler)
    }

    /// 기존 명령의 핸들러를 교체한다. 이름이 없으면 `command.not_found`.
    /// `command_id`는 유지된다. 동결 상태면 `registry.frozen`.
    pub fn replace<I, O, F>(&self, name: &str, handler: F) -> crate::Result<()>
    where
        I: DeserializeOwned + JsonSchema + 'static,
        O: Serialize + JsonSchema + 'static,
        F: Fn(I) -> crate::Result<O> + Send + Sync + 'static,
    {
        self.ensure_mutable()?;
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.ensure_mutable()?;
        let existing = state
            .commands
            .get(name)
            .ok_or_else(|| RustraError::command_not_found(name))?;
        let command_id = existing.command_id;
        let required_capability = existing.required_capability;
        let mut command = build_command::<I, O, F>(command_id, handler);
        command.required_capability = required_capability;
        let command = Arc::new(command);
        state.id_to_command.insert(command_id, Arc::clone(&command));
        state.commands.insert(name.to_string(), command);
        state.live_schema_cache = None;
        state.schema_generation = state.schema_generation.wrapping_add(1);
        Ok(())
    }

    /// 명령을 제거한다. `command_id`는 retired 되어 **재사용되지 않는다**.
    /// 이름이 없으면 `command.not_found`. 동결 상태면 `registry.frozen`.
    /// (T2, OTA) 그 명령을 가리키던 alias id 항목도 함께 제거된다.
    pub fn unregister(&self, name: &str) -> crate::Result<()> {
        self.ensure_mutable()?;
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.ensure_mutable()?;
        if state.commands.remove(name).is_none() {
            return Err(RustraError::command_not_found(name));
        }
        // 실제 id 와 그 명령을 가리키던 alias id 를 모두 정리 — alias 만
        // 남으면 stale 라우팅 항목이 된다.
        let removed_ids: Vec<u16> = state
            .id_to_name
            .iter()
            .filter(|(_, target)| target.as_str() == name)
            .map(|(id, _)| *id)
            .collect();
        state.id_to_name.retain(|_, target| target != name);
        for id in removed_ids {
            state.id_to_command.remove(&id);
        }
        state.live_schema_cache = None;
        state.schema_generation = state.schema_generation.wrapping_add(1);
        // NOTE: next_command_id는 감소시키지 않는다 — retired id는 영원히 재사용 금지.
        Ok(())
    }
}

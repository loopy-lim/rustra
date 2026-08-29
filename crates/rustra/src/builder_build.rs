impl PackageBuilder {
    /// 등록된 모든 명령을 불변 [`Package`]로 빌드합니다.
    pub fn build(self) -> Package {
        let mut commands = self.commands;
        let mut next_command_id = self.next_command_id;

        // ── (T2, OTA) alias 병합 ────────────────────────────
        // alias 는 id_to_name 의 부가 라우팅 항목이다 — 대상 명령의 실제
        // command_id 는 그대로다. 대상 미등록은 패닉(선언 시점 검증은
        // alias_command_id 참조). 전방 선언된 alias 의 구 id 를 다른 명령이
        // 실제 id 로 점유 중이면(스키마 성장 시나리오) 점유 명령을 fresh id 로
        // 이동시킨다 — 조용한 섀도잉은 엉뚱한 명령 실행 버그이므로.
        let mut alias_id_to_name: BTreeMap<u16, String> = BTreeMap::new();
        for (command, legacy_id) in &self.id_aliases {
            if !commands.contains_key(command) {
                panic!(
                    "alias_command_id: target command '{command}' is not registered \
                     (aliases: {:#?})",
                    self.id_aliases
                );
            }
            alias_id_to_name.insert(*legacy_id, command.clone());
        }
        // fresh id 와 런타임 register 모두가 alias id 를 할당해 조용히 덮어쓰지
        // 못하게 next_command_id 를 **모든** alias id 너머로 먼저 밀어둔다.
        // 이 순서가 핵심이다: alias id 는 구 스키마 기준이라 현재 명령 수보다
        // 클 수 있다(구 명령이 제거된 경우) — displacement 의 fresh id 를
        // alias 병합 이후의 next_command_id 로 할당하면 이미 병합된 alias 항목
        // 위에 정확히 덜어져 silent misrouting 이 된다(리뷰 지적 회귀).
        if let Some(&max_alias) = alias_id_to_name.keys().next_back() {
            // u16::MAX 는 exhausted sentinel — alias 가 그 근처면 이후
            // 런타임 register 는 기존처럼 registry.id_exhausted 로 거부된다.
            next_command_id = next_command_id.max(max_alias.saturating_add(1));
        }
        for (command, legacy_id) in &self.id_aliases {
            // 점유 충돌 해소: legacy_id 가 다른 명령의 실제 id 면 그 명령을
            // fresh id 로 이동. 선언 시점에 등록돼 있던 충돌은 alias_command_id
            // 가 이미 패닉시켰으므로, 여기 오는 전방 선언 케이스만 남는다.
            if let Some((occupant, _)) = commands
                .iter()
                .find(|(name, cmd)| cmd.command_id == *legacy_id && name.as_str() != command)
            {
                let occupant = occupant.clone();
                let fresh = next_command_id;
                next_command_id += 1;
                commands
                    .get_mut(&occupant)
                    .expect("occupant verified above")
                    .command_id = fresh;
            }
        }

        let mut id_to_name: BTreeMap<u16, String> = alias_id_to_name;
        for (name, cmd) in &commands {
            id_to_name.insert(cmd.command_id, name.clone());
        }
        // (성능) id → Command 직접 캐시 — alias id 포함 전체 id_to_name 키와
        // 정확히 같은 라우팅을 제공한다(lookup 일관성: id_to_name 이 가리키는
        // 모든 id 는 여기서도 같은 명령을 찾는다).
        // 빌더의 owned Command를 한 번만 Arc로 감싼다. 이후 JSON/rkyv invoke의
        // clone-out은 String/schema/handler를 각각 복제하지 않고 Arc refcount
        // 1회만 증가한다.
        let commands: BTreeMap<String, Arc<Command>> = commands
            .into_iter()
            .map(|(name, command)| (name, Arc::new(command)))
            .collect();
        let id_to_command: BTreeMap<u16, Arc<Command>> = id_to_name
            .iter()
            .map(|(id, name)| {
                let cmd = commands
                    .get(name)
                    .unwrap_or_else(|| panic!("build(): id {id} → '{name}' not in commands"));
                (*id, Arc::clone(cmd))
            })
            .collect();
        // (T2 리뷰) tripwire: 최종 병합 뒤 모든 alias 가 자기 명령을 가리키는지
        // 확인한다. displacement/next_command_id 순서가 다시 깨지면(alias 항목을
        // 실제 id 삽입이 덮어쓰거나 fresh id 가 alias 와 겹치면) 여기서 즉시
        // 잡힌다 — 조용한 misrouting 을 빌드 시점 국소 실패로 바꾼다.
        debug_assert!(
            self.id_aliases.iter().all(|(command, legacy_id)| {
                id_to_name.get(legacy_id).is_some_and(|n| n == command)
            }),
            "alias merge invariant broken: some legacy id does not resolve to its command"
        );
        let state = RegistryState {
            commands,
            id_to_name,
            id_to_command,
            next_command_id,
            granted_capabilities: BTreeSet::new(),
            schema_version: self.schema_version,
            live_schema_cache: None,
        };
        let frozen_registry = OnceLock::new();
        let frozen = !cfg!(debug_assertions);
        if frozen {
            let _ = frozen_registry.set(FrozenRegistry::from_state(&state));
        }
        Package {
            id: self.id,
            state: Arc::new(RwLock::new(state)),
            frozen: Arc::new(AtomicBool::new(frozen)),
            frozen_registry: Arc::new(frozen_registry),
            events: Arc::new(events::EventState::with_capacity(self.event_capacity)),
            event_contracts: self.events,
            states: Arc::new(self.states),
        }
    }

    /// [`build`](PackageBuilder::build)의 별칭입니다.
    ///
    /// `rustra::build!("name", fn1, fn2).done()` 형태에서 사용합니다.
    pub fn done(self) -> Package {
        self.build()
    }
}

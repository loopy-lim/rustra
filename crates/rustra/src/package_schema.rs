impl Package {
    pub fn live_schema(&self) -> Value {
        {
            let state = self
                .state
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(schema) = &state.live_schema_cache {
                return schema.clone();
            }
        }

        // register/replace/unregister와 같은 write lock으로 직렬화한다. read lock을
        // 놓은 사이 다른 reader가 먼저 채웠다면 그 값을 재사용하고, writer가
        // 구조를 바꿨다면 최신 state로 한 번만 다시 만든다.
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(schema) = &state.live_schema_cache {
            return schema.clone();
        }
        let schema = Self::schema(&self.id, &state, &self.event_contracts);
        state.live_schema_cache = Some(schema.clone());
        schema
    }

    /// (T0) 현재 스키마 세대 — register/replace/unregister 마다 증가한다.
    /// 호스트는 이 값을 폴링/비교해 동적 명령 캐시의 재동기화 시점을 판정한다.
    /// read lock 1회 + u64 복사 — 호출 비용 수십 ns.
    pub fn schema_generation(&self) -> u64 {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .schema_generation
    }

    /// 등록된 모든 명령에서 TypeScript 클라이언트 코드를 생성합니다.
    pub fn generate_typescript(&self) -> crate::Result<GeneratedPackage> {
        let state = self
            .state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let schema_json =
            serde_json::to_string_pretty(&Self::schema(&self.id, &state, &self.event_contracts))
                .map_err(RustraError::internal)?;
        let contract_hash = contract_hash(&schema_json);
        let types_ts = Self::generate_types_ts(&state);
        let commands_ts = Self::generate_commands_ts(&state);

        Ok(GeneratedPackage {
            contract_ts: format!(
                "export const GENERATED_CONTRACT_HASH = '{contract_hash}';\n\
                 export const SCHEMA_VERSION = {};\n",
                state.schema_version
            ),
            schema_json,
            types_ts,
            commands_ts,
            contract_hash,
        })
    }

    fn schema(id: &str, state: &RegistryState, event_contracts: &BTreeMap<String, Value>) -> Value {
        let commands = state
            .commands
            .iter()
            .map(|(name, command)| {
                let mut input_schema = (*command.input_schema).clone();
                let mut output_schema = (*command.output_schema).clone();
                let mut definitions = (*command.definitions).clone();
                annotate_variant_order(&mut input_schema);
                annotate_variant_order(&mut output_schema);
                annotate_variant_order(&mut definitions);
                let mut entry = json!({
                    "name": name,
                    "commandId": command.command_id,
                    "inputType": command.input_type,
                    "outputType": command.output_type,
                    "inputSchema": input_schema,
                    "outputSchema": output_schema,
                });
                if let Some(description) = &command.description {
                    entry
                        .as_object_mut()
                        .expect("command schema is an object")
                        .insert("description".into(), Value::String(description.clone()));
                }
                // Include definitions if non-empty (for $ref resolution)
                #[allow(clippy::collapsible_if)]
                if let Value::Object(defs) = &definitions {
                    if !defs.is_empty() {
                        entry
                            .as_object_mut()
                            .unwrap()
                            .insert("definitions".into(), definitions);
                    }
                }
                entry
            })
            .collect::<Vec<_>>();

        // (이벤트 계약) 선언된 이벤트가 있을 때만 events 섹션을 만든다 — 없으면
        // 기존 schema.json 형태와 바이트 단위로 동일(하위호환).
        let mut root = json!({
            "packageId": id,
            "schemaVersion": state.schema_version,
            // rustra enables schemars/serde_json `preserve_order`, so object
            // properties are emitted in the same declaration order postcard
            // uses on the wire. Consumers can distinguish this guaranteed
            // contract from legacy or third-party schema files.
            "fieldOrder": "declaration",
            "commands": commands,
        });
        if !event_contracts.is_empty() {
            let events: Vec<Value> = event_contracts
                .iter()
                .map(|(name, contract)| {
                    json!({ "name": name, "payload": &contract["payload"], "definitions": &contract["definitions"] })
                })
                .collect();
            root.as_object_mut()
                .expect("root is an object")
                .insert("events".into(), json!(events));
        }
        root
    }
}

impl Package {
    /// 라이브 스키마 스냅샷 — `schemaGeneration` 필드(T0)를 포함한다. mutation
    /// (register/replace/unregister) 시 캐시가 무효화되고 새 세대로 다시
    /// 채워지므로 소비자는 항상 일치하는 세대를 본다. contract hash 입력인
    /// `schema()` 는 세대를 심지 않는다(와이어/OTA 계약 불변).
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
        // (T0) 캐시 스냅샷 자체에 세대를 스냅샷으로 심는다 — mutation 시 캐시가
        // 무효화되고 새 세대로 다시 채워지므로 live_schema() 소비자는 항상
        // 일치하는 세대를 본다. schema() (contract hash 입력) 는 불변.
        let mut schema = Self::schema(&self.id, &state, &self.event_contracts);
        schema
            .as_object_mut()
            .expect("live schema root is an object")
            .insert(
                "schemaGeneration".into(),
                Value::from(state.schema_generation),
            );
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

    /// 계약 해시 입력 — generation 미포함 스키마(`schema()`)의 pretty JSON.
    /// 빌드 시점 `generate_typescript()`의 `GENERATED_CONTRACT_HASH`와 FFI
    /// `rustra_ffi_contract_hash`가 반드시 같은 입력을 해시하도록 직렬화를 이
    /// 함수 하나로 단일 소스화한다. `live_schema()`와 달리 세대를 심지 않는다
    /// (와이어/OTA 계약 불변).
    ///
    /// 호출자가 이미 잡은 read lock 상태에서 쓴다 — self에서 lock을 다시 잡지
    /// 않는다.
    fn contract_schema_json(&self, state: &RegistryState) -> String {
        // serde_json::Value 직렬화는 실패할 수 없다(비문자열 키 맵이 없음).
        serde_json::to_string_pretty(&Self::schema(&self.id, state, &self.event_contracts))
            .expect("schema serialization cannot fail on a serde_json::Value")
    }

    /// 등록된 모든 명령에서 TypeScript 클라이언트 코드를 생성합니다.
    ///
    /// 생성 파일(`types_ts`/`commands_ts`)과 별개로 매핑 불가 스키마가
    /// `"unknown"` 폴백한 위치를 `GeneratedPackage::warnings`로 돌려준다.
    pub fn generate_typescript(&self) -> crate::Result<GeneratedPackage> {
        clear_codegen_warnings();
        let state = self
            .state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let schema_json = self.contract_schema_json(&state);
        let contract_hash = contract_hash(&schema_json);
        let types_ts = Self::generate_types_ts(&state);
        let commands_ts = Self::generate_commands_ts(&state);
        let warnings = take_codegen_warnings()
            .into_iter()
            .map(|warning| warning.message())
            .collect();

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
            warnings,
        })
    }

    /// FFI `rustra_ffi_contract_hash`용 계약 해시 — `generate_typescript()`와
    /// 동일 입력(generation 미포함)을 해시한다. `contract_schema_json`이 단일
    /// 소스이므로 양쪽이 갈라질 수 없다.
    pub(crate) fn generated_contract_hash(&self) -> String {
        let state = self
            .state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        contract_hash(self.contract_schema_json(&state))
    }

    fn schema(id: &str, state: &RegistryState, event_contracts: &BTreeMap<String, Value>) -> Value {
        let commands = state
            .commands
            .iter()
            .map(|(name, command)| command_schema_entry(name, command))
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

/// 스키마의 명령 한 항목 — `Package::schema` 와 핫 리로드 와이어 서명
/// (`command_wire_signature`)이 함께 쓰는 단일 소스. 여기가 갈라지면 계약
/// 해시와 서명이 어긋나므로 항목 형태 변경은 이 함수 하나에서만.
pub(crate) fn command_schema_entry(name: &str, command: &Command) -> Value {
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
}

/// 명령의 와이어 서명 — 스키마 항목 JSON(`command_schema_entry`) 원본 바이트의
/// SHA-256 hex. 계약 해시(`contract_hash`)와 같은 해시 함수를 쓰고 항목 빌더를
/// 공유하므로 두 값이 갈라질 수 없다. 핫 리로드 주입(`rustra_ffi_hot_reload`)
/// 이 "같은 와이어 계약의 핸들러인가"를 판정하는 단일 소스.
pub(crate) fn command_wire_signature(name: &str, command: &Command) -> String {
    let entry = command_schema_entry(name, command);
    contract_hash(serde_json::to_vec(&entry).expect("schema entry serializes"))
}

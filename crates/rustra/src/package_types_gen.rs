impl Package {
    fn generate_types_ts(state: &RegistryState) -> String {
        let mut output = String::from(
            "export type { EngineClient, RustraError } from '@rustra/types';\n\
             export { RustraCommandError } from '@rustra/types';\n\n",
        );

        let mut all_definitions = serde_json::Map::new();
        for command in state.commands.values() {
            if let Value::Object(defs) = &*command.definitions {
                for (key, value) in defs {
                    all_definitions.insert(key.clone(), value.clone());
                }
            }
        }
        let definitions = Value::Object(all_definitions);

        let mut emitted = BTreeSet::new();
        // (S1) Rust 내부 타입명(String·Tuple_of_… 등) 누출 별칭은 하위 호환을 위해
        // 유지하되 @deprecated 로 표시한다 — commands_ts 시그니처는 인라인 타입으로
        // 정화됐다. TS CLI 렌더러(generate-surface.ts)와 동일 규칙.
        let js_doc_for = |name: &str, description: Option<&str>| -> String {
            if is_rust_internal_type_name(name) {
                deprecated_alias_js_doc(name)
            } else if let Some(desc) = description {
                format!("/**\n * {}\n */\n", desc.replace('\n', "\n * "))
            } else {
                String::new()
            }
        };
        if let Value::Object(def_map) = &definitions {
            for (name, def_schema) in def_map {
                if emitted.insert(name.clone()) {
                    set_codegen_command_context(name);
                    let description = def_schema.get("description").and_then(Value::as_str);
                    output.push_str(&js_doc_for(name, description));
                    output.push_str(&format!(
                        "export type {name} = {};\n\n",
                        ts_type_from_schema(def_schema, &definitions)
                    ));
                }
            }
        }

        for command in state.commands.values() {
            if command.input_type != "()" && emitted.insert(command.input_type.clone()) {
                set_codegen_command_context(&command.input_type);
                let description = command
                    .input_schema
                    .get("description")
                    .and_then(Value::as_str);
                output.push_str(&js_doc_for(&command.input_type, description));
                output.push_str(&format!(
                    "export type {} = {};\n\n",
                    command.input_type,
                    ts_type_from_schema(&command.input_schema, &definitions)
                ));
            }
            if command.output_type != "()" && emitted.insert(command.output_type.clone()) {
                set_codegen_command_context(&command.output_type);
                let description = command
                    .output_schema
                    .get("description")
                    .and_then(Value::as_str);
                output.push_str(&js_doc_for(&command.output_type, description));
                output.push_str(&format!(
                    "export type {} = {};\n\n",
                    command.output_type,
                    ts_type_from_schema(&command.output_schema, &definitions)
                ));
            }
        }

        output
    }
}

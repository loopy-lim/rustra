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
        if let Value::Object(def_map) = &definitions {
            for (name, def_schema) in def_map {
                if emitted.insert(name.clone()) {
                    if let Some(desc) = def_schema.get("description").and_then(Value::as_str) {
                        output.push_str(&format!("/**\n * {}\n */\n", desc.replace('\n', "\n * ")));
                    }
                    output.push_str(&format!(
                        "export type {name} = {};\n\n",
                        ts_type_from_schema(def_schema, &definitions)
                    ));
                }
            }
        }

        for command in state.commands.values() {
            if command.input_type != "()" && emitted.insert(command.input_type.clone()) {
                if let Some(desc) = command
                    .input_schema
                    .get("description")
                    .and_then(Value::as_str)
                {
                    output.push_str(&format!("/**\n * {}\n */\n", desc.replace('\n', "\n * ")));
                }
                output.push_str(&format!(
                    "export type {} = {};\n\n",
                    command.input_type,
                    ts_type_from_schema(&command.input_schema, &definitions)
                ));
            }
            if command.output_type != "()" && emitted.insert(command.output_type.clone()) {
                if let Some(desc) = command
                    .output_schema
                    .get("description")
                    .and_then(Value::as_str)
                {
                    output.push_str(&format!("/**\n * {}\n */\n", desc.replace('\n', "\n * ")));
                }
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

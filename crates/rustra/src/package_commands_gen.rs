impl Package {
    fn generate_commands_ts(state: &RegistryState) -> String {
        // Tauri-like 글로벌 invoke 패턴: `configure()`로 설정한 엔진을
        // `invoke()`가 사용하므로 명령 함수는 engine 파라미터를 받지 않는다.
        let mut type_names = BTreeSet::new();
        for command in state.commands.values() {
            if command.input_type != "()" {
                type_names.insert(command.input_type.clone());
            }
            if command.output_type != "()" {
                type_names.insert(command.output_type.clone());
            }
        }

        let imports = type_names.into_iter().collect::<Vec<_>>().join(", ");
        let mut output = String::new();
        if !imports.is_empty() {
            output.push_str(&format!("import type {{ {imports} }} from './types.js';\n"));
        }
        let mut generated_helpers = BTreeSet::new();
        generated_helpers.insert("invokeGenerated".to_string());
        for command in state.commands.values() {
            if generated_byte_field_name(&command.input_schema).is_some() {
                generated_helpers.insert("invokeGeneratedBytes".to_string());
            } else if let Some(fields) =
                generated_field_names(&command.input_schema, &command.definitions)
            {
                generated_helpers.insert(if fields.len() == 2 {
                    "createGeneratedFields2".to_string()
                } else {
                    format!("invokeGeneratedFields{}", fields.len())
                });
            }
        }
        output.push_str(&format!(
            "import {{ {} }} from '@rustra/types';\n",
            generated_helpers.into_iter().collect::<Vec<_>>().join(", ")
        ));
        output.push_str("import type { InvokeOptions } from '@rustra/types';\n\n");

        for (name, command) in state.commands.iter() {
            let out_type = if command.output_type == "()" {
                "void"
            } else {
                &command.output_type
            };
            set_codegen_command_context(name);
            if let Some(desc) = command.description.as_deref() {
                output.push_str(&format!("/**\n * {}\n */\n", desc.replace('\n', "\n * ")));
            }
            if command.input_type == "()" {
                output.push_str(&format!(
                    "export function {}(options?: InvokeOptions): Promise<{}> {{\n  return invokeGenerated<{}>({}, '{}', undefined, options);\n}}\n{}.commandId = '{}';\n\n",
                    command_function_name(name),
                    out_type,
                    out_type,
                    command.command_id,
                    name,
                    command_function_name(name),
                    name,
                ));
            } else if let Some(field) = generated_byte_field_name(&command.input_schema) {
                let literal = serde_json::to_string(&field)
                    .expect("JSON string serialization for a property name cannot fail");
                output.push_str(&format!(
                    "export function {}(input: {}, options?: InvokeOptions): Promise<{}> {{\n  return invokeGeneratedBytes<{}>({}, '{}', input, input[{}], options);\n}}\n{}.commandId = '{}';\n\n",
                    command_function_name(name),
                    command.input_type,
                    out_type,
                    out_type,
                    command.command_id,
                    name,
                    literal,
                    command_function_name(name),
                    name,
                ));
            } else if let Some(fields) =
                generated_field_names(&command.input_schema, &command.definitions)
            {
                if fields.len() == 2 {
                    let field_keys = fields
                        .iter()
                        .map(|field| {
                            serde_json::to_string(field)
                                .expect("JSON string serialization for a property name cannot fail")
                        })
                        .collect::<Vec<_>>()
                        .join(", ");
                    output.push_str(&format!(
                        "export const {} = createGeneratedFields2<{}, {}>({}, '{}', {}, '{}');\n\n",
                        command_function_name(name),
                        command.input_type,
                        out_type,
                        command.command_id,
                        name,
                        field_keys,
                        command_function_name(name),
                    ));
                    continue;
                }
                let field_args = fields
                    .iter()
                    .map(|field| {
                        let literal = serde_json::to_string(field)
                            .expect("JSON string serialization for a property name cannot fail");
                        format!("input[{literal}]")
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                output.push_str(&format!(
                    "export function {}(input: {}, options?: InvokeOptions): Promise<{}> {{\n  return invokeGeneratedFields{}<{}>({}, '{}', input, {}, options);\n}}\n{}.commandId = '{}';\n\n",
                    command_function_name(name),
                    command.input_type,
                    out_type,
                    fields.len(),
                    out_type,
                    command.command_id,
                    name,
                    field_args,
                    command_function_name(name),
                    name,
                ));
            } else {
                output.push_str(&format!(
                    "export function {}(input: {}, options?: InvokeOptions): Promise<{}> {{\n  return invokeGenerated<{}>({}, '{}', input, options);\n}}\n{}.commandId = '{}';\n\n",
                    command_function_name(name),
                    command.input_type,
                    out_type,
                    out_type,
                    command.command_id,
                    name,
                    command_function_name(name),
                    name,
                ));
            }
        }

        output
    }
}

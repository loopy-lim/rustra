impl Package {
    fn generate_commands_ts(state: &RegistryState) -> String {
        // Tauri-like 글로벌 invoke 패턴: `configure()`로 설정한 엔진을
        // `invoke()`가 사용하므로 명령 함수는 engine 파라미터를 받지 않는다.
        // ── (S1) Rust 내부 타입명 누출 정화 ──
        // 명령 루트가 schemars 내부명(`Tuple_of_int32_and_int32`, `int32`, …)이면
        // 시그니처에 이름 대신 스키마에서 렌더링한 인라인 타입을 쓴다. TS CLI
        // 렌더러(generate-commands.ts)와 동일 규칙 — 레거시 이름은 types_ts 의
        // deprecated alias 로 하위 호환이 유지된다.
        let mut all_definitions = serde_json::Map::new();
        for command in state.commands.values() {
            if let Value::Object(defs) = &*command.definitions {
                for (key, value) in defs {
                    all_definitions.insert(key.clone(), value.clone());
                }
            }
        }
        let definitions = Value::Object(all_definitions);

        // 인라인 렌더링이 참조하는 정의($ref) 까지 import 목록에 올린다.
        let mut type_names = BTreeSet::new();
        for command in state.commands.values() {
            for (type_name, schema) in [
                (&command.input_type, &command.input_schema),
                (&command.output_type, &command.output_schema),
            ] {
                if type_name == "()" {
                    continue;
                }
                if is_rust_internal_type_name(type_name) {
                    let mut refs = BTreeSet::new();
                    collect_ref_type_names(schema, &mut refs);
                    type_names.extend(refs);
                } else {
                    type_names.insert(type_name.clone());
                }
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
        // (M7) InvokeOptions 를 문서화된 별칭으로 재노출한다 — 생성 파일의 툴팁에서
        // 얕은 취소·retryable 경고가 바로 보인다. TS CLI 렌더러와 동일 바이트.
        output.push_str(
            "import type { InvokeOptions as CoreInvokeOptions } from '@rustra/types';\n\n",
        );
        output.push_str(INVOKE_OPTIONS_JS_DOC);
        output.push_str("export type InvokeOptions = CoreInvokeOptions;\n\n");

        // (S1) 규약 혼재 알림 — 두 규약이 함께 있을 때만 상단에 경고 주석을 붙인다.
        let has_positional = state.commands.values().any(|c| c.function_args.is_some());
        let has_structural = state.commands.values().any(|c| c.function_args.is_none());
        if has_positional && has_structural {
            output.push_str(MIXED_CONVENTION_NOTE);
            output.push('\n');
        }

        for (name, command) in state.commands.iter() {
            // unit 출력 `()` → Promise<void>. 내부명 출력은 인라인 타입으로 정화.
            let out_type = if command.output_type == "()" {
                "void".to_string()
            } else if is_rust_internal_type_name(&command.output_type) {
                ts_type_from_schema(&command.output_schema, &definitions)
            } else {
                command.output_type.clone()
            };
            // struct 기반 명령의 입력 타입도 내부명이면 인라인으로 정화한다.
            let in_type =
                if command.input_type != "()" && is_rust_internal_type_name(&command.input_type) {
                    ts_type_from_schema(&command.input_schema, &definitions)
                } else {
                    command.input_type.clone()
                };
            set_codegen_command_context(name);
            if let Some(desc) = command.description.as_deref() {
                output.push_str(&format!("/**\n * {}\n */\n", desc.replace('\n', "\n * ")));
            }
            if let Some(arity) = command.function_args {
                let args = (0..arity).map(|i| format!("arg{i}")).collect::<Vec<_>>();
                // (S1) positional 파라미터는 튜플 원소를 인라인으로 푼다 —
                // `Tuple_of_String[0]` 대신 `string`. arity≥1 이면 입력 스키마가
                // 길이 = arity 인 items 배열임이 계약이다(함수 등록 검증).
                let params = args
                    .iter()
                    .enumerate()
                    .map(|(i, arg)| {
                        let element = command
                            .input_schema
                            .get("items")
                            .and_then(Value::as_array)
                            .and_then(|items| items.get(i))
                            .map(|item| ts_type_from_schema(item, &definitions))
                            .unwrap_or_else(|| "unknown".to_string());
                        format!("{arg}: {element}")
                    })
                    .collect::<Vec<_>>();
                let params = [params, vec!["options?: InvokeOptions".to_string()]].concat();
                let payload = if arity == 0 {
                    "null".to_string()
                } else {
                    format!("[{}]", args.join(", "))
                };
                let normalize = if out_type == "void" {
                    ".then(() => undefined)"
                } else {
                    ""
                };
                let function_name = command_function_name(name);
                output.push_str(&format!("export function {function_name}({}): Promise<{out_type}> {{\n  return invokeGenerated<{out_type}>({}, '{name}', {payload}, options){normalize};\n}}\n{function_name}.commandId = '{name}';\n\n", params.join(", "), command.command_id));
                continue;
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
                    in_type,
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
                        in_type,
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
                    in_type,
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
                    in_type,
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

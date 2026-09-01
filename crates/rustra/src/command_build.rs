/// 계약 타입 이름 — unit만 예외로 역사적 센티널 `"()"` 을 유지한다.
///
/// unit의 schemars `schema_name()`은 `"Null"`이지만, schema.json의
/// inputType/outputType은 `"()"` 센티널로 고정돼 있다(CLI/코드젠 전 계층이
/// `!= "()"` 로 unit을 판별 — generate-commands.ts, generate-surface.ts,
/// package_commands_gen.rs 등). 센티널을 바꾸면 계약 해시·호환성이 깨지므로
/// 구체 타입만 `contract_type_name`으로 흘린다.
fn unit_or_contract_name<T>() -> String
where
    T: JsonSchema,
{
    const UNIT_SENTINEL: &str = "()";
    let candidate = contract_type_name::<T>();
    if candidate == "Null" {
        // schemars unit 이름 → unit 센티널. `Null`이라는 이름의 실제 사용자
        // 구조체와 충돌하는 경우(드묾)에도 센티널 쪽이 안전 — unit 경로는
        // 스키마가 `{"type":"null"}` 뿐이라 이름으로 지목할 대상이 없다.
        return UNIT_SENTINEL.to_owned();
    }
    candidate
}
pub(crate) fn build_command<I, O, F>(command_id: u16, handler: F) -> Command
where
    I: DeserializeOwned + JsonSchema + 'static,
    O: Serialize + JsonSchema + 'static,
    F: Fn(I) -> crate::Result<O> + Send + Sync + 'static,
{
    let (input_schema, input_defs) = schema_value::<I>();
    let (output_schema, output_defs) = schema_value::<O>();
    let mut definitions = input_defs;
    if let (Value::Object(obj), Value::Object(other)) = (&mut definitions, output_defs) {
        for (key, value) in other {
            obj.insert(key, value);
        }
    }
    let (postcard_decoder, _input_tier) = build_rkyv_v2_decoder(&input_schema);

    // Wrap handler in Arc so both JSON and binary paths can use it
    let handler = Arc::new(handler);

    // (Tier 3 정합) JS 코드젠(@rustra/cli)이 postcard 코덱을 생성하는 타입 집합과
    // 정합한다 — JS 쪽에서 미지원으로 레지스트리에서 제외된 명령(map 필드 등)은
    // 엔진이 Tier 3(JSON-in-binary) 로 라우팅한다. Rust 가 typed postcard 핸들러를
    // 그대로 켜두면 와이어가 어긋난다(JS 는 JSON 바이트를 보내고 Rust 는 postcard
    // 로 디코딩을 시도). 따라서 JS 코덱 지원 판정을 미러해 미지원 명령의
    // fast-path 를 끄고 JSON 경류(rkyv_v2_decode/encode_response — is_tier3 면
    // JSON-in-binary 프레임)로 통일한다.
    let js_codec_supported = js_postcard_codec_supported_with_defs(&input_schema, &definitions)
        && js_postcard_codec_supported_with_defs(&output_schema, &definitions);
    let complex_codec_supported = !js_codec_supported
        && complex_schema_supported(&input_schema, &definitions)
        && complex_schema_supported(&output_schema, &definitions);

    // Runtime-registered commands have no generated JS codec, so they retain
    // the JSON-in-binary contract. Static commands select the same route as
    // the TypeScript registry: postcard first, then the recursive complex
    // codec, and finally Tier 3 JSON only when neither binary route supports
    // the schema.
    let is_tier3 = !js_codec_supported && !complex_codec_supported;
    let rkyv_v2_decoder = if is_tier3 {
        build_tier3_json_decoder()
    } else {
        postcard_decoder
    };
    let rkyv_v2_response_encoder = build_rkyv_v2_response_encoder(&output_schema, is_tier3);

    let rkyv_v2_handler = build_rkyv_v2_handler::<I, O, F>(
        &input_schema,
        &output_schema,
        &definitions,
        &handler,
        js_codec_supported,
        complex_codec_supported,
    );
    let rkyv_v2_into_handler = build_rkyv_v2_into_handler::<I, O, F>(
        &input_schema,
        &output_schema,
        &definitions,
        &handler,
        js_codec_supported,
        complex_codec_supported,
    );

    // ── 스칼라 직결 raw 핸들러 ──
    // 조건: 입력이 스칼라 1..3개 + 출력이 단일 스칼라(또는 unit)인 정적 명령.
    // postcard 왕복 없이 u64 슬롯으로 직접 주고받는다. 필드 종류는 스키마의
    // 프로퍼티 선언순(fieldOrder=declaration 계약)에서 읽는다.
    let (raw_handler, raw_input_kinds) = build_raw_handler(&input_schema, &output_schema, &handler);

    Command {
        command_id,
        description: None,
        input_type: unit_or_contract_name::<I>(),
        output_type: unit_or_contract_name::<O>(),
        input_schema: Arc::new(input_schema),
        output_schema: Arc::new(output_schema),
        definitions: Arc::new(definitions),
        invoke: Arc::new(move |params| {
            let input = serde_json::from_value::<I>(params).map_err(RustraError::invalid_args)?;
            let output = handler(input)?;
            serde_json::to_value(output).map_err(RustraError::internal)
        }),
        rkyv_v2_handler,
        rkyv_v2_into_handler,
        raw_handler,
        buffer_handler: None,
        raw_input_kinds,
        rkyv_v2_decode: rkyv_v2_decoder,
        rkyv_v2_encode_response: rkyv_v2_response_encoder,
        rkyv_v2_tier3: is_tier3,
        required_capability: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::complex_codec::complex_codec_encode_object::complex_encode;
    use crate::{CompiledComplex, ComplexCodecLimits as Limits};
    use serde::Deserialize;
    use serde_json::json;
    use std::collections::BTreeMap;

    /// 호출당 컴파일 디코드 — 삭제된 `test_only_complex_decode` 대체. Value
    /// 경로와 동일 IR 순회를 쓰는 [`CompiledComplex`] 로 구동한다.
    fn decode_value_path(
        schema: &serde_json::Value,
        definitions: &serde_json::Value,
        bytes: &[u8],
        limits: Limits,
    ) -> Result<serde_json::Value> {
        CompiledComplex::new(schema, definitions).decode(bytes, limits)
    }

    fn limits() -> ComplexCodecLimits {
        ComplexCodecLimits {
            max_depth: 32,
            max_payload_bytes: 4096,
            max_collection_length: 1000,
        }
    }

    /// Status oneOf — struct 변형(newtype, UnwrapSingle)과 유닛 변형(EnumFirst).
    /// 스키마는 기존 와이어 테스트의 모양(기본 enum 태그)을 따른다.
    #[derive(Debug, PartialEq, serde::Serialize, Deserialize)]
    enum Status {
        Active { level: i64 },
        Idle,
    }

    #[derive(Debug, PartialEq, serde::Serialize, Deserialize)]
    struct Payload {
        status: Status,
    }

    #[test]
    fn round_trips_one_of_newtype_and_unit_variant() {
        let schema = json!({
            "type": "object",
            "properties": {
                "status": { "oneOf": [
                    {"type": "object", "properties": {"Active": {"type": "object", "properties": {"level": {"type": "integer"}}, "required": ["level"]}}, "required": ["Active"]},
                    {"type": "string", "enum": ["Idle"]}
                ]}
            },
            "required": ["status"]
        });
        let definitions = json!({});
        assert!(crate::complex_codec::complex_schema_supported(
            &schema,
            &definitions
        ));
        let ir = crate::complex_codec::complex_schema_ir::compile(&schema, &definitions).unwrap();
        assert!(serde_direct_supported(&ir));

        let active = Payload {
            status: Status::Active { level: 9 },
        };
        let idle = Payload {
            status: Status::Idle,
        };

        for input in [active, idle] {
            let value = serde_json::to_value(&input).unwrap();
            let expected = complex_encode(&schema, &definitions, &value, limits()).unwrap();
            let bytes = to_bytes(&input, &ir, limits()).unwrap();
            assert_eq!(bytes, expected, "encode mismatch for {value}");
            let back: Payload = from_bytes(&bytes, &ir, limits()).unwrap();
            assert_eq!(back, input);
            let value_back = decode_value_path(&schema, &definitions, &bytes, limits()).unwrap();
            assert_eq!(value, value_back);
        }

        // 잘못된 변형 인덱스 — Value 경로와 동일 에러.
        let bad: Result<Payload> = from_bytes(&[0x7f], &ir, limits());
        assert_eq!(
            bad.unwrap_err().to_string(),
            decode_value_path(&schema, &definitions, &[0x7f], limits())
                .unwrap_err()
                .to_string()
        );
    }

    #[derive(Debug, PartialEq, serde::Serialize, Deserialize)]
    struct Scores {
        scores: BTreeMap<String, Vec<i64>>,
    }

    #[test]
    fn map_bytes_match_value_path() {
        // map 경로 — 정렬된 키 기록이 Value 경로와 동일한지.
        let schema = json!({
            "type": "object",
            "properties": {"scores": {"type": "object", "additionalProperties": {"type": "array", "items": {"type": "integer", "format": "int64"}}}},
            "required": ["scores"]
        });
        let definitions = json!({});
        let ir = crate::complex_codec::complex_schema_ir::compile(&schema, &definitions).unwrap();

        let input = Scores {
            scores: BTreeMap::from([("z".into(), vec![1, -2, 300]), ("a".into(), vec![])]),
        };
        let value = serde_json::to_value(&input).unwrap();
        let expected = complex_encode(&schema, &definitions, &value, limits()).unwrap();
        let bytes = to_bytes(&input, &ir, limits()).unwrap();
        assert_eq!(bytes, expected);

        let back: Scores = from_bytes(&bytes, &ir, limits()).unwrap();
        assert_eq!(back, input);
        // Value 경로 디코드와 동일 값.
        let value_back = decode_value_path(&schema, &definitions, &bytes, limits()).unwrap();
        assert_eq!(serde_json::to_value(&back).unwrap(), value_back);
    }

    #[derive(Debug, PartialEq, serde::Serialize, Deserialize)]
    struct Node {
        value: i64,
        next: Option<Box<Node>>,
    }

    #[test]
    fn recursive_ref_option_round_trip() {
        let schema = json!({"$ref": "#/definitions/Node"});
        let definitions = json!({"Node": {"type": "object", "properties": {
            "value": {"type": "integer", "format": "int64"},
            "next": {"anyOf": [{"$ref": "#/definitions/Node"}, {"type": "null"}]}
        }, "required": ["value", "next"]}});
        let ir = crate::complex_codec::complex_schema_ir::compile(&schema, &definitions).unwrap();
        assert!(serde_direct_supported(&ir));

        let input = Node {
            value: 1,
            next: Some(Box::new(Node {
                value: -2,
                next: None,
            })),
        };
        let value = serde_json::to_value(&input).unwrap();
        let expected = complex_encode(&schema, &definitions, &value, limits()).unwrap();
        let bytes = to_bytes(&input, &ir, limits()).unwrap();
        assert_eq!(bytes, expected);
        let back: Node = from_bytes(&bytes, &ir, limits()).unwrap();
        assert_eq!(back, input);
    }

    #[test]
    fn absent_optional_field_matches_value_path() {
        let schema = json!({"type": "object", "properties": {
            "value": {"type": "integer", "format": "int64"},
            "label": {"type": "string"}
        }, "required": ["value"]});
        let definitions = json!({});
        let ir = crate::complex_codec::complex_schema_ir::compile(&schema, &definitions).unwrap();

        #[derive(Debug, PartialEq, serde::Serialize, Deserialize)]
        struct WithOption {
            value: i64,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            label: Option<String>,
        }
        let input = WithOption {
            value: 7,
            label: None,
        };
        let value = serde_json::to_value(&input).unwrap();
        let expected = complex_encode(&schema, &definitions, &value, limits()).unwrap();
        let bytes = to_bytes(&input, &ir, limits()).unwrap();
        assert_eq!(bytes, expected);
        let back: WithOption = from_bytes(&bytes, &ir, limits()).unwrap();
        assert_eq!(back, input);
    }

    #[test]
    fn integer_format_int32_round_trip() {
        let schema = json!({"type": "object", "properties": {
            "count": {"type": "integer", "format": "int32"}
        }, "required": ["count"]});
        let definitions = json!({});
        let ir = crate::complex_codec::complex_schema_ir::compile(&schema, &definitions).unwrap();

        #[derive(Debug, PartialEq, serde::Serialize, Deserialize)]
        struct Counting {
            count: i32,
        }
        let input = Counting { count: -5 };
        let value = serde_json::to_value(&input).unwrap();
        let expected = complex_encode(&schema, &definitions, &value, limits()).unwrap();
        let bytes = to_bytes(&input, &ir, limits()).unwrap();
        assert_eq!(bytes, expected);
        let back: Counting = from_bytes(&bytes, &ir, limits()).unwrap();
        assert_eq!(back, input);
    }
}

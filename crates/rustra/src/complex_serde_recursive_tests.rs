#[cfg(test)]
mod recursive_tests {
    use super::*;
    use crate::CompiledComplex;
    use serde::{Deserialize, Serialize};
    use serde_json::json;

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Node {
        value: i64,
        next: Option<Box<Node>>,
    }

    fn limits() -> ComplexCodecLimits {
        ComplexCodecLimits {
            max_depth: 32,
            max_payload_bytes: 4096,
            max_collection_length: 1000,
        }
    }

    fn codec() -> CompiledComplex {
        CompiledComplex::new(
            &json!({"$ref":"#/definitions/Node"}),
            &json!({
                "Node":{"type":"object","properties":{
                    "value":{"type":"integer"},
                    "next":{"anyOf":[{"$ref":"#/definitions/Node"},{"type":"null"}]}
                },"required":["value","next"]}
            }),
        )
    }

    fn input() -> Node {
        Node {
            value: 1,
            next: Some(Box::new(Node {
                value: -2,
                next: None,
            })),
        }
    }

    #[test]
    fn recursive_schema_enables_direct_codec() {
        assert!(codec().serde_direct());
    }

    #[test]
    fn recursive_direct_encode_matches_value_codec() {
        let codec = codec();
        let input = input();
        let limits = limits();
        let expected = codec
            .encode(&serde_json::to_value(&input).unwrap(), limits)
            .unwrap();
        assert_eq!(codec.encode_direct(&input, limits).unwrap(), expected);
    }

    #[test]
    fn recursive_direct_decode_matches_value_codec() {
        let codec = codec();
        let input = input();
        let limits = limits();
        let bytes = codec
            .encode(&serde_json::to_value(&input).unwrap(), limits)
            .unwrap();
        assert_eq!(codec.decode_direct::<Node>(&bytes, limits).unwrap(), input);
    }

    #[test]
    fn recursive_depth_limits_match_value_codec_at_every_boundary() {
        let codec = codec();
        let input = input();
        let value = serde_json::to_value(&input).unwrap();
        let bytes = codec.encode(&value, limits()).unwrap();
        for max_depth in 0..=6 {
            let limits = ComplexCodecLimits {
                max_depth,
                ..limits()
            };
            assert_eq!(
                codec
                    .encode_direct(&input, limits)
                    .map_err(|e| e.to_string()),
                codec.encode(&value, limits).map_err(|e| e.to_string()),
                "encode depth {max_depth}"
            );
            assert_eq!(
                codec
                    .decode_direct::<Node>(&bytes, limits)
                    .map(|n| serde_json::to_value(n).unwrap())
                    .map_err(|e| e.to_string()),
                codec.decode(&bytes, limits).map_err(|e| e.to_string()),
                "decode depth {max_depth}"
            );
        }
    }

    #[test]
    fn recursive_narrow_integer_rejects_overflow_like_value_codec() {
        #[derive(Debug, Deserialize)]
        #[allow(dead_code)]
        struct Tiny {
            value: i8,
            next: Option<Box<Tiny>>,
        }
        let codec = codec();
        let bytes = codec
            .encode(&json!({"value":300,"next":null}), limits())
            .unwrap();
        assert!(serde_json::from_value::<Tiny>(codec.decode(&bytes, limits()).unwrap()).is_err());
        assert!(codec.decode_direct::<Tiny>(&bytes, limits()).is_err());
    }

    #[test]
    fn recursive_unsigned_full_range_matches_value_codec() {
        #[derive(Debug, PartialEq, Serialize, Deserialize)]
        struct Unsigned {
            value: u64,
            next: Option<Box<Unsigned>>,
        }
        let codec = CompiledComplex::new(
            &json!({"$ref":"#/definitions/N"}),
            &json!({
                "N":{"type":"object","properties":{
                    "value":{"type":"integer","format":"uint64"},
                    "next":{"anyOf":[{"$ref":"#/definitions/N"},{"type":"null"}]}
                },"required":["value","next"]}
            }),
        );
        let input = Unsigned {
            value: u64::MAX,
            next: None,
        };
        let bytes = codec
            .encode(&serde_json::to_value(&input).unwrap(), limits())
            .unwrap();
        assert_eq!(codec.encode_direct(&input, limits()).unwrap(), bytes);
        assert_eq!(
            codec.decode_direct::<Unsigned>(&bytes, limits()).unwrap(),
            input
        );
    }

    fn derived_codec<T: schemars::JsonSchema>() -> CompiledComplex {
        let schema = serde_json::to_value(schemars::schema_for!(T)).unwrap();
        CompiledComplex::new(&schema, &schema["definitions"])
    }

    #[derive(Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
    enum Tree {
        Leaf {
            value: i64,
        },
        Children {
            children: Vec<Tree>,
            named: std::collections::BTreeMap<String, Tree>,
        },
    }

    #[test]
    fn recursive_enum_sequences_and_maps_match_value_at_depth_boundaries() {
        let codec = derived_codec::<Tree>();
        assert!(codec.serde_direct());
        let input = Tree::Children {
            children: vec![Tree::Leaf { value: 3 }],
            named: std::collections::BTreeMap::from([
                ("z".into(), Tree::Leaf { value: -2 }),
                (
                    "a".into(),
                    Tree::Children {
                        children: vec![],
                        named: Default::default(),
                    },
                ),
            ]),
        };
        let value = serde_json::to_value(&input).unwrap();
        let bytes = codec.encode(&value, limits()).unwrap();
        for max_depth in 0..=9 {
            let limits = ComplexCodecLimits {
                max_depth,
                ..limits()
            };
            assert_eq!(
                codec
                    .encode_direct(&input, limits)
                    .map_err(|e| e.to_string()),
                codec.encode(&value, limits).map_err(|e| e.to_string()),
                "encode depth {max_depth}"
            );
            assert_eq!(
                codec
                    .decode_direct::<Tree>(&bytes, limits)
                    .map(|n| serde_json::to_value(n).unwrap())
                    .map_err(|e| e.to_string()),
                codec.decode(&bytes, limits).map_err(|e| e.to_string()),
                "decode depth {max_depth}"
            );
        }
        let limits = ComplexCodecLimits {
            max_collection_length: 1,
            ..limits()
        };
        assert!(codec.encode_direct(&input, limits).is_err());
        assert!(codec.decode_direct::<Tree>(&bytes, limits).is_err());
    }

    #[derive(Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
    struct MutualA {
        b: Option<Box<MutualB>>,
    }
    #[derive(Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
    struct MutualB {
        siblings: Vec<MutualA>,
        scalar: f64,
    }

    #[test]
    fn mutual_recursion_round_trips_and_rejects_nonfinite_wire() {
        let codec = derived_codec::<MutualA>();
        assert!(codec.serde_direct());
        let input = MutualA {
            b: Some(Box::new(MutualB {
                siblings: vec![MutualA { b: None }],
                scalar: 1.5,
            })),
        };
        let value = serde_json::to_value(&input).unwrap();
        let bytes = codec.encode(&value, limits()).unwrap();
        assert_eq!(codec.encode_direct(&input, limits()).unwrap(), bytes);
        assert_eq!(
            codec.decode_direct::<MutualA>(&bytes, limits()).unwrap(),
            input
        );
        let mut bad = bytes;
        let start = bad.len() - 8;
        bad[start..].copy_from_slice(&f64::NAN.to_le_bytes());
        assert_eq!(
            codec
                .decode_direct::<MutualA>(&bad, limits())
                .unwrap_err()
                .to_string(),
            codec.decode(&bad, limits()).unwrap_err().to_string()
        );
    }

    include!("complex_serde_validation_tests.rs");
}

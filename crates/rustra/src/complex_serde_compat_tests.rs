#[cfg(test)]
mod compat_tests {
    use super::*;
    use crate::CompiledComplex;
    use serde::{Deserialize, Serialize};
    use std::collections::BTreeMap;

    fn limits() -> ComplexCodecLimits {
        ComplexCodecLimits {
            max_depth: 32,
            max_payload_bytes: 4096,
            max_collection_length: 1000,
        }
    }

    fn codec<T: schemars::JsonSchema>() -> CompiledComplex {
        let schema = serde_json::to_value(schemars::schema_for!(T)).unwrap();
        CompiledComplex::new(&schema, &schema["definitions"])
    }

    fn assert_json_round_trip<T>(input: &T)
    where
        T: Serialize + de::DeserializeOwned + schemars::JsonSchema,
    {
        let codec = codec::<T>();
        assert!(codec.serde_direct());
        let value = serde_json::to_value(input).unwrap();
        let bytes = codec.encode(&value, limits()).unwrap();
        assert_eq!(codec.encode_direct(input, limits()).unwrap(), bytes);
        let mut target = vec![0xcc; bytes.len()];
        assert_eq!(
            codec
                .encode_direct_into(input, &mut target, limits())
                .unwrap(),
            bytes.len()
        );
        assert_eq!(target, bytes);
        let expected: T = serde_json::from_value(codec.decode(&bytes, limits()).unwrap()).unwrap();
        let actual: T = codec.decode_direct(&bytes, limits()).unwrap();
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
    }

    #[test]
    fn recursive_unit_options_keep_json_null_semantics() {
        #[derive(Serialize, Deserialize, schemars::JsonSchema)]
        struct Node {
            empty: Option<()>,
            next: Option<Box<Node>>,
        }
        for empty in [None, Some(())] {
            assert_json_round_trip(&Node {
                empty,
                next: Some(Box::new(Node { empty, next: None })),
            });
        }
    }

    #[test]
    fn recursive_nested_options_keep_collapsed_json_semantics() {
        #[derive(Serialize, Deserialize, schemars::JsonSchema)]
        struct Node {
            value: Option<Option<i64>>,
            next: Option<Box<Node>>,
        }
        for value in [None, Some(None), Some(Some(17))] {
            assert_json_round_trip(&Node {
                value,
                next: Some(Box::new(Node { value, next: None })),
            });
        }
    }

    #[test]
    fn recursive_numeric_map_keys_match_json_object_keys() {
        #[derive(Serialize, Deserialize, schemars::JsonSchema)]
        struct Node {
            children: BTreeMap<u32, Node>,
        }
        assert_json_round_trip(&Node {
            children: BTreeMap::from([(
                17,
                Node {
                    children: BTreeMap::new(),
                },
            )]),
        });
    }

    #[test]
    fn recursive_flatten_keeps_value_serde_behavior() {
        #[derive(Serialize, Deserialize, schemars::JsonSchema)]
        struct Metadata {
            label: String,
        }
        #[derive(Serialize, Deserialize, schemars::JsonSchema)]
        struct Node {
            value: i64,
            #[serde(flatten)]
            metadata: Metadata,
            next: Option<Box<Node>>,
        }
        assert_json_round_trip(&Node {
            value: 17,
            metadata: Metadata {
                label: "root".into(),
            },
            next: Some(Box::new(Node {
                value: 2,
                metadata: Metadata {
                    label: "leaf".into(),
                },
                next: None,
            })),
        });
    }

    #[test]
    fn recursive_typed_const_stays_on_validating_value_path() {
        let codec = CompiledComplex::new(
            &serde_json::json!({"$ref":"#/definitions/Node"}),
            &serde_json::json!({"Node":{"type":"object","properties":{
                "value":{"type":"integer","const":5},
                "next":{"anyOf":[{"$ref":"#/definitions/Node"},{"type":"null"}]}
            },"required":["value","next"]}}),
        );
        assert!(
            !codec.serde_direct(),
            "typed const must not skip validation"
        );
        assert!(
            codec
                .encode(&serde_json::json!({"value":7,"next":null}), limits())
                .unwrap_err()
                .to_string()
                .contains("value does not match const")
        );
    }

    #[test]
    fn recursive_compatibility_fallback_restarts_buffer_without_rerunning_handler() {
        #[derive(Serialize, Deserialize, schemars::JsonSchema)]
        struct Node {
            value: i64,
            empty: Option<()>,
            next: Option<Box<Node>>,
        }
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let package = crate::Package::builder("test.recursive-compatibility")
            .command("echo", move |input: Node| {
                counted.fetch_add(1, Ordering::SeqCst);
                Ok(input)
            })
            .build();
        let input = Node {
            value: 21,
            empty: None,
            next: Some(Box::new(Node {
                value: 3,
                empty: Some(()),
                next: None,
            })),
        };
        let body = codec::<Node>()
            .encode(&serde_json::to_value(input).unwrap(), limits())
            .unwrap();
        let mut request = 1u16.to_le_bytes().to_vec();
        request.extend_from_slice(&body);
        for (index, capacity) in [body.len() + 8, 9].into_iter().enumerate() {
            let mut target = vec![0xcc; capacity];
            let response = match package.invoke_frame_into(&request, &mut target).unwrap() {
                crate::DirectResponse::Written(written) => {
                    assert_eq!(index, 0);
                    target[..written].to_vec()
                }
                crate::DirectResponse::Buffered(response) => {
                    assert_eq!(index, 1);
                    response
                }
            };
            assert_eq!(response[0], 1);
            assert_eq!(&response[8..], body);
            assert_eq!(calls.load(Ordering::SeqCst), index + 1);
        }
    }

    #[test]
    fn recursive_other_json_key_types_keep_value_fallback() {
        #[derive(Serialize, Deserialize, schemars::JsonSchema)]
        struct Node<K: Ord> {
            children: BTreeMap<K, Node<K>>,
        }
        fn check<K: Ord + Serialize + de::DeserializeOwned + schemars::JsonSchema>(key: K) {
            assert_json_round_trip(&Node {
                children: BTreeMap::from([(
                    key,
                    Node {
                        children: BTreeMap::new(),
                    },
                )]),
            });
        }
        #[derive(Ord, PartialOrd, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
        enum Key {
            Named,
        }
        check(true);
        check('가');
        check(Key::Named);
        check(u128::MAX);
    }

    #[test]
    fn recursive_fallback_preserves_serde_error_and_payload_limit_contracts() {
        #[derive(Serialize, Deserialize, schemars::JsonSchema)]
        struct Node {
            children: BTreeMap<u32, Node>,
        }
        let codec = codec::<Node>();
        let value = serde_json::json!({"children":{"invalid":{"children":{}}}});
        let bytes = codec.encode(&value, limits()).unwrap();
        let expected = serde_json::from_value::<Node>(value).err().unwrap();
        assert_eq!(
            codec.decode_direct::<Node>(&bytes, limits()).err().unwrap(),
            crate::RustraError::invalid_args(format!("complex decode: {expected}"))
        );
        let input = Node {
            children: BTreeMap::from([(
                17,
                Node {
                    children: BTreeMap::new(),
                },
            )]),
        };
        let value = serde_json::to_value(&input).unwrap();
        for max_payload_bytes in 0..=4 {
            let limits = ComplexCodecLimits {
                max_payload_bytes,
                ..limits()
            };
            assert_eq!(
                codec.encode_direct(&input, limits),
                codec.encode(&value, limits)
            );
            let mut target = [0xcc; 16];
            let mut expected = [0xcc; 16];
            assert_eq!(
                codec.encode_direct_into(&input, &mut target, limits),
                codec.encode_into(&value, &mut expected, limits)
            );
        }
    }
}

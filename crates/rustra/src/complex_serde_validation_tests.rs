#[test]
fn recursive_payload_limits_and_malformed_inputs_match_value_codec() {
    let codec = codec();
    let input = input();
    let value = serde_json::to_value(&input).unwrap();
    let bytes = codec.encode(&value, limits()).unwrap();
    for size in 0..=bytes.len() {
        let limit = ComplexCodecLimits {
            max_payload_bytes: size,
            ..limits()
        };
        assert_eq!(
            codec
                .encode_direct(&input, limit)
                .map_err(|e| e.to_string()),
            codec.encode(&value, limit).map_err(|e| e.to_string())
        );
        assert_eq!(
            codec
                .decode_direct::<Node>(&bytes, limit)
                .map(|n| serde_json::to_value(n).unwrap())
                .map_err(|e| e.to_string()),
            codec.decode(&bytes, limit).map_err(|e| e.to_string())
        );
        let mut target = vec![0; size];
        if size < bytes.len() {
            assert!(
                codec
                    .encode_direct_into(&input, &mut target, limits())
                    .unwrap_err()
                    .to_string()
                    .contains("caller buffer overflow")
            );
        } else {
            assert_eq!(
                codec
                    .encode_direct_into(&input, &mut target, limits())
                    .unwrap(),
                bytes.len()
            );
            assert_eq!(target, bytes);
        }
    }
    let mut malformed: Vec<Vec<u8>> = (0..bytes.len())
        .map(|size| bytes[..size].to_vec())
        .collect();
    malformed.push([bytes.clone(), vec![0]].concat());
    malformed.push(vec![2, 7]); // invalid option tag
    malformed.push(vec![0xff; 11]); // overflowing varint
    for bad in malformed {
        assert_eq!(
            codec
                .decode_direct::<Node>(&bad, limits())
                .unwrap_err()
                .to_string(),
            codec.decode(&bad, limits()).unwrap_err().to_string()
        );
    }
}

#[test]
fn optional_fields_preserve_omitted_none_some_and_renamed_wire() {
    #[derive(Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
    struct Optional {
        #[serde(skip_serializing_if = "Option::is_none")]
        skipped: Option<String>,
        #[serde(rename = "wireName")]
        label: Option<String>,
        tail: i64,
    }
    let codec = derived_codec::<Optional>();
    for skipped in [None, Some("first".into())] {
        for label in [None, Some("present".into())] {
            let input = Optional {
                skipped: skipped.clone(),
                label,
                tail: 17,
            };
            let value = serde_json::to_value(&input).unwrap();
            let bytes = codec.encode(&value, limits()).unwrap();
            assert_eq!(codec.encode_direct(&input, limits()).unwrap(), bytes);
            assert_eq!(
                codec.decode_direct::<Optional>(&bytes, limits()).unwrap(),
                input
            );
        }
    }
}

#[test]
fn recursive_map_rejects_duplicate_keys_but_accepts_unsorted_keys() {
    #[derive(Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
    struct MapNode {
        children: std::collections::BTreeMap<String, MapNode>,
    }
    let codec = derived_codec::<MapNode>();
    let bad = [2, 1, b'x', 0, 1, b'x', 0];
    assert_eq!(
        codec
            .decode_direct::<MapNode>(&bad, limits())
            .unwrap_err()
            .to_string(),
        codec.decode(&bad, limits()).unwrap_err().to_string()
    );
    let valid = [2, 1, b'z', 0, 1, b'a', 0];
    assert_eq!(
        serde_json::to_value(codec.decode_direct::<MapNode>(&valid, limits()).unwrap()).unwrap(),
        codec.decode(&valid, limits()).unwrap()
    );
}

#[test]
fn unsupported_recursive_variants_and_alias_cycles_keep_fallback() {
    #[derive(schemars::JsonSchema)]
    #[serde(tag = "kind")]
    #[allow(dead_code)]
    enum Tagged {
        Leaf,
        Next { node: Box<Tagged> },
    }
    assert!(!derived_codec::<Tagged>().serde_direct());
    let codec = CompiledComplex::new(
        &json!({"$ref":"#/definitions/Loop"}),
        &json!({"Loop":{"$ref":"#/definitions/Loop"}}),
    );
    assert!(!codec.serde_direct());
}

#[derive(Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
enum TupleTree {
    Empty,
    Pair(Box<TupleTree>, [i64; 2]),
}

#[test]
fn recursive_tuple_variant_and_fixed_array_match_value_codec() {
    let codec = derived_codec::<TupleTree>();
    assert!(codec.serde_direct());
    let input = TupleTree::Pair(
        Box::new(TupleTree::Pair(Box::new(TupleTree::Empty), [2, 3])),
        [4, 5],
    );
    let value = serde_json::to_value(&input).unwrap();
    let bytes = codec.encode(&value, limits()).unwrap();
    assert_eq!(codec.encode_direct(&input, limits()).unwrap(), bytes);
    assert_eq!(
        codec.decode_direct::<TupleTree>(&bytes, limits()).unwrap(),
        input
    );
    for max_depth in 0..=8 {
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
                .decode_direct::<TupleTree>(&bytes, limits)
                .map(|n| serde_json::to_value(n).unwrap())
                .map_err(|e| e.to_string()),
            codec.decode(&bytes, limits).map_err(|e| e.to_string()),
            "decode depth {max_depth}"
        );
    }
}

#[test]
fn sequence_reservation_hint_is_capped_by_unread_payload() {
    let limits = ComplexCodecLimits {
        max_collection_length: 100_000,
        ..limits()
    };
    let targets = RecursiveTargets::default();
    let ir = IrNode::Int { unsigned: false };
    let mut reader = Reader::new(&[2, 4, 6], limits).unwrap();
    let de = De {
        reader: &mut reader,
        targets: &targets,
        ir: &ir,
        limits,
        depth: 0,
    };
    let seq = DeSeq {
        de,
        tuple: None,
        items: Some(&ir),
        position: 0,
        length: 100_000,
    };
    assert_eq!(seq.size_hint(), Some(3));
}

#[test]
fn recursive_default_fields_and_char_match_value_codec() {
    #[derive(Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
    struct Defaults {
        #[serde(default)]
        count: i64,
        letter: char,
        next: Option<Box<Defaults>>,
    }
    let codec = derived_codec::<Defaults>();
    let value = json!({"letter":"가", "next":null});
    let bytes = codec.encode(&value, limits()).unwrap();
    let expected: Defaults =
        serde_json::from_value(codec.decode(&bytes, limits()).unwrap()).unwrap();
    assert_eq!(
        codec.decode_direct::<Defaults>(&bytes, limits()).unwrap(),
        expected
    );
    let input = Defaults {
        count: 5,
        letter: 'λ',
        next: Some(Box::new(expected)),
    };
    assert_eq!(
        codec.encode_direct(&input, limits()).unwrap(),
        codec
            .encode(&serde_json::to_value(&input).unwrap(), limits())
            .unwrap()
    );
}

#[test]
fn empty_recursive_struct_variant_obeys_body_depth_limit() {
    #[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
    enum EmptyTree {
        Empty {},
        Next(Box<EmptyTree>),
    }
    let codec = derived_codec::<EmptyTree>();
    let input = EmptyTree::Empty {};
    let limits = ComplexCodecLimits {
        max_depth: 0,
        ..limits()
    };
    assert_eq!(
        codec
            .encode_direct(&input, limits)
            .map_err(|e| e.to_string()),
        codec
            .encode(&serde_json::to_value(&input).unwrap(), limits)
            .map_err(|e| e.to_string())
    );
}

#[test]
fn recursive_128_bit_fields_preserve_json_integer_domain() {
    #[derive(Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
    struct Wide {
        signed: i128,
        unsigned: u128,
        next: Option<Box<Wide>>,
    }
    let codec = derived_codec::<Wide>();
    let input = Wide {
        signed: i64::MIN.into(),
        unsigned: u64::MAX.into(),
        next: None,
    };
    let value = serde_json::to_value(&input).unwrap();
    let bytes = codec.encode(&value, limits()).unwrap();
    assert_eq!(codec.encode_direct(&input, limits()).unwrap(), bytes);
    assert_eq!(
        codec.decode_direct::<Wide>(&bytes, limits()).unwrap(),
        input
    );
    let overflow = Wide {
        signed: i128::MAX,
        unsigned: u128::MAX,
        next: None,
    };
    assert!(serde_json::to_value(&overflow).is_err());
    assert!(codec.encode_direct(&overflow, limits()).is_err());
}

#[test]
fn two_key_direct_map_rejects_duplicate_and_accepts_unsorted_distinct_keys() {
    use std::collections::BTreeMap;
    let codec = CompiledComplex::new(
        &json!({"type":"object", "additionalProperties":{"type":"integer"}}),
        &json!({}),
    );
    assert!(codec.serde_direct());
    let duplicate = [2, 1, b'x', 2, 1, b'x', 4];
    assert_eq!(
        codec
            .decode_direct::<BTreeMap<String, i64>>(&duplicate, limits())
            .unwrap_err(),
        codec.decode(&duplicate, limits()).unwrap_err()
    );
    let distinct = [2, 1, b'z', 2, 1, b'a', 4];
    let decoded = codec
        .decode_direct::<BTreeMap<String, i64>>(&distinct, limits())
        .unwrap();
    assert_eq!(decoded, BTreeMap::from([("a".into(), 2), ("z".into(), 1)]));
    assert_eq!(
        serde_json::to_value(decoded).unwrap(),
        codec.decode(&distinct, limits()).unwrap()
    );
}

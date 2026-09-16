#[cfg(test)]
mod pair_tests {
    use super::*;
    use crate::{CompiledComplex, DirectResponse, Package};
    use serde::{Deserialize, Serialize};
    use std::{
        collections::BTreeMap,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };

    #[derive(Serialize, Deserialize, schemars::JsonSchema)]
    struct Node {
        value: i64,
        next: Option<Box<Node>>,
    }

    #[derive(Serialize, Deserialize, schemars::JsonSchema)]
    struct Metadata {
        value: i64,
    }

    #[derive(Serialize, Deserialize, schemars::JsonSchema)]
    struct Flat {
        #[serde(flatten)]
        metadata: Metadata,
    }

    fn encoded<T: Serialize + schemars::JsonSchema>(value: &T) -> Vec<u8> {
        let schema = serde_json::to_value(schemars::schema_for!(T)).unwrap();
        CompiledComplex::new(&schema, &schema["definitions"])
            .encode(
                &serde_json::to_value(value).unwrap(),
                ComplexCodecLimits::DEFAULT,
            )
            .unwrap()
    }

    fn assert_paths(
        package: Package,
        input: Vec<u8>,
        expected: Vec<u8>,
        calls: Arc<AtomicUsize>,
        into: bool,
    ) {
        let mut request = 1u16.to_le_bytes().to_vec();
        request.extend_from_slice(&input);
        if !into {
            let response = package.invoke_frame(&request).unwrap();
            assert_eq!(response[0], 1);
            assert_eq!(&response[8..], expected);
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            return;
        }
        for (index, capacity) in [8 + expected.len(), 9].into_iter().enumerate() {
            let mut target = vec![0xcc; capacity];
            let response = match package.invoke_frame_into(&request, &mut target).unwrap() {
                DirectResponse::Written(written) => {
                    assert_eq!(index, 0);
                    target[..written].to_vec()
                }
                DirectResponse::Buffered(response) => {
                    assert_eq!(index, 1);
                    response
                }
            };
            assert_eq!(response[0], 1);
            assert_eq!(&response[8..], expected);
            assert_eq!(calls.load(Ordering::SeqCst), index + 1);
        }
    }

    fn recursive_input_numeric_map_output(into: bool) {
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let package = Package::builder("test.recursive-input-map-output")
            .command("convert", move |input: Node| {
                counted.fetch_add(1, Ordering::SeqCst);
                Ok(BTreeMap::from([(2u32, input.value), (10, 99)]))
            })
            .build();
        let input = Node {
            value: 21,
            next: Some(Box::new(Node {
                value: 5,
                next: None,
            })),
        };
        assert_paths(
            package,
            encoded(&input),
            encoded(&BTreeMap::from([(2u32, 21i64), (10, 99)])),
            calls,
            into,
        );
    }

    fn flat_input_recursive_output(into: bool) {
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let package = Package::builder("test.flat-input-recursive-output")
            .command("convert", move |input: Flat| {
                counted.fetch_add(1, Ordering::SeqCst);
                Ok(Node {
                    value: input.metadata.value,
                    next: Some(Box::new(Node {
                        value: 5,
                        next: None,
                    })),
                })
            })
            .build();
        let input = Flat {
            metadata: Metadata { value: 21 },
        };
        let output = Node {
            value: 21,
            next: Some(Box::new(Node {
                value: 5,
                next: None,
            })),
        };
        assert_paths(package, encoded(&input), encoded(&output), calls, into);
    }

    #[test]
    fn recursive_input_preserves_nonrecursive_output_owned() {
        recursive_input_numeric_map_output(false);
    }
    #[test]
    fn recursive_input_preserves_nonrecursive_output_into_once() {
        recursive_input_numeric_map_output(true);
    }
    #[test]
    fn recursive_output_preserves_nonrecursive_input_owned() {
        flat_input_recursive_output(false);
    }
    #[test]
    fn recursive_output_preserves_nonrecursive_input_into_once() {
        flat_input_recursive_output(true);
    }

    #[test]
    fn all_nonrecursive_pairs_keep_existing_direct_error_policy() {
        let input_schema = serde_json::to_value(schemars::schema_for!(Flat)).unwrap();
        let output_schema =
            serde_json::to_value(schemars::schema_for!(BTreeMap<u32, i64>)).unwrap();
        let (input, output) =
            CompiledComplex::pair(&input_schema, &output_schema, &serde_json::json!({}));
        assert!(input.serde_direct() && output.serde_direct());
        let bytes = encoded(&Flat {
            metadata: Metadata { value: 21 },
        });
        assert!(
            input
                .decode_direct::<Flat>(&bytes, ComplexCodecLimits::DEFAULT)
                .is_err()
        );
        let value = BTreeMap::from([(17u32, 21i64)]);
        assert!(
            output
                .encode_direct(&value, ComplexCodecLimits::DEFAULT)
                .is_err()
        );
    }
}

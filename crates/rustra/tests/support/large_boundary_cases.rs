//! Shared deterministic boundary cases and mutation entry for the large fuzz campaign.
use rustra::Package;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

const LIMIT: usize = 1024 * 1024;
const LENGTHS: [usize; 8] = [0, 127, 128, 65_535, 65_536, LIMIT - 5, LIMIT - 4, LIMIT + 1];
const DEPTHS: [usize; 8] = [1, 8, 16, 31, 32, 33, 64, 128];

#[derive(Serialize, Deserialize, JsonSchema)]
struct Bytes {
    data: Vec<u8>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
struct Node {
    value: i16,
    next: Option<Box<Node>>,
}

fn bytes_package() -> &'static Package {
    static PACKAGE: OnceLock<Package> = OnceLock::new();
    PACKAGE.get_or_init(|| {
        Package::builder("fuzz.large.bytes")
            // Keep the response small: this campaign distinguishes the input
            // limit from the independent encoded-response-size limit.
            .command("echo", |value: Bytes| {
                Ok::<_, rustra::RustraError>(value.data.len() as u32)
            })
            .build()
    })
}

fn recursive_package() -> &'static Package {
    static PACKAGE: OnceLock<Package> = OnceLock::new();
    PACKAGE.get_or_init(|| {
        Package::builder("fuzz.large.recursive")
            .command("echo", |value: Node| Ok::<_, rustra::RustraError>(value))
            .build()
    })
}

fn deny_hidden_panic<T>(result: &rustra::Result<T>) {
    if let Err(error) = result {
        assert!(
            !error.message().contains("panic"),
            "decoder panic was normalized: {error}"
        );
    }
}

fn varint(mut value: usize, out: &mut Vec<u8>) {
    while value >= 128 {
        out.push((value as u8 & 127) | 128);
        value >>= 7;
    }
    out.push(value as u8);
}

pub fn exercise(data: &[u8]) {
    let mode = data.first().copied().unwrap_or(0) % 3;
    let selector = usize::from(data.get(1).copied().unwrap_or(0)) % 8;
    match mode {
        0 => {
            let len = LENGTHS[selector];
            let mut frame = vec![1, 0];
            varint(len, &mut frame);
            frame.resize(frame.len() + len, data.get(2).copied().unwrap_or(42));
            let result = bytes_package().invoke_frame(&frame);
            deny_hidden_panic(&result);
            if frame.len() > LIMIT {
                assert_eq!(result.unwrap_err().code(), "payload.too_large");
            } else {
                let response = result.expect("valid bytes at or below the limit must succeed");
                assert_eq!(response[0], 1);
                let mut expected = Vec::new();
                varint(len, &mut expected);
                assert_eq!(&response[8..], expected, "large input length changed");
            }
        }
        1 => {
            // Keep a valid command ID so large malformed inputs reach the
            // decoder instead of almost always stopping at unknown-command.
            let mut raw = data[..data.len().min(LIMIT + 1)].to_vec();
            raw.resize(raw.len().max(2), 0);
            raw[..2].copy_from_slice(&[1, 0]);
            let result = bytes_package().invoke_frame(&raw);
            deny_hidden_panic(&result);
            if raw.len() > LIMIT {
                assert_eq!(result.unwrap_err().code(), "payload.too_large");
            }
            let mut short = [0; 64];
            deny_hidden_panic(&bytes_package().invoke_frame_into(&raw, &mut short));
        }
        _ => {
            let depth = DEPTHS[selector];
            let mut frame = vec![1, 0];
            for node in 0..depth {
                // value=0, optional field present, then Option discriminant.
                frame.extend_from_slice(&[0, 1, u8::from(node + 1 < depth)]);
            }
            let result = recursive_package().invoke_frame(&frame);
            deny_hidden_panic(&result);
            if depth <= 8 {
                let response = result.expect("known shallow recursive shape must decode");
                assert_eq!(&response[8..], &frame[2..]);
            } else if depth >= 64 {
                assert!(result.is_err(), "excessive recursion must be rejected");
            }
            // Mutate a discriminant/value while retaining the chosen deep shape.
            if let Some(&mutation) = data.get(2) {
                frame[4] = mutation;
                deny_hidden_panic(&recursive_package().invoke_frame(&frame));
            }
        }
    }
}

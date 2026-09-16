use rustra::Package;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[path = "../common.rs"]
mod common;

// ── data enum(oneOf) complex 라우트 ─────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Active { level: i64 },
    Idle,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OneOfIn {
    pub status: Status,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OneOfOut {
    pub status: Status,
}

pub fn oneof_echo(input: OneOfIn) -> rustra::Result<OneOfOut> {
    Ok(OneOfOut {
        status: input.status,
    })
}

// ── map 복합 타입 complex 라우트 ────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GroupsIn {
    pub groups: std::collections::BTreeMap<String, Vec<i64>>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GroupsOut {
    pub groups: std::collections::BTreeMap<String, Vec<i64>>,
}

pub fn groups_echo(input: GroupsIn) -> rustra::Result<GroupsOut> {
    Ok(GroupsOut {
        groups: input.groups,
    })
}

// ── recursive $ref complex route ──────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChainNode {
    pub value: i64,
    pub next: Option<Box<ChainNode>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RecursiveIn {
    pub root: ChainNode,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RecursiveOut {
    pub root: ChainNode,
}

pub fn recursive_echo(input: RecursiveIn) -> rustra::Result<RecursiveOut> {
    Ok(RecursiveOut { root: input.root })
}

fn push_uvar(mut value: u64, output: &mut Vec<u8>) {
    while value >= 0x80 {
        output.push((value as u8) | 0x80);
        value >>= 7;
    }
    output.push(value as u8);
}

/// Positive `i64` values 1..=depth followed by an optional next pointer.
/// `next` has both a non-required struct-field tag and an Option tag, so each
/// node is `[zigzag(value)][field-present=1][next-present]`.
fn recursive_request(command_id: u16, depth: usize) -> Vec<u8> {
    assert!(depth > 0);
    let mut request = Vec::with_capacity(2 + depth * 3);
    request.extend_from_slice(&command_id.to_le_bytes());
    for value in 1..=depth {
        push_uvar((value as u64) << 1, &mut request);
        request.push(1);
        request.push(u8::from(value < depth));
    }
    request
}

// Status forces the complex route even for otherwise postcard-compatible fields.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct OptionalText {
    pub status: Status,
    pub text: Option<String>,
}
pub fn optional_echo(input: OptionalText) -> rustra::Result<OptionalText> {
    Ok(input)
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct OptionalChunks {
    pub status: Status,
    pub chunks: Option<Vec<String>>,
}
pub fn chunks_echo(input: OptionalChunks) -> rustra::Result<OptionalChunks> {
    Ok(input)
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct WideFields {
    pub status: Status,
    pub f00: i64,
    pub f01: i64,
    pub f02: i64,
    pub f03: i64,
    pub f04: i64,
    pub f05: i64,
    pub f06: i64,
    pub f07: i64,
    pub f08: i64,
    pub f09: i64,
    pub f10: i64,
    pub f11: i64,
    pub f12: i64,
    pub f13: i64,
    pub f14: i64,
    pub f15: i64,
    pub f16: i64,
    pub f17: i64,
    pub f18: i64,
    pub f19: i64,
    pub f20: i64,
    pub f21: i64,
    pub f22: i64,
    pub f23: i64,
    pub f24: i64,
    pub f25: i64,
    pub f26: i64,
    pub f27: i64,
    pub f28: i64,
    pub f29: i64,
    pub f30: i64,
    pub f31: i64,
}
pub fn wide_echo(input: WideFields) -> rustra::Result<WideFields> {
    Ok(input)
}

pub struct Case {
    pub name: &'static str,
    pub request: Vec<u8>,
}

/// Shared by Criterion and allocation sampling, including wire assertions before measurement.
pub fn fixtures() -> (Package, Vec<Case>) {
    let pkg = Package::builder("bench.complex_route")
        .command("oneofEcho", oneof_echo)
        .command("groupsEcho", groups_echo)
        .command("recursiveEcho", recursive_echo)
        .command("optionalEcho", optional_echo)
        .command("chunksEcho", chunks_echo)
        .command("wideEcho", wide_echo)
        .command("add", common::add)
        .build();
    let request = |name: &str, body: &[u8]| {
        let mut frame = common::command_id_of(&pkg, name).to_le_bytes().to_vec();
        frame.extend_from_slice(body);
        frame
    };
    let mut cases = vec![
        Case {
            name: "oneof_data_enum",
            request: request("oneofEcho", &[0, 14]),
        },
        Case {
            name: "map_of_seqs",
            request: request("groupsEcho", &[1, 1, b'g', 2, 84, 86]),
        },
    ];
    let mut many = vec![1, 1, b'g'];
    push_uvar(1024, &mut many);
    for value in 0..1024 {
        push_uvar(value << 1, &mut many);
    }
    cases.push(Case {
        name: "map_seq_1024",
        request: request("groupsEcho", &many),
    });
    for (name, count) in [("map_keys_2", 2u64), ("map_keys_64", 64)] {
        let mut body = Vec::new();
        push_uvar(count, &mut body);
        for index in 0..count {
            let key = format!("k{index:02}");
            push_uvar(key.len() as u64, &mut body);
            body.extend_from_slice(key.as_bytes());
            body.push(1); // one integer per map value
            push_uvar(index << 1, &mut body);
        }
        cases.push(Case {
            name,
            request: request("groupsEcho", &body),
        });
    }
    let recursive_id = common::command_id_of(&pkg, "recursiveEcho");
    for (name, depth) in [
        ("recursive_depth_1", 1),
        ("recursive_depth_8", 8),
        ("recursive_depth_16", 16),
    ] {
        cases.push(Case {
            name,
            request: recursive_request(recursive_id, depth),
        });
    }
    for (name, length) in [("optional_string_64", 64), ("optional_string_64k", 65536)] {
        // idle variant + field present + Some + string length + UTF-8 bytes.
        let mut body = vec![1, 1, 1];
        push_uvar(length, &mut body);
        body.resize(body.len() + length as usize, b'x');
        cases.push(Case {
            name,
            request: request("optionalEcho", &body),
        });
    }
    // Strings share the collection limit (100,000); split the near-1MiB payload
    // into 16 chunks instead of relaxing production limits for the benchmark.
    let mut chunks = vec![1, 1, 1, 16];
    for _ in 0..16 {
        push_uvar(65528, &mut chunks);
        chunks.resize(chunks.len() + 65528, b'x');
    }
    cases.push(Case {
        name: "optional_chunks_near_1m",
        request: request("chunksEcho", &chunks),
    });
    cases.push(Case {
        name: "optional_none",
        request: request("optionalEcho", &[1, 1, 0]),
    });
    let mut wide = vec![1];
    for value in 0..32 {
        push_uvar(value << 1, &mut wide);
    }
    cases.push(Case {
        name: "wide_struct_32",
        request: request("wideEcho", &wide),
    });
    for case in &cases {
        let response = pkg
            .invoke_frame(&case.request)
            .unwrap_or_else(|err| panic!("{}: {err}", case.name));
        assert_eq!(response[0], 1, "{} must succeed", case.name);
        assert_eq!(
            &response[8..],
            &case.request[2..],
            "{} echo body",
            case.name
        );
    }
    let add = common::postcard_request(
        common::command_id_of(&pkg, "add"),
        &common::AddInput { a: 3, b: 4 },
    );
    let response = pkg.invoke_frame(&add).expect("scalar invoke must succeed");
    assert_eq!(response[0], 1);
    let output: common::AddOutput = common::decode_postcard_response(&response);
    assert_eq!(output.value, 7);
    cases.push(Case {
        name: "scalar_control",
        request: add,
    });
    (pkg, cases)
}

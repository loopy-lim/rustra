#![allow(dead_code)]
//! 벤치/테스트가 공유하는 픽스처 타입과 wire 헬퍼.
//!
//! 각 criterion benchbinary 에서 `#[path = "common.rs"] mod common;` 로 포함한다.
//! dynamic(Tier 3) 경로는 런타임 `register` 로만 도달 가능하며, release 빌드에선
//! 패키지가 frozen 이므로 막힌다 → dynamic 경로 벤치는 `cargo bench -p rustra --profile dev`
//! (debug) 로 실행해야 한다. dynamic 명령은 설계상 dev-only 이므로 이것이 정확한 환경이다.

use rustra::Package;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ── Tier 1 (primitive 고정폭) ──────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AddInput {
    pub a: i64,
    pub b: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AddOutput {
    pub value: i64,
}

pub fn add(input: AddInput) -> rustra::Result<AddOutput> {
    Ok(AddOutput {
        value: input.a + input.b,
    })
}

// ── Tier 2 (String / Vec<primitive>) ───────────────────────
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GreetInput {
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GreetOutput {
    pub message: String,
}

pub fn greet(input: GreetInput) -> rustra::Result<GreetOutput> {
    Ok(GreetOutput {
        message: format!("hello {name}", name = input.name),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SumListInput {
    pub numbers: Vec<i64>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SumListOutput {
    pub sum: i64,
    pub count: i64,
}

pub fn sum_list(input: SumListInput) -> rustra::Result<SumListOutput> {
    Ok(SumListOutput {
        sum: input.numbers.iter().sum(),
        count: input.numbers.len() as i64,
    })
}

// ── Tier 3 (중첩/Option — static fallback 및 dynamic) ───────
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EchoInput {
    pub v: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EchoOutput {
    pub v: i64,
}

pub fn echo(input: EchoInput) -> rustra::Result<EchoOutput> {
    Ok(EchoOutput { v: input.v })
}

// 큰 페이로드용
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: i64,
    pub name: String,
    pub tags: Vec<String>,
    pub active: bool,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PayloadInput {
    pub items: Vec<Item>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PayloadOutput {
    pub count: i64,
    pub total_score: f64,
}

pub fn process_payload(input: PayloadInput) -> rustra::Result<PayloadOutput> {
    Ok(PayloadOutput {
        count: input.items.len() as i64,
        total_score: input.items.iter().map(|i| i.score).sum(),
    })
}

pub fn make_items(n: usize) -> Vec<Item> {
    (0..n)
        .map(|i| Item {
            id: i as i64,
            name: format!("item-{i}"),
            tags: vec!["tag-a".into(), "tag-b".into()],
            active: i % 2 == 0,
            score: i as f64 * 1.5,
        })
        .collect()
}

// ── wire 헬퍼 ──────────────────────────────────────────────

/// live_schema 에서 이름 → commandId 를 찾는다 (하드코딩 회피).
pub fn command_id_of(pkg: &Package, name: &str) -> u16 {
    let schema = pkg.live_schema();
    schema["commands"]
        .as_array()
        .unwrap_or_else(|| panic!("no commands in live schema"))
        .iter()
        .find(|c| c["name"] == name)
        .unwrap_or_else(|| panic!("command '{name}' not in live schema"))["commandId"]
        .as_u64()
        .unwrap() as u16
}

/// 정적 postcard fast-path 요청: `[cmd_id: u16 LE @0][postcard(I) @2]`
pub fn postcard_request<I: Serialize>(command_id: u16, input: &I) -> Vec<u8> {
    let body = postcard::to_allocvec(input).expect("postcard encode");
    let mut buf = Vec::with_capacity(2 + body.len());
    buf.extend_from_slice(&command_id.to_le_bytes());
    buf.extend_from_slice(&body);
    buf
}

/// 동적 Tier 3(JSON) 요청: `[cmd_id: u16 LE @0][json utf8 @2]`
pub fn tier3_request(command_id: u16, json: &str) -> Vec<u8> {
    let mut buf = Vec::with_capacity(2 + json.len());
    buf.extend_from_slice(&command_id.to_le_bytes());
    buf.extend_from_slice(json.as_bytes());
    buf
}

/// 동적 Tier 3 응답 디코드: `[ok: u8 @0][pad 3B][json_len: u32 LE @4][json @8]`
pub fn decode_tier3_response(buf: &[u8]) -> Value {
    assert_eq!(buf[0], 1, "expected ok tier3 response");
    let len = u32::from_le_bytes(buf[4..8].try_into().unwrap()) as usize;
    serde_json::from_slice(&buf[8..8 + len]).expect("tier3 json decode")
}

/// 정적 postcard 응답에서 output 디코드: `[ok: u8 @0][postcard(O) @8]`
pub fn decode_postcard_response<O: serde::de::DeserializeOwned>(buf: &[u8]) -> O {
    assert_eq!(buf[0], 1, "expected ok postcard response");
    postcard::from_bytes(&buf[8..]).expect("postcard decode")
}

use super::*;
use serde_json::json;

#[test]
fn round_trips_complex_map_option_and_enum() {
    let schema = json!({ "type":"object", "properties": {
        "profiles": { "type":"object", "additionalProperties": { "$ref":"#/definitions/Profile" } },
        "maybeScores": { "anyOf":[{"type":"array","items":{"type":"integer"}},{"type":"null"}] },
        "status": { "oneOf":[
            {"type":"object","properties":{"Active":{"type":"object","properties":{"level":{"type":"integer"}},"required":["level"]}},"required":["Active"]},
            {"type":"string","enum":["Idle"]}
        ]}
    }, "required":["profiles","maybeScores","status"] });
    let definitions = json!({ "Profile": { "type":"object", "properties":{"name":{"type":"string"},"score":{"type":"integer"}}, "required":["name","score"] } });
    let value = json!({ "profiles":{"z":{"name":"Zed","score":-2},"a":{"name":"아","score":42}}, "maybeScores":[1,-2,300], "status":{"Active":{"level":9}} });
    let limits = ComplexCodecLimits {
        max_depth: 32,
        max_payload_bytes: 1024,
        max_collection_length: 100,
    };
    let bytes = complex_encode(&schema, &definitions, &value, limits).expect("encode");
    assert_eq!(
        complex_decode(&schema, &definitions, &bytes, limits).expect("decode"),
        value
    );
}

#[test]
fn round_trips_recursive_refs_and_enforces_depth_limit() {
    let schema = json!({ "$ref":"#/definitions/Node" });
    let definitions = json!({ "Node": { "type":"object", "properties":{"value":{"type":"integer"},"next":{"anyOf":[{"$ref":"#/definitions/Node"},{"type":"null"}]}}, "required":["value","next"] } });
    let value = json!({ "value":1, "next":{"value":2,"next":{"value":3,"next":null}} });
    let limits = ComplexCodecLimits {
        max_depth: 16,
        max_payload_bytes: 1024,
        max_collection_length: 100,
    };
    let bytes = complex_encode(&schema, &definitions, &value, limits).expect("encode");
    assert_eq!(
        complex_decode(&schema, &definitions, &bytes, limits).expect("decode"),
        value
    );
    assert!(
        complex_encode(
            &schema,
            &definitions,
            &value,
            ComplexCodecLimits {
                max_depth: 1,
                ..limits
            }
        )
        .is_err()
    );
}

#[test]
fn rejects_duplicate_map_keys() {
    let schema = json!({ "type":"object", "additionalProperties":{"type":"integer"} });
    assert!(
        complex_decode(
            &schema,
            &json!({}),
            &[2, 1, b'a', 0, 1, b'a', 0],
            ComplexCodecLimits::DEFAULT
        )
        .is_err()
    );
}

#[test]
fn rejects_invalid_presence_tags() {
    let schema =
        json!({ "type":"object", "properties":{"value":{"type":"integer"}}, "required":[] });
    assert!(complex_decode(&schema, &json!({}), &[2], ComplexCodecLimits::DEFAULT).is_err());
}

#[test]
fn rejects_one_of_variants_without_stable_keys() {
    let schema = json!({ "oneOf":[{"type":"string"},{"type":"integer"}] });
    assert!(!complex_schema_supported(&schema, &json!({})));
    assert!(
        complex_encode(
            &schema,
            &json!({}),
            &json!("value"),
            ComplexCodecLimits::DEFAULT
        )
        .is_err()
    );
}

#[test]
fn accepts_explicit_keys_for_anonymous_one_of_variants() {
    let schema = json!({ "oneOf":[{"type":"string"},{"type":"integer"}], "x-rustra-variant-order":["text","count"] });
    let bytes = complex_encode(
        &schema,
        &json!({}),
        &json!("value"),
        ComplexCodecLimits::DEFAULT,
    )
    .expect("explicit keys");
    assert_eq!(bytes, [1, 5, b'v', b'a', b'l', b'u', b'e']);
}

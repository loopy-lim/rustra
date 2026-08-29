use super::*;

#[derive(serde::Deserialize, schemars::JsonSchema)]
#[allow(dead_code)]
struct AddIn {
    a: i64,
    b: i64,
}
#[derive(serde::Serialize, schemars::JsonSchema)]
#[allow(dead_code)]
struct AddOut {
    value: i64,
}

fn add(input: AddIn) -> Result<AddOut> {
    Ok(AddOut {
        value: input.a + input.b,
    })
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
#[allow(dead_code)]
struct FIn {
    a: f64,
}
#[derive(serde::Serialize, schemars::JsonSchema)]
#[allow(dead_code)]
struct FOut {
    value: f64,
}

fn dbl(input: FIn) -> Result<FOut> {
    Ok(FOut {
        value: input.a * 2.0,
    })
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
#[allow(dead_code)]
struct SIn {
    name: String,
}
#[derive(serde::Serialize, schemars::JsonSchema)]
#[allow(dead_code)]
struct SOut {
    len: u32,
}

fn slen(input: SIn) -> Result<SOut> {
    Ok(SOut {
        len: input.name.len() as u32,
    })
}

#[test]
fn raw_invoke_adds_scalars_without_postcard() {
    let pkg = Package::builder("test.raw").command_fn(add).build();
    assert!(
        pkg.raw_invoke_shape(1).is_some(),
        "add must be raw-eligible"
    );
    assert_eq!(pkg.invoke_raw(1, &[42, 58]).unwrap(), 100);
    // 부정수 경계 — i64 비트 그대로.
    assert_eq!(
        pkg.invoke_raw(1, &[(-5i64) as u64, 3]).unwrap(),
        (-2i64) as u64
    );
}

#[test]
fn raw_invoke_f64_bit_roundtrip() {
    let pkg = Package::builder("test.rawf64").command_fn(dbl).build();
    let bits = crate::rkyv_codec::u64_from_f64(3.5f64);
    let result = pkg.invoke_raw(1, &[bits]).expect("raw invoke f64");
    assert_eq!(crate::rkyv_codec::f64_from_u64(result), 7.0);
}

#[test]
fn raw_invoke_rejects_arity_mismatch() {
    let pkg = Package::builder("test.raw2").command_fn(add).build();
    let err = pkg.invoke_raw(1, &[1]).expect_err("must reject 1 slot");
    assert!(err.to_string().contains("expected 2 slots"));
}

#[test]
fn raw_invoke_rejects_ineligible_command() {
    // 문자열 필드 명령은 raw 조건 위반 — 폴백 신호(invalid_args).
    let pkg = Package::builder("test.rawstr").command_fn(slen).build();
    assert!(
        pkg.raw_invoke_shape(1).is_none(),
        "string command must not be raw-eligible"
    );
    let err = pkg.invoke_raw(1, &[0]).expect_err("must reject");
    assert!(err.to_string().contains("no raw handler"));
}

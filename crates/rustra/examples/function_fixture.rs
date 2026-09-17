//! Executable wire fixture used by scripts/function-registration-integration.ts.
use rustra::{DirectResponse, Package, RustraError};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{self, Read};
use std::sync::atomic::{AtomicUsize, Ordering};

static CALLS: AtomicUsize = AtomicUsize::new(0);

#[derive(Serialize, JsonSchema)]
struct User {
    id: u32,
    name: String,
}

enum DivideError {
    Zero,
}

#[derive(Serialize, JsonSchema)]
#[allow(dead_code)] // Both variants are needed to describe the wire schema.
enum Status {
    Ready { count: i32 },
    Empty,
}

#[derive(Serialize, JsonSchema)]
#[serde(untagged)]
#[allow(dead_code)] // Three variants deliberately exercise the JSON fallback.
enum Dynamic {
    Int(i32),
    Text(String),
    Flag(bool),
}

#[derive(Deserialize, Serialize, JsonSchema)]
struct Outer {
    child: Option<Middle>,
}
#[derive(Deserialize, Serialize, JsonSchema)]
struct Middle {
    child: Option<Leaf>,
}
#[derive(Deserialize, Serialize, JsonSchema)]
struct Leaf {
    n: i32,
}

fn add(a: i32, b: i32) -> i32 {
    a + b
}
fn reset() {
    CALLS.fetch_add(1, Ordering::Relaxed);
}
fn divide(a: i32, b: i32) -> Result<i32, DivideError> {
    CALLS.fetch_add(1, Ordering::Relaxed);
    if b == 0 {
        Err(DivideError::Zero)
    } else {
        Ok(a / b)
    }
}

fn package() -> Package {
    Package::builder("test.functionFixture")
        .function("add", add)
        .function("reset", reset)
        .function("greet", |name: String| format!("Hello, {name}!"))
        .function("tuple", |pair: (i32, String), flag: bool| (pair, flag))
        .function("maybe", |present: bool| present.then_some(42i32))
        .function("list", |length: u32| (0..length as i32).collect::<Vec<_>>())
        .function("user", |id: u32, name: String| User { id, name })
        .function("map", |value: i32| {
            BTreeMap::from([("value".to_owned(), value)])
        })
        .function("unitArg", |(): ()| 7i32)
        .function("nan", || {
            CALLS.fetch_add(1, Ordering::Relaxed);
            f64::NAN
        })
        .try_function("divide", divide, |_| {
            RustraError::custom("math.zero", "division by zero")
        })
        .function("status", || Status::Ready { count: 9 })
        .function("dynamic", || Dynamic::Flag(true))
        .function("fixed", |[a, b]: [i32; 2]| [a + b, a - b])
        .function("byte", |value: u8| value)
        .function("signedByte", |value: i8| value)
        .function("floats", |values: Vec<f32>| values)
        .function("optional", |value: Outer| value)
        .build()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let package = package();
    if std::env::args().nth(1).as_deref() == Some("schema") {
        let generated = package.generate_typescript()?;
        println!(
            "{}",
            json!({
                "schema": serde_json::from_str::<Value>(&generated.schema_json)?,
                "types": generated.types_ts,
                "commands": generated.commands_ts,
                "contract": generated.contract_ts,
            })
        );
        return Ok(());
    }
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    if std::env::args().nth(1).as_deref() == Some("json") {
        let request: Value = serde_json::from_str(&input)?;
        let response = match package.invoke_json(
            request["command"].as_str().ok_or("missing command")?,
            request["args"].clone(),
        ) {
            Ok(result) => json!({"ok": true, "result": result}),
            Err(error) => json!({"ok": false, "error": error.to_string()}),
        };
        println!("{response}");
        return Ok(());
    }
    let requests: Vec<Value> = serde_json::from_str(&input)?;
    let mut responses = Vec::new();
    for request in requests {
        let bytes = hex::decode(request["hex"].as_str().ok_or("missing hex")?)?;
        let before = CALLS.load(Ordering::Relaxed);
        let response = if let Some(capacity) = request["capacity"].as_u64() {
            let mut target = vec![0; usize::try_from(capacity)?];
            match package.invoke_frame_into(&bytes, &mut target) {
                Ok(DirectResponse::Written(length)) => target[..length].to_vec(),
                Ok(DirectResponse::Buffered(bytes)) => bytes,
                Err(error) => rustra::encode_frame_error(&error),
            }
        } else {
            package
                .invoke_frame(&bytes)
                .unwrap_or_else(|error| rustra::encode_frame_error(&error))
        };
        responses.push(json!({
            "hex": hex::encode(response),
            "calls": CALLS.load(Ordering::Relaxed) - before,
        }));
    }
    println!("{}", serde_json::to_string(&responses)?);
    Ok(())
}

#[derive(serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
struct Bytes {
    #[serde(with = "crate::byte_buffer")]
    #[schemars(with = "Vec<u8>")]
    data: Vec<u8>,
}

impl BufferCommandInput for Bytes {
    fn from_buffer(data: Vec<u8>) -> Self {
        Self { data }
    }
}

impl BufferCommandOutput for Bytes {
    fn into_buffer(self) -> Vec<u8> {
        self.data
    }
}

fn echo(input: Bytes) -> Result<Bytes> {
    Ok(input)
}

#[test]
fn buffer_command_moves_owned_output_without_postcard_frame() {
    let package = Package::builder("test.buffer")
        .buffer_command_fn(echo)
        .build();
    assert!(package.has_buffer_handler(1));
    assert_eq!(
        package.invoke_buffer(1, &[0, 1, 127, 128, 255]).unwrap(),
        [0, 1, 127, 128, 255]
    );
    assert!(package.invoke_buffer(1, &[]).unwrap().is_empty());
}

#[test]
fn normal_command_does_not_claim_the_buffer_capability() {
    let package = Package::builder("test.buffer-fallback")
        .command_fn(echo)
        .build();
    assert!(!package.has_buffer_handler(1));
    assert_eq!(
        package.invoke_buffer(1, &[1]).unwrap_err().code(),
        "command.invalid_args"
    );
}

#[derive(serde::Deserialize, JsonSchema)]
struct InvalidBufferInput {
    data: Vec<u8>,
    tag: u8,
}

impl BufferCommandInput for InvalidBufferInput {
    fn from_buffer(data: Vec<u8>) -> Self {
        Self { data, tag: 0 }
    }
}

#[test]
#[should_panic(
    expected = "requires input and output schemas with exactly one required Vec<u8> field"
)]
fn buffer_command_rejects_non_single_field_schemas() {
    let _ = Package::builder("test.invalid-buffer")
        .buffer_command("invalid", |input: InvalidBufferInput| {
            let _ = input.tag;
            Ok(Bytes { data: input.data })
        })
        .build();
}

#[derive(serde::Deserialize, serde::Serialize, JsonSchema)]
struct OptionalBytes {
    data: Option<Vec<u8>>,
}

impl BufferCommandInput for OptionalBytes {
    fn from_buffer(data: Vec<u8>) -> Self {
        Self { data: Some(data) }
    }
}

impl BufferCommandOutput for OptionalBytes {
    fn into_buffer(self) -> Vec<u8> {
        self.data.unwrap_or_default()
    }
}

#[test]
#[should_panic(
    expected = "requires input and output schemas with exactly one required Vec<u8> field"
)]
fn buffer_command_rejects_optional_byte_fields() {
    let _ = Package::builder("test.optional-buffer")
        .buffer_command("optional", |input: OptionalBytes| Ok(input))
        .build();
}
use super::*;

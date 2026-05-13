use rustra::prelude::*;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct AddNumbersInput {
    a: i64,
    b: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct AddNumbersOutput {
    value: i64,
}

#[command]
fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput {
        value: input.a + input.b,
    })
}

fn main() -> Result<()> {
    let package = Package::builder("example.calculator")
        .command_fn(add_numbers)
        .build();

    let output: AddNumbersOutput = package.invoke("addNumbers", AddNumbersInput { a: 2, b: 3 })?;
    println!("2 + 3 = {}", output.value);

    let generated = package.generate_typescript()?;
    generated.write_to_dir(std::env::temp_dir().join("rustra-basic-generated"))?;
    Ok(())
}

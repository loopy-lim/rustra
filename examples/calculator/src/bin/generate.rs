use rustra_calculator_example::calculator_package;
use std::path::PathBuf;

fn main() -> rustra::Result<()> {
    let generated = calculator_package().generate_typescript()?;
    let out = match std::env::var_os("RUSTRA_SCHEMA_OUT") {
        Some(p) if !p.is_empty() => PathBuf::from(p).join("schema.json"),
        _ => PathBuf::from("generated").join("schema.json"),
    };
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&out, generated.schema_json)?;
    println!("{} written", out.display());
    Ok(())
}

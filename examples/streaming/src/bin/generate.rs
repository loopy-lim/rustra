use rustra_streaming_example::streaming_package;

fn main() {
    let package = streaming_package();
    let generated = package.generate_typescript().expect("codegen failed");
    generated
        .write_schema_to_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/generated"))
        .expect("write failed");
}

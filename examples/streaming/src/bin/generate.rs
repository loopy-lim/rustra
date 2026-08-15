use rustra_streaming_example::streaming_package;

fn main() {
    let package = streaming_package();
    let generated = package.generate_typescript().expect("codegen failed");
    generated
        .write_to_dir("examples/streaming/generated")
        .expect("write failed");
}

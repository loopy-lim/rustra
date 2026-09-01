use rustra_crud_example::crud_package;

fn main() {
    let package = crud_package();
    let generated = package.generate_typescript().expect("codegen failed");
    generated
        .write_schema_to_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/generated"))
        .expect("write failed");
}

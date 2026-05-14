use rustra_crud_example::crud_package;

fn main() {
    let package = crud_package();
    let generated = package.generate_typescript().expect("codegen failed");
    generated.write_to_dir("examples/crud/generated").expect("write failed");
}

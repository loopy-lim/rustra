use rustra_auth_example::auth_package;

fn main() {
    let package = auth_package();
    let generated = package.generate_typescript().expect("codegen failed");
    generated
        .write_to_dir("examples/auth/generated")
        .expect("write failed");
}

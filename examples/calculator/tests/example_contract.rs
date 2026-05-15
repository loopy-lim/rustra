use std::process::Command;

#[test]
fn calculator_example_runs_and_generates_client() {
    let output = Command::new(env!("CARGO_BIN_EXE_rustra-calculator-example"))
        .output()
        .expect("calculator example runs");

    assert!(
        output.status.success(),
        "example failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("2 + 3 = 5"));

    let commands = std::fs::read_to_string("generated/commands.ts").unwrap();
    assert!(commands.contains("export function addNumbers"));
    assert!(commands.contains("engine.invoke<number>('addNumbers'"));
    assert!(!commands.contains("EngineRequest"));
    assert!(!commands.contains("Attachment"));
}

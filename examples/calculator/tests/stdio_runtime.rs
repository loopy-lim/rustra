use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};

struct Runtime(Child);
impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn serve_keeps_command_events_in_the_same_runtime() {
    let mut runtime = Runtime(
        Command::new(env!("CARGO_BIN_EXE_rustra-calculator-example"))
            .arg("serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut input = runtime.0.stdin.take().unwrap();
    let mut output = BufReader::new(runtime.0.stdout.take().unwrap());
    let requests = [
        json!({"id":1,"command":"__rustra_capabilities"}),
        json!({"id":2,"command":"emitDemo","args":{"ticks":1,"stepDelayMs":0}}),
        json!({"id":3,"command":"__drainEvents"}),
    ];
    let mut responses = Vec::new();
    for request in requests {
        writeln!(input, "{request}").unwrap();
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        responses.push(serde_json::from_str::<Value>(&line).unwrap());
    }
    assert_eq!(responses[0]["result"]["events"], "polling");
    assert_eq!(responses[1]["result"]["emitted"], 2);
    assert_eq!(responses[2]["id"], 3);
    assert_eq!(responses[2]["events"][0]["name"], "progress.tick");
    assert_eq!(responses[2]["events"][1]["name"], "demo.done");
}

#[test]
fn one_shot_command_errors_preserve_the_structured_error_frame() {
    let mut runtime = Runtime(
        Command::new(env!("CARGO_BIN_EXE_rustra-calculator-example"))
            .arg("invoke")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    runtime
        .0
        .stdin
        .take()
        .unwrap()
        .write_all(br#"{"command":"missing"}"#)
        .unwrap();
    let mut output = Vec::new();
    runtime
        .0
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut output)
        .unwrap();
    runtime.0.wait().unwrap();
    let response: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(response["ok"], false);
    let error: Value = serde_json::from_str(response["error"].as_str().unwrap()).unwrap();
    assert_eq!(error["code"], "command.not_found");
}

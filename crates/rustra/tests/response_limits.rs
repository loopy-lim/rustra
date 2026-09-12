use rustra::Package;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize, JsonSchema)]
struct Input {
    size: u32,
}
#[derive(Deserialize, Serialize, JsonSchema)]
struct Output {
    text: String,
}

// Own test process: changing the FFI limit cannot race another test suite.
#[test]
fn response_limit_includes_header_in_heap_direct_and_overflow_paths() {
    let package = Package::builder("limits")
        .command("text", |input: Input| {
            Ok(Output {
                text: "x".repeat(input.size as usize),
            })
        })
        .build();
    unsafe {
        rustra::ffi::rustra_ffi_set_max_payload(16);
    }
    for size in [8, 128] {
        let mut request = vec![1, 0];
        request.extend(postcard::to_allocvec(&Input { size }).unwrap());
        assert!(
            package
                .invoke_frame(&request)
                .unwrap_err()
                .to_string()
                .contains("payload.too_large")
        );
        for capacity in [0, 8, 16, 256] {
            let mut target = vec![0; capacity];
            let error = package
                .invoke_frame_into(&request, &mut target)
                .err()
                .expect("oversized response must be rejected");
            assert!(error.to_string().contains("payload.too_large"));
        }
    }
    // Seven body bytes plus postcard length and eight header bytes = exact limit.
    let request = [1, 0, 7];
    assert_eq!(package.invoke_frame(&request).unwrap().len(), 16);
    let mut target = [0; 16];
    assert!(matches!(
        package.invoke_frame_into(&request, &mut target).unwrap(),
        rustra::DirectResponse::Written(16)
    ));
    let mut small = [0; 8];
    assert!(
        matches!(package.invoke_frame_into(&request, &mut small).unwrap(), rustra::DirectResponse::Buffered(bytes) if bytes.len() == 16)
    );
}

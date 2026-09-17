use rustra::{DirectResponse, Package};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
enum IntegerSequence {
    Narrow(Vec<i8>),
    Signed(Vec<i64>),
    Unsigned(Vec<u64>),
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct Input {
    // The command's struct field is checked by the postcard eligibility gate.
    // A root enum has no properties and would select postcard instead.
    values: IntegerSequence,
}

#[test]
fn integer_sequences_preserve_complex_wire_at_dispatch_boundaries() {
    let package = Package::builder("integer-sequence-route")
        .command("echo", |input: Input| Ok(input))
        .build();
    let signed = [1, 0, 1, 2, 1, 254, 1]; // Signed([-1, 127])
    let narrow = [1, 0, 0, 1, 255, 1]; // Narrow([-128])
    let mut unsigned = vec![1, 0, 2, 1]; // Unsigned([u64::MAX])
    unsigned.extend_from_slice(&[255; 9]);
    unsigned.push(1);
    for frame in [&signed[..], &narrow[..], &unsigned[..]] {
        let response = package.invoke_frame(frame).unwrap();
        assert_eq!(&response[..8], &[1, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(&response[8..], &frame[2..]);
        for capacity in [response.len(), 64] {
            let mut target = vec![0; capacity];
            let DirectResponse::Written(length) =
                package.invoke_frame_into(frame, &mut target).unwrap()
            else {
                panic!("sufficient caller capacity must use the direct writer");
            };
            assert_eq!(length, response.len());
            assert_eq!(&target[..length], &response);
        }
        // Enter the bounded body writer, then run out of space. Zero capacity
        // separately covers immediate fallback before the body writer starts.
        let short_capacity = response.len() - 1;
        assert!(short_capacity > 8);
        for capacity in [short_capacity, 0] {
            let mut target = vec![0; capacity];
            let DirectResponse::Buffered(bytes) =
                package.invoke_frame_into(frame, &mut target).unwrap()
            else {
                panic!("insufficient caller capacity must return the owned fallback");
            };
            assert_eq!(bytes, response);
        }
    }
    for invalid in [
        vec![1, 0, 0, 1, 128, 2], // Narrow([128]): out of range.
        vec![1, 0, 1, 1, 128],    // Truncated signed integer.
        vec![1, 0, 1, 0, 0],      // Trailing byte after empty sequence.
    ] {
        assert!(package.invoke_frame(&invalid).is_err());
        assert!(package.invoke_frame_into(&invalid, &mut [0; 64]).is_err());
    }
}

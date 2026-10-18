#[path = "support/large_boundary_cases.rs"]
mod cases;

#[test]
fn valid_large_payloads_exact_limit_and_recursive_depths() {
    for mode in [0, 2] {
        for selector in 0..8 {
            cases::exercise(&[mode, selector, 42]);
        }
    }
}

#[test]
fn malformed_large_payloads_fail_without_hidden_panics() {
    for len in [65_536, 1024 * 1024, 1024 * 1024 + 1] {
        let mut input = vec![255; len];
        input[0] = 1;
        cases::exercise(&input);
    }
}

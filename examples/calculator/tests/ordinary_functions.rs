use rustra_calculator_example::calculator_package;
use serde_json::json;

#[test]
fn ordinary_functions_keep_values_void_side_effects_and_domain_errors() {
    let package = calculator_package();
    assert_eq!(
        package.invoke_json("add", json!([42, 58])).unwrap(),
        json!(100)
    );
    assert_eq!(
        package.invoke_json("greetPerson", json!(["민지"])).unwrap(),
        json!("Hello, 민지!")
    );
    assert_eq!(
        package.invoke_json("remember", json!([100])).unwrap(),
        json!(null)
    );
    assert_eq!(
        package.invoke_json("readRemembered", json!(null)).unwrap(),
        json!(100)
    );
    assert_eq!(
        package.invoke_json("reset", json!(null)).unwrap(),
        json!(null)
    );
    assert_eq!(
        package.invoke_json("readRemembered", json!(null)).unwrap(),
        json!(0)
    );
    assert_eq!(
        package
            .invoke_json("safeDivide", json!([84.0, 2.0]))
            .unwrap(),
        json!(42.0)
    );
    let error = package
        .invoke_json("safeDivide", json!([1.0, 0.0]))
        .unwrap_err();
    assert_eq!(error.code(), "math.zero_divisor");
    assert!(package.invoke_json("add", json!([42])).is_err());
    // Preserve the first legacy command and its original binary ID.
    assert_eq!(
        package.invoke_frame(&[1, 0, 84, 116]).unwrap(),
        [1, 0, 0, 0, 0, 0, 0, 0, 200, 1]
    );
}

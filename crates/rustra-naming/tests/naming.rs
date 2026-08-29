use rustra_naming::snake_to_lower_camel;

#[test]
fn converts_delimited_names_without_losing_camel_case() {
    assert_eq!(snake_to_lower_camel("add_numbers"), "addNumbers");
    assert_eq!(snake_to_lower_camel("my-command.name"), "myCommandName");
    assert_eq!(snake_to_lower_camel("AlreadyCamel"), "alreadyCamel");
    assert_eq!(snake_to_lower_camel("__leading"), "leading");
}

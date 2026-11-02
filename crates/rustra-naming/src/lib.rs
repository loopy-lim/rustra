//! Shared identifier naming rules used by the Rust and proc-macro codegen paths.

// unsafe 전무 실측 후 금지 — 순수 문자열 처리 크레이트이므로 unsafe 도입을
// 빌드 시점에 원천 차단한다.
#![forbid(unsafe_code)]

/// Converts snake-, kebab-, and dot-separated names to lower camel case.
///
/// The first alphanumeric character is always lower-cased. Delimiters are
/// removed and uppercase the next alphanumeric character, matching the
/// historical Rustra codegen behavior.
pub fn snake_to_lower_camel(name: &str) -> String {
    let mut output = String::new();
    let mut uppercase_next = false;

    for character in name.chars() {
        if matches!(character, '_' | '-' | '.') {
            uppercase_next = true;
            continue;
        }

        if output.is_empty() {
            output.push(character.to_ascii_lowercase());
            uppercase_next = false;
        } else if uppercase_next {
            output.push(character.to_ascii_uppercase());
            uppercase_next = false;
        } else {
            output.push(character);
        }
    }

    output
}

#[cfg(test)]
mod tests {
    use super::snake_to_lower_camel;

    #[test]
    fn empty_and_delimiter_only_names_remain_empty() {
        assert_eq!(snake_to_lower_camel(""), "");
        assert_eq!(snake_to_lower_camel("__"), "");
    }
}

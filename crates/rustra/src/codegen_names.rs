/// 명령 이름을 lowerCamelCase TypeScript 함수 이름으로 변환합니다.
///
/// 비영숫자 문자를 구분자로 처리합니다.
/// 예: `addNumbers` → `addNumbers`, `do-something` → `doSomething`
pub(super) fn command_function_name(name: &str) -> String {
    let mut output = String::new();
    let mut uppercase_next = false;

    for character in name.chars() {
        if character.is_ascii_alphanumeric() {
            if output.is_empty() {
                output.push(character.to_ascii_lowercase());
            } else if uppercase_next {
                output.push(character.to_ascii_uppercase());
            } else {
                output.push(character);
            }
            uppercase_next = false;
        } else {
            uppercase_next = true;
        }
    }

    if output.is_empty() {
        "command".to_string()
    } else {
        output
    }
}

/// SHA-256 해시를 hex 문자열로 반환합니다.
///
/// 스키마 무결성 검증을 위한 `contract_hash` 생성에 사용합니다.
pub(crate) fn contract_hash(input: impl AsRef<[u8]>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_ref());
    hex::encode(hasher.finalize())
}

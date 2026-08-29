use super::*;

include!("package_types.rs");

include!("package_core.rs");

include!("package_events.rs");

include!("package_json.rs");

fn edit_distance(left: &str, right: &str) -> usize {
    let right_chars: Vec<char> = right.chars().collect();
    let mut previous: Vec<usize> = (0..=right_chars.len()).collect();
    for (left_index, left_char) in left.chars().enumerate() {
        let mut current = vec![left_index + 1; right_chars.len() + 1];
        for (right_index, right_char) in right_chars.iter().enumerate() {
            current[right_index + 1] = if left_char == *right_char {
                previous[right_index]
            } else {
                1 + previous[right_index]
                    .min(previous[right_index + 1])
                    .min(current[right_index])
            };
        }
        previous = current;
    }
    previous[right_chars.len()]
}

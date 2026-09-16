//! Minimal independent encoder for this fixture's fixed complex wire contract.
use super::{Node, Payload, SearchResult};

fn unsigned(mut value: u64, output: &mut Vec<u8>) {
    while value >= 0x80 {
        output.push((value as u8) | 0x80);
        value >>= 7;
    }
    output.push(value as u8);
}

fn signed(value: i64, output: &mut Vec<u8>) {
    unsigned(((value << 1) ^ (value >> 63)) as u64, output);
}

fn string(value: &str, output: &mut Vec<u8>) {
    unsigned(value.len() as u64, output);
    output.extend_from_slice(value.as_bytes());
}

fn node(value: &Node, output: &mut Vec<u8>) {
    unsigned(value.id, output);
    string(&value.label, output);
    // Stable schema variant keys: folder, item; declaration order agrees.
    match value.payload {
        Payload::Folder(expanded) => output.extend_from_slice(&[0, u8::from(expanded)]),
        Payload::Item(number) => {
            output.push(1);
            signed(number, output);
        }
    }
    unsigned(value.attributes.len() as u64, output);
    for (key, values) in &value.attributes {
        string(key, output);
        unsigned(values.len() as u64, output);
        for number in values {
            signed(*number, output);
        }
    }
    output.push(1); // Optional struct field is present, even when its value is None.
    output.push(u8::from(value.note.is_some()));
    if let Some(note) = &value.note {
        string(note, output);
    }
    unsigned(value.children.len() as u64, output);
    for child in &value.children {
        node(child, output);
    }
}

pub(super) fn request(command_id: u16, root: &Node, target: Option<u64>) -> Vec<u8> {
    let mut output = command_id.to_le_bytes().to_vec();
    node(root, &mut output);
    if let Some(target) = target {
        unsigned(target, &mut output);
    }
    output
}

pub(super) fn search_result(value: &SearchResult) -> Vec<u8> {
    let mut output = vec![u8::from(value.found)];
    unsigned(value.id, &mut output);
    unsigned(value.visited, &mut output);
    output
}

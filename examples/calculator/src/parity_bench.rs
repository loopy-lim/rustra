//! Identical flat-arena benchmark contract shared with NitroBench 0.37.1.
//! Recursive Nitrogen DTO generation overflows; this is not a recursive DTO claim.
use rustra::{Result, command};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Mutex};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ParityNode {
    pub id: f64,
    pub name: String,
    pub tag: String,
    pub note: Option<String>,
    pub metadata: BTreeMap<String, String>,
    pub children: Vec<f64>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ParityTree {
    pub nodes: Vec<ParityNode>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct ParityFindInput {
    pub tree: ParityTree,
    pub id: f64,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct ParityQuery {
    pub id: f64,
}
#[derive(Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ParitySearch {
    pub found: bool,
    pub id: f64,
    pub name: String,
    pub visited: f64,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct ParityStored {
    pub nodes: f64,
}
#[derive(Default)]
struct Resident {
    tree: Option<ParityTree>,
    index: Vec<Option<usize>>,
}
static RESIDENT: Mutex<Resident> = Mutex::new(Resident {
    tree: None,
    index: Vec::new(),
});
fn missing(id: f64, visited: usize) -> ParitySearch {
    ParitySearch {
        found: false,
        id,
        name: String::new(),
        visited: visited as f64,
    }
}
fn search(tree: &ParityTree, id: f64) -> ParitySearch {
    let mut stack = if tree.nodes.is_empty() {
        vec![]
    } else {
        vec![0usize]
    };
    let mut visited = 0;
    while let Some(position) = stack.pop() {
        let Some(node) = tree.nodes.get(position) else {
            continue;
        };
        visited += 1;
        if node.id == id {
            return ParitySearch {
                found: true,
                id,
                name: node.name.clone(),
                visited: visited as f64,
            };
        }
        for &child in node.children.iter().rev() {
            stack.push(child as usize);
        }
    }
    missing(id, visited)
}
#[command]
pub fn parity_echo(input: ParityTree) -> Result<ParityTree> {
    Ok(input)
}
#[command]
pub fn parity_find(input: ParityFindInput) -> Result<ParitySearch> {
    Ok(search(&input.tree, input.id))
}
#[command]
pub fn parity_store(input: ParityTree) -> Result<ParityStored> {
    let nodes = input.nodes.len();
    let mut index = vec![None; nodes];
    for (position, node) in input.nodes.iter().enumerate() {
        if node.id >= 0.0 && node.id < nodes as f64 && node.id.fract() == 0.0 {
            index[node.id as usize] = Some(position);
        }
    }
    *RESIDENT.lock().unwrap() = Resident {
        tree: Some(input),
        index,
    };
    Ok(ParityStored {
        nodes: nodes as f64,
    })
}
#[command]
pub fn parity_resident(input: ParityQuery) -> Result<ParitySearch> {
    let state = RESIDENT.lock().unwrap();
    Ok(state
        .tree
        .as_ref()
        .map(|tree| search(tree, input.id))
        .unwrap_or_else(|| missing(input.id, 0)))
}
#[command]
pub fn parity_indexed(input: ParityQuery) -> Result<ParitySearch> {
    let state = RESIDENT.lock().unwrap();
    if input.id >= 0.0
        && input.id.fract() == 0.0
        && let (Some(tree), Some(Some(position))) =
            (&state.tree, state.index.get(input.id as usize))
    {
        let node = &tree.nodes[*position];
        return Ok(ParitySearch {
            found: true,
            id: input.id,
            name: node.name.clone(),
            visited: 1.0,
        });
    }
    Ok(missing(input.id, 0))
}

/// Retain macro execution metadata without moving the existing command IDs.
pub(crate) fn register_commands(builder: rustra::PackageBuilder) -> rustra::PackageBuilder {
    rustra::register!(
        builder,
        parity_echo,
        parity_find,
        parity_store,
        parity_resident,
        parity_indexed
    )
}

use rustra::{Package, Result, RustraError};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

const MAX_TREES: usize = 16;
const MAX_NODES: usize = 16_384;

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
pub struct Node {
    pub id: u32,
    pub value: i32,
    pub children: Vec<Node>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct LoadInput {
    pub tree: Node,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
pub struct TreeHandle {
    pub id: u32,
    pub generation: u32,
}
#[derive(Serialize, Deserialize, JsonSchema)]
pub struct FindInput {
    pub handle: TreeHandle,
    pub target: u32,
}
#[derive(Serialize, Deserialize, JsonSchema)]
pub struct WholeInput {
    pub tree: Node,
    pub target: u32,
}
#[derive(Serialize, Deserialize, JsonSchema)]
pub struct UpdateInput {
    pub handle: TreeHandle,
    pub target: u32,
    pub value: i32,
}
#[derive(Serialize, Deserialize, JsonSchema)]
pub struct Found {
    pub value: Option<i32>,
}
#[derive(Deserialize, Serialize, JsonSchema)]
pub struct EmptyInput {}

struct StoredTree {
    generation: u32,
    tree: Node,
}
#[derive(Default)]
struct Store {
    next_id: u32,
    trees: BTreeMap<u32, StoredTree>,
}

fn stale() -> RustraError {
    RustraError::custom("tree.stale", "released or stale tree handle")
}
fn find(tree: &Node, target: u32) -> Option<i32> {
    if tree.id == target {
        return Some(tree.value);
    }
    tree.children.iter().find_map(|child| find(child, target))
}
fn update(tree: &mut Node, target: u32, value: i32) -> bool {
    if tree.id == target {
        tree.value = value;
        return true;
    }
    tree.children
        .iter_mut()
        .any(|child| update(child, target, value))
}
fn validate(tree: &Node) -> Result<()> {
    let mut pending = vec![(tree, 0)];
    let mut ids = std::collections::BTreeSet::new();
    while let Some((node, depth)) = pending.pop() {
        if depth > 32 || ids.len() == MAX_NODES || !ids.insert(node.id) {
            return Err(RustraError::invalid_args(
                "tree requires unique IDs, at most 16384 nodes and depth 32",
            ));
        }
        pending.extend(node.children.iter().map(|child| (child, depth + 1)));
    }
    Ok(())
}

pub fn package() -> Package {
    let state = Arc::new(Mutex::new(Store::default()));
    let load = state.clone();
    let query = state.clone();
    let change = state.clone();
    let release = state.clone();
    Package::builder("examples.residentTree")
        .command("loadTree", move |input: LoadInput| -> Result<TreeHandle> {
            validate(&input.tree)?;
            let mut store = load.lock().map_err(RustraError::internal)?;
            if store.trees.len() >= MAX_TREES {
                return Err(RustraError::custom(
                    "tree.capacity",
                    "release a tree before loading another",
                ));
            }
            let id = store
                .next_id
                .checked_add(1)
                .ok_or_else(|| RustraError::custom("tree.capacity", "handle IDs exhausted"))?;
            store.next_id = id;
            store.trees.insert(
                id,
                StoredTree {
                    generation: 1,
                    tree: input.tree,
                },
            );
            Ok(TreeHandle { id, generation: 1 })
        })
        .command("findNode", move |input: FindInput| -> Result<Found> {
            let store = query.lock().map_err(RustraError::internal)?;
            let stored = store
                .trees
                .get(&input.handle.id)
                .filter(|tree| tree.generation == input.handle.generation)
                .ok_or_else(stale)?;
            Ok(Found {
                value: find(&stored.tree, input.target),
            })
        })
        .command("findWholeTree", |input: WholeInput| -> Result<Found> {
            validate(&input.tree)?;
            Ok(Found {
                value: find(&input.tree, input.target),
            })
        })
        .command(
            "updateNode",
            move |input: UpdateInput| -> Result<TreeHandle> {
                let mut store = change.lock().map_err(RustraError::internal)?;
                let stored = store
                    .trees
                    .get_mut(&input.handle.id)
                    .filter(|tree| tree.generation == input.handle.generation)
                    .ok_or_else(stale)?;
                let generation = stored
                    .generation
                    .checked_add(1)
                    .ok_or_else(|| RustraError::custom("tree.capacity", "generation exhausted"))?;
                if !update(&mut stored.tree, input.target, input.value) {
                    return Err(RustraError::invalid_args("unknown node ID"));
                }
                stored.generation = generation;
                Ok(TreeHandle {
                    id: input.handle.id,
                    generation,
                })
            },
        )
        .command("releaseTree", move |handle: TreeHandle| -> Result<()> {
            let mut store = release.lock().map_err(RustraError::internal)?;
            store
                .trees
                .get(&handle.id)
                .filter(|tree| tree.generation == handle.generation)
                .ok_or_else(stale)?;
            store.trees.remove(&handle.id);
            Ok(())
        })
        .command("clearTrees", move |_: EmptyInput| -> Result<()> {
            // Do not reset next_id: an old handle must never alias a later tree.
            state.lock().map_err(RustraError::internal)?.trees.clear();
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn lifecycle_invalidates_old_handles_and_limits_storage() {
        let package = package();
        let tree = json!({"id":1,"value":3,"children":[]});
        let first = package
            .invoke_json("loadTree", json!({"tree":tree}))
            .unwrap();
        let updated = package
            .invoke_json("updateNode", json!({"handle":first,"target":1,"value":9}))
            .unwrap();
        assert!(
            package
                .invoke_json("findNode", json!({"handle":first,"target":1}))
                .is_err()
        );
        assert_eq!(
            package
                .invoke_json("findNode", json!({"handle":updated,"target":1}))
                .unwrap(),
            json!({"value":9})
        );
        assert!(package.invoke_json("releaseTree", first).is_err());
        package.invoke_json("releaseTree", updated.clone()).unwrap();
        assert!(
            package
                .invoke_json("findNode", json!({"handle":updated,"target":1}))
                .is_err()
        );
        for _ in 0..MAX_TREES {
            package
                .invoke_json("loadTree", json!({"tree":tree}))
                .unwrap();
        }
        assert!(
            package
                .invoke_json("loadTree", json!({"tree":tree}))
                .is_err()
        );
        package.invoke_json("clearTrees", json!({})).unwrap();
        let next = package
            .invoke_json("loadTree", json!({"tree":tree}))
            .unwrap();
        assert_ne!(next["id"], updated["id"]);
        assert!(
            package
                .invoke_json(
                    "loadTree",
                    json!({"tree":{"id":1,"value":0,"children":[tree]}})
                )
                .is_err()
        );
    }
}

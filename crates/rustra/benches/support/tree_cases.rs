//! Shared bounded tree fixtures; construction and correctness checks are untimed.
use std::collections::BTreeMap;
use std::sync::Arc;

use rustra::Package;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[path = "../common.rs"]
mod common;
#[path = "tree_wire.rs"]
mod wire;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Payload {
    Folder(bool),
    Item(i64),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Node {
    pub id: u64,
    pub label: String,
    pub payload: Payload,
    pub attributes: BTreeMap<String, Vec<i64>>,
    pub note: Option<String>,
    pub children: Vec<Node>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
struct TreeInput {
    root: Node,
}

#[derive(Serialize, Deserialize, JsonSchema)]
struct SearchInput {
    root: Node,
    target: u64,
}

#[derive(Serialize, Deserialize, JsonSchema)]
struct ResidentInput {
    tree_index: u32,
    target: u64,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SearchResult {
    pub found: bool,
    pub id: u64,
    pub visited: u64,
}

/// The handler and in-memory baseline use this identical borrowed preorder DFS.
pub fn search(root: &Node, target: u64) -> SearchResult {
    fn visit(node: &Node, target: u64, visited: &mut u64) -> Option<u64> {
        *visited += 1;
        if node.id == target {
            return Some(node.id);
        }
        node.children
            .iter()
            .find_map(|child| visit(child, target, visited))
    }
    let mut visited = 0;
    let found = visit(root, target, &mut visited);
    SearchResult {
        found: found.is_some(),
        id: found.unwrap_or(0),
        visited,
    }
}

fn echo(input: TreeInput) -> rustra::Result<TreeInput> {
    Ok(input)
}

fn search_handler(input: SearchInput) -> rustra::Result<SearchResult> {
    Ok(search(&input.root, input.target))
}

// Metadata is consumed by the allocation runner, but not every Criterion target.
#[allow(dead_code)]
pub struct Case {
    pub name: &'static str,
    pub request: Vec<u8>,
    pub search_request: Vec<u8>,
    pub resident_request: Vec<u8>,
    pub root: Node,
    pub target: u64,
    pub node_count: usize,
    /// Node levels, including the root; codec containers also consume depth.
    pub depth: usize,
    pub max_fanout: usize,
}

fn node(id: u64, label_bytes: usize, children: Vec<Node>) -> Node {
    let prefix = format!("node-{id:04}-");
    Node {
        id,
        label: format!("{prefix}{}", "x".repeat(label_bytes - prefix.len())),
        payload: if children.is_empty() {
            Payload::Item(-(id as i64))
        } else {
            Payload::Folder(id.is_multiple_of(2))
        },
        attributes: BTreeMap::from([
            ("bounds".into(), vec![-(id as i64), 0, id as i64]),
            ("weights".into(), vec![1, 3, 5, 8]),
        ]),
        note: id.is_multiple_of(3).then(|| format!("note-{id}")),
        children,
    }
}

fn branching(levels: usize, fanout: usize, label_bytes: usize, next: &mut u64) -> Node {
    let id = *next;
    *next += 1;
    let children = if levels > 1 {
        (0..fanout)
            .map(|_| branching(levels - 1, fanout, label_bytes, next))
            .collect()
    } else {
        Vec::new()
    };
    node(id, label_bytes, children)
}

fn geometry(root: &Node) -> (usize, usize, usize) {
    let mut count = 1;
    let mut depth = 1;
    let mut fanout = root.children.len();
    for child in &root.children {
        let (child_count, child_depth, child_fanout) = geometry(child);
        count += child_count;
        depth = depth.max(child_depth + 1);
        fanout = fanout.max(child_fanout);
    }
    (count, depth, fanout)
}

fn verify_case(pkg: &Package, case: &Case) {
    let response = pkg
        .invoke_frame(&case.request)
        .unwrap_or_else(|error| panic!("{} echo: {error}", case.name));
    assert_eq!(response[0], 1, "{} echo status", case.name);
    assert_eq!(&response[8..], &case.request[2..], "{} echo", case.name);

    let expected = SearchResult {
        found: true,
        id: case.target,
        visited: case.node_count as u64,
    };
    assert_eq!(
        search(&case.root, case.target),
        expected,
        "{} DFS",
        case.name
    );
    for request in [&case.search_request, &case.resident_request] {
        let response = pkg
            .invoke_frame(request)
            .unwrap_or_else(|error| panic!("{} search: {error}", case.name));
        assert_eq!(response[0], 1, "{} search status", case.name);
        assert_eq!(
            &response[8..],
            wire::search_result(&expected),
            "{} search body",
            case.name
        );
        let actual: SearchResult = common::decode_postcard_response(&response);
        assert_eq!(actual, expected, "{} search result", case.name);
    }
}

fn maximum_depth() -> usize {
    let pkg = Package::builder("bench.tree_depth")
        .command("treeEcho", echo)
        .command("treeSearch", search_handler)
        .build();
    let echo_id = common::command_id_of(&pkg, "treeEcho");
    let search_id = common::command_id_of(&pkg, "treeSearch");
    let mut max_accepted = 0;
    let mut rejected = false;
    for depth in 1..=40 {
        let root = branching(depth, 1, 32, &mut 1);
        let mut accepted = Vec::new();
        for (id, target) in [(echo_id, None), (search_id, Some(depth as u64))] {
            let request = wire::request(id, &root, target);
            match pkg.invoke_frame(&request) {
                Ok(response) => {
                    assert!(!rejected, "depth {depth} succeeded after a depth rejection");
                    assert_eq!(response[0], 1);
                    let expected = if target.is_some() {
                        wire::search_result(&search(&root, depth as u64))
                    } else {
                        request[2..].to_vec()
                    };
                    assert_eq!(&response[8..], expected);
                    accepted.push(true);
                }
                Err(error) => {
                    assert_eq!(error.code(), "command.invalid_args", "{error}");
                    assert_eq!(error.message(), "complex codec: value depth exceeds 32");
                    accepted.push(false);
                }
            }
        }
        assert_eq!(accepted[0], accepted[1], "echo/search depth {depth}");
        if accepted[0] {
            max_accepted = depth;
        } else {
            rejected = true;
        }
    }
    assert!(rejected && max_accepted > 0 && max_accepted < 40);
    max_accepted
}

/// Requests use an independent wire writer, never the runtime codec being timed.
pub fn fixtures() -> (Package, Vec<Case>) {
    // Business node levels differ from schema depth: maps/arrays/enums count too.
    // Probe the unchanged defaults, then expose the largest accepted chain.
    let max_depth = maximum_depth();
    let shapes = [
        ("balanced31", 5, 2, 32, 31),
        ("balanced255", 8, 2, 32, 255),
        ("balanced1023", 10, 2, 32, 1023),
        ("balanced8191", 13, 2, 32, 8191),
        ("wide1025", 2, 1024, 32, 1025),
        ("skew_limit", max_depth, 1, 32, max_depth),
        ("payload255", 8, 2, 512, 255),
    ];
    let roots: Vec<Node> = shapes
        .iter()
        .map(|&(_, levels, fanout, label_bytes, _)| branching(levels, fanout, label_bytes, &mut 1))
        .collect();
    // One-time resident load/clone and package setup are outside every measure.
    let resident = Arc::new(roots.clone());
    let pkg = Package::builder("bench.tree_route")
        .command("treeEcho", echo)
        .command("treeSearch", search_handler)
        .command("residentSearch", move |input: ResidentInput| {
            let root = resident
                .get(input.tree_index as usize)
                .ok_or_else(|| rustra::RustraError::invalid_args("unknown benchmark tree"))?;
            Ok(search(root, input.target))
        })
        .build();
    let echo_id = common::command_id_of(&pkg, "treeEcho");
    let search_id = common::command_id_of(&pkg, "treeSearch");
    let resident_id = common::command_id_of(&pkg, "residentSearch");
    let mut cases = Vec::new();
    for (index, ((name, levels, fanout, _, expected_nodes), root)) in
        shapes.into_iter().zip(roots).enumerate()
    {
        let (node_count, depth, max_fanout) = geometry(&root);
        assert_eq!(
            (node_count, depth, max_fanout),
            (expected_nodes, levels, fanout)
        );
        let target = node_count as u64; // IDs increase in preorder: last is worst case.
        let case = Case {
            name,
            request: wire::request(echo_id, &root, None),
            search_request: wire::request(search_id, &root, Some(target)),
            resident_request: common::postcard_request(
                resident_id,
                &ResidentInput {
                    tree_index: index as u32,
                    target,
                },
            ),
            root,
            target,
            node_count,
            depth,
            max_fanout,
        };
        verify_case(&pkg, &case);
        cases.push(case);
    }
    (pkg, cases)
}

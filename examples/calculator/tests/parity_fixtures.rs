use rustra_calculator_example::parity_bench::*;
use std::collections::BTreeMap;
fn tree() -> ParityTree {
    ParityTree {
        nodes: (0..3)
            .map(|id| ParityNode {
                id: id as f64,
                name: format!("node-{id}"),
                tag: "file".into(),
                note: if id == 1 { Some("note".into()) } else { None },
                metadata: BTreeMap::from([("owner".into(), "x".into())]),
                children: if id == 0 { vec![1.0, 2.0] } else { vec![] },
            })
            .collect(),
    }
}
#[test]
fn parity_echo_preserves_all_fields() {
    let input = tree();
    assert_eq!(parity_echo(input.clone()).unwrap(), input);
}
#[test]
fn parity_dfs_counts_and_misses() {
    let found = parity_find(ParityFindInput {
        tree: tree(),
        id: 2.0,
    })
    .unwrap();
    assert_eq!(
        found,
        ParitySearch {
            found: true,
            id: 2.0,
            name: "node-2".into(),
            visited: 3.0
        }
    );
    assert_eq!(
        parity_find(ParityFindInput {
            tree: tree(),
            id: -1.0
        })
        .unwrap()
        .visited,
        3.0
    );
}
#[test]
fn parity_resident_index_and_replacement() {
    assert_eq!(parity_store(tree()).unwrap().nodes, 3.0);
    assert_eq!(
        parity_resident(ParityQuery { id: 2.0 }).unwrap().visited,
        3.0
    );
    assert_eq!(
        parity_indexed(ParityQuery { id: 2.0 }).unwrap().visited,
        1.0
    );
    assert!(!parity_indexed(ParityQuery { id: -1.0 }).unwrap().found);
    let mut updated = tree();
    updated.nodes[2].name = "updated".into();
    parity_store(updated).unwrap();
    assert_eq!(
        parity_indexed(ParityQuery { id: 2.0 }).unwrap().name,
        "updated"
    );
}

#[test]
fn parity_commands_preserve_ids_and_declare_original_sync_execution() {
    let schema = rustra_calculator_example::calculator_package().live_schema();
    let commands = schema["commands"].as_array().unwrap();
    for (name, id) in [
        ("benchAdd", 23),
        ("benchEchoString", 24),
        ("benchEchoBytes", 25),
        ("benchEchoPair", 26),
        ("parityEcho", 34),
        ("parityFind", 35),
        ("parityStore", 36),
        ("parityResident", 37),
        ("parityIndexed", 38),
    ] {
        let command = commands
            .iter()
            .find(|command| command["name"] == name)
            .unwrap();
        assert_eq!(command["commandId"], id);
        assert_eq!(command["execution"], "sync", "{name}");
    }
}

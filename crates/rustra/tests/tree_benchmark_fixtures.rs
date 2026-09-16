#[path = "../benches/support/tree_cases.rs"]
mod tree_cases;

#[test]
fn tree_workloads_preserve_complete_wire_and_worst_case_search() {
    // fixtures() verifies echo, both request paths, pure DFS, and depth 1..40.
    let (_, cases) = tree_cases::fixtures();
    assert_eq!(cases.len(), 7);
    for case in cases {
        let mut stack = vec![&case.root];
        let mut preorder_ids = Vec::new();
        let mut folders = 0;
        let mut notes = 0;
        while let Some(node) = stack.pop() {
            preorder_ids.push(node.id);
            folders += usize::from(matches!(node.payload, tree_cases::Payload::Folder(_)));
            notes += usize::from(node.note.is_some());
            assert_eq!(node.attributes.len(), 2);
            assert_eq!(
                node.label.len(),
                if case.name == "payload255" { 512 } else { 32 }
            );
            stack.extend(node.children.iter().rev());
        }
        assert_eq!(
            preorder_ids,
            (1..=case.node_count as u64).collect::<Vec<_>>()
        );
        assert_eq!(case.target, *preorder_ids.last().unwrap());
        assert!(folders > 0 && folders < case.node_count);
        assert!(notes > 0 && notes < case.node_count);
        assert_eq!(tree_cases::search(&case.root, 1).visited, 1);
        let missing = tree_cases::search(&case.root, u64::MAX);
        assert_eq!(
            missing,
            tree_cases::SearchResult {
                found: false,
                id: 0,
                visited: case.node_count as u64,
            }
        );
    }
}

//! Core-only diagnostic: calls the real calculator resident command, without JSI/FFI.
use rustra_calculator_example::parity_bench::*;
use std::{
    hint::black_box,
    mem::{align_of, offset_of, size_of},
    time::Instant,
};
fn load(path: &str) -> ParityTree {
    let tree: ParityTree = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    // Host-only JSON + postcard loader: owned sequence hints, not native allocator history.
    postcard::from_bytes(&postcard::to_allocvec(&tree).unwrap()).unwrap()
}

#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StackTrace {
    capacity_sequence: Vec<usize>,
    max_live: usize,
}
impl StackTrace {
    fn observe(&mut self, stack: &Vec<usize>) {
        if self.capacity_sequence.last() != Some(&stack.capacity()) {
            self.capacity_sequence.push(stack.capacity());
        }
        self.max_live = self.max_live.max(stack.len());
    }
}
fn missing(id: f64, visited: usize) -> ParitySearch {
    ParitySearch {
        found: false,
        id,
        name: String::new(),
        visited: visited as f64,
    }
}
fn search_probe(tree: &ParityTree, id: f64, trace: &mut StackTrace) -> ParitySearch {
    let mut stack = if tree.nodes.is_empty() {
        vec![]
    } else {
        vec![0usize]
    };
    trace.observe(&stack); // DIAGNOSTIC_OBSERVE
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
            trace.observe(&stack); // DIAGNOSTIC_OBSERVE
        }
    }
    missing(id, visited)
}
fn input_capacities(tree: &ParityTree) -> serde_json::Value {
    let mut distribution = std::collections::BTreeMap::<usize, usize>::new();
    for node in &tree.nodes {
        *distribution.entry(node.children.capacity()).or_default() += 1;
    }
    serde_json::json!({
        "nodeCapacity": tree.nodes.capacity(),
        "childCapacitySum": tree.nodes.iter().map(|n| n.children.capacity()).sum::<usize>(),
        "childCapacityDistribution": distribution,
        "nonemptyChildrenWithAllocation": tree.nodes.iter().filter(|n| !n.children.is_empty() && n.children.capacity() > 0).count(),
        "emptyChildrenWithAllocation": tree.nodes.iter().filter(|n| n.children.is_empty() && n.children.capacity() > 0).count(),
        "metadataEntries": tree.nodes.iter().map(|n| n.metadata.len()).sum::<usize>(),
        "metadataBucketCounts": null,
        "metadataBucketEvidence": "BTreeMap exposes no bucket count; allocation footprint unmeasured"
    })
}

fn main() {
    let mut paths: Vec<_> = std::env::args().skip(1).collect();
    let inspect = paths.first().is_some_and(|arg| arg == "--inspect");
    if inspect {
        paths.remove(0);
    }
    assert!(!paths.is_empty(), "expected fixture paths");
    println!(
        "{}",
        serde_json::json!({"layout":{"nodeSize":size_of::<ParityNode>(),"nodeAlign":align_of::<ParityNode>(),"id":offset_of!(ParityNode,id),"name":offset_of!(ParityNode,name),"tag":offset_of!(ParityNode,tag),"note":offset_of!(ParityNode,note),"metadata":offset_of!(ParityNode,metadata),"children":offset_of!(ParityNode,children),"searchSize":size_of::<ParitySearch>()}})
    );
    for path in paths {
        let tree = load(&path);
        let count = tree.nodes.len();
        let id = (count - 1) as f64;
        parity_store(tree).unwrap();
        let hit = parity_resident(ParityQuery { id }).unwrap();
        assert!(
            hit.found
                && hit.id == id
                && hit.name == format!("node-{}", count - 1)
                && hit.visited == count as f64
        );
        assert_eq!(
            parity_resident(ParityQuery { id: -1. }).unwrap().visited,
            count as f64
        );
        assert_eq!(parity_resident(ParityQuery { id: 0. }).unwrap().visited, 1.);
        assert_eq!(parity_indexed(ParityQuery { id }).unwrap().visited, 1.);
        let mut updated = load(&path);
        updated.nodes[count - 1].name = "updated".into();
        parity_store(updated).unwrap();
        assert_eq!(parity_resident(ParityQuery { id }).unwrap().name, "updated");
        assert_eq!(parity_indexed(ParityQuery { id }).unwrap().name, "updated");
        let restored = load(&path);
        let input_node_capacity = restored.nodes.capacity();
        let input_child_capacity: usize =
            restored.nodes.iter().map(|n| n.children.capacity()).sum();
        // Inspection is a separate process mode: no timer or timing samples are used.
        let inspection = if inspect {
            let mut trace = StackTrace::default();
            let result = search_probe(&restored, id, &mut trace);
            assert_eq!(
                result,
                parity_find(ParityFindInput {
                    tree: restored.clone(),
                    id
                })
                .unwrap()
            );
            Some(serde_json::json!({
                "fixture": path,
                "nodes": count,
                "mode": "inspect",
                "inputNodeCapacity": input_node_capacity,
                "inputChildCapacitySum": input_child_capacity,
                "finalRestoredInput": &restored,
                "residentCapacityEvidence": "inferred from exact final input moved unchanged into Resident; not a resident getter",
                "residentCapacitiesInferredFromMove": input_capacities(&restored),
                "stackProbe": {
                    "capacitySequence": trace.capacity_sequence,
                    "initialAllocationCount": usize::from(!restored.nodes.is_empty()),
                    "growthCountAfterInitial": trace.capacity_sequence.len().saturating_sub(1),
                    "maxLive": trace.max_live,
                    "result": result,
                    "scope": "separate instrumented search of final restored input, outside lock and timing"
                }
            }))
        } else {
            None
        };
        parity_store(restored).unwrap();
        if let Some(observation) = inspection {
            assert_eq!(parity_resident(ParityQuery { id }).unwrap(), hit);
            println!("{}", observation);
            continue;
        }
        let mut samples = Vec::new();
        let mut checksum = 0.;
        for round in -3..31 {
            let start = Instant::now();
            for _ in 0..16 {
                let r = black_box(parity_resident(black_box(ParityQuery { id })).unwrap());
                checksum += r.id + r.visited + r.name.len() as f64 + if r.found { 1. } else { 0. };
            }
            let elapsed = start.elapsed().as_nanos() as f64 / 16.;
            if round >= 0 {
                samples.push(elapsed);
            }
        }
        println!(
            "{}",
            serde_json::json!({"fixture":path,"nodes":count,"inputNodeCapacity":input_node_capacity,"inputChildCapacitySum":input_child_capacity,"batch":16,"warmup":3,"samplesNs":samples,"checksum":checksum})
        );
    }
    parity_store(ParityTree { nodes: vec![] }).unwrap();
    assert!(!parity_resident(ParityQuery { id: 0. }).unwrap().found);
}

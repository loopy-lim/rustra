/// Codec-owned recursive targets. Nodes never own this table, so keeping targets
/// alive does not turn their Weak back edges into a strong ownership cycle.
#[derive(Clone, Debug, Default)]
pub(super) struct RecursiveTargets(Vec<std::sync::Arc<IrNode>>);

impl RecursiveTargets {
    pub(super) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub(super) fn new(ir: &IrNode) -> Self {
        let mut targets = Self::default();
        targets.collect(ir, &mut Vec::new());
        targets
    }

    fn collect(&mut self, ir: &IrNode, visited: &mut Vec<*const IrNode>) {
        let address = std::ptr::from_ref(ir);
        if visited.contains(&address) {
            return;
        }
        visited.push(address);
        match ir {
            IrNode::Ref { target } => {
                if let Ok(node) = super::complex_schema_ir::compiled_ref(target)
                    && !self
                        .0
                        .iter()
                        .any(|other| std::sync::Arc::ptr_eq(other, &node))
                {
                    self.0.push(node);
                }
            }
            IrNode::Seq { tuple, items } => {
                for node in tuple.iter().flatten().chain(items.iter()) {
                    self.collect(node, visited);
                }
            }
            IrNode::Option { inner } | IrNode::Map { value: inner } => self.collect(inner, visited),
            IrNode::Struct { fields, .. } => {
                for field in fields {
                    self.collect(&field.node, visited);
                }
            }
            IrNode::Const {
                inner: Some(node), ..
            } => self.collect(node, visited),
            IrNode::OneOf { variants } => {
                for variant in variants {
                    match &variant.body {
                        IrBody::UnwrapSingle { node, .. }
                        | IrBody::Tagged { node }
                        | IrBody::Node(node) => self.collect(node, visited),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    /// Borrow from the table, without upgrading/cloning an Arc for each value.
    fn resolve<'a>(&'a self, ir: &'a IrNode) -> Result<&'a IrNode> {
        let IrNode::Ref { target } = ir else {
            return Ok(ir);
        };
        let address = target
            .get()
            .ok_or_else(|| error("unresolved schema reference"))?
            .as_ptr();
        self.0
            .iter()
            .find(|node| std::sync::Arc::as_ptr(node) == address)
            .map(|node| node.as_ref())
            .ok_or_else(|| error("unresolved schema reference"))
    }
}

#[cfg(test)]
mod target_lifecycle_tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    #[test]
    fn target_table_and_shared_recursive_nodes_release_after_last_clone() {
        let definitions = json!({
            "A":{"type":"object","properties":{"b":{"$ref":"#/definitions/B"}}},
            "B":{"type":"object","properties":{"a":{"anyOf":[{"$ref":"#/definitions/A"},{"type":"null"}]}}}
        });
        let schema = json!({"type":"array","items":[
            {"$ref":"#/definitions/A"},{"$ref":"#/definitions/B"},{"$ref":"#/definitions/A"}
        ]});
        let root = super::super::complex_schema_ir::compile(&schema, &definitions).unwrap();
        let IrNode::Seq {
            tuple: Some(nodes), ..
        } = root.as_ref()
        else {
            panic!("tuple")
        };
        let weak_nodes: Vec<_> = nodes.iter().map(Arc::downgrade).collect();
        let targets = RecursiveTargets::new(&root);
        assert!(!targets.0.is_empty());
        let weak_targets: Vec<_> = targets.0.iter().map(Arc::downgrade).collect();
        let clone = targets.clone();
        drop(root);
        drop(targets);
        assert!(weak_nodes.iter().all(|node| node.upgrade().is_some()));
        drop(clone);
        assert!(
            weak_nodes
                .iter()
                .chain(&weak_targets)
                .all(|node| node.upgrade().is_none())
        );
    }
}

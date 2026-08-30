/// serde 에러 구현 — complex 코덱 에러는 원본과 동일하게 `complex codec:`
/// 접두사(`command.invalid_args` 코드)를 유지한다.
impl de::Error for RustraError {
    fn custom<T: fmt::Display>(message: T) -> Self {
        error(message.to_string())
    }
}
impl ser::Error for RustraError {
    fn custom<T: fmt::Display>(message: T) -> Self {
        error(message.to_string())
    }
}

// ── 직결 지원 게이트 ───────────────────────────────────────

/// IR 전체가 serde 직결 경로로 안전한 노드만 포함하는지 — 유도 코드가 타입
/// 지정 `deserialize_*` 로 진입할 수 없는 노드(any 진입이 필요한 내부 태그/
/// untagged 변형, 값 검사가 불가능한 const 단독)는 Value 경로에 남긴다.
///
/// 스키마는 재귀 `$ref`(그래프)여도 값 재귀와 무관하게 판정해야 하므로,
/// 판정 중인 노드 주소를 기록해 재진입을 낙관적 true 로 자른다 — 순환 경로
/// 자체의 판정은 순환 진입 노드의 최종 판정이 그대로 전파된다.
pub(crate) fn serde_direct_supported(ir: &IrNode) -> bool {
    serde_direct_supported_walk(ir, &mut Vec::new())
}

fn serde_direct_supported_walk(ir: &IrNode, walking: &mut Vec<*const IrNode>) -> bool {
    let key = std::ptr::from_ref(ir);
    if walking.contains(&key) {
        return true;
    }
    walking.push(key);
    let verdict = serde_direct_supported_node(ir, walking);
    walking.pop();
    verdict
}

fn serde_direct_supported_node(ir: &IrNode, walking: &mut Vec<*const IrNode>) -> bool {
    fn arc(ir: &std::sync::Arc<IrNode>, walking: &mut Vec<*const IrNode>) -> bool {
        serde_direct_supported_walk(ir, walking)
    }
    match ir {
        IrNode::String
        | IrNode::Boolean
        | IrNode::Int { .. }
        | IrNode::Float { .. }
        | IrNode::Null
        | IrNode::Enum { .. } => true,
        IrNode::Seq { tuple, items } => {
            tuple.iter().flatten().all(|node| arc(node, walking))
                && items
                    .as_ref()
                    .map(|node| arc(node, walking))
                    .unwrap_or(true)
        }
        IrNode::Option { inner } | IrNode::Map { value: inner } => arc(inner, walking),
        IrNode::Struct { fields, .. } => fields.iter().all(|field| arc(&field.node, walking)),
        IrNode::Const { inner, .. } => inner
            .as_ref()
            .map(|node| arc(node, walking))
            .unwrap_or(false),
        IrNode::OneOf { variants } => variants.iter().all(|variant| {
            match &variant.body {
                // UnwrapSingle 은 외부 태그 enum(기본 유도)과 대응한다. Tagged(
                // 판별자 const 프로퍼티)는 내부 태그 유도의 모양인데, 내부 태그는
                // deserialize_any 진입이 필수라 직결 경로에서 제외한다. Node
                // 폴스루도 보수적으로 제외한다(명시 키 익명 변형).
                IrBody::UnwrapSingle { node, .. } => arc(node, walking),
                IrBody::ConstValue(_) | IrBody::EnumFirst(_) => true,
                IrBody::Tagged { .. } | IrBody::Node(_) => false,
            }
        }),
        IrNode::Ref { target } => target.get().is_some_and(|node| arc(node, walking)),
    }
}

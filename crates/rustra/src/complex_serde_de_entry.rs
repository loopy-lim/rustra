// ── 역직렬화: 와이어 → I ────────────────────────────────────

/// 컴파일된 IR 로 와이어 바이트를 `I` 로 역직렬화한다 — `complex_decode` +
/// `from_value` 와 동일한 값, Value 트리 없음.
#[cfg(test)]
pub(crate) fn from_bytes<I: de::DeserializeOwned>(
    bytes: &[u8],
    ir: &IrNode,
    limits: ComplexCodecLimits,
) -> Result<I> {
    from_bytes_direct(bytes, ir, &RecursiveTargets::new(ir), limits)
}

/// `CompiledComplex::serde_direct()`가 true인 IR의 hot path. 호출자가 빌드
/// 시점 판정을 이미 보유하므로 매 호출마다 IR 전체를 다시 스캔하지 않는다.
#[inline]
pub(super) fn from_bytes_direct<I: de::DeserializeOwned>(
    bytes: &[u8],
    ir: &IrNode,
    targets: &RecursiveTargets,
    limits: ComplexCodecLimits,
) -> Result<I> {
    let mut reader = Reader::new(bytes, limits)?;
    let value = I::deserialize(De {
        reader: &mut reader,
        targets,
        ir,
        limits,
        depth: 0,
    })?;
    if reader.remaining() != 0 {
        return Err(error("trailing bytes in complex payload"));
    }
    Ok(value)
}
/// IR 노드를 따라가는 serde `Deserializer`. self-describing 이 아니므로 모든
/// 진입은 유도 코드의 타입 지정 `deserialize_*` 호출로 온다. `'de` 는 데이터
/// (와이어 슬라이스 + IR 트리) 수명, `'b` 는 reader 차용 수명이다.
struct De<'de, 'b> {
    reader: &'b mut Reader<'de>,
    targets: &'de RecursiveTargets,
    ir: &'de IrNode,
    limits: ComplexCodecLimits,
    depth: usize,
}

impl<'de, 'b> De<'de, 'b> {
    #[inline]
    fn node(&self) -> Result<&'de IrNode> {
        self.depth_guard()?;
        peel(self.ir, self.targets)
    }

    #[inline]
    fn depth_guard(&self) -> Result<()> {
        if self.depth > self.limits.max_depth {
            return Err(error(format!(
                "value depth exceeds {}",
                self.limits.max_depth
            )));
        }
        Ok(())
    }

    /// 자식 `De` — reader 를 재빌려 공유한다. `'de` 는 불변(ir/데이터)이고
    /// reader 만 재빌리므로 재귀 중 별칭 충돌이 없다. 호출부가 self 를
    /// 소비하지 않는 경로는 `De` 필드를 직접 만든다.
    #[allow(clippy::needless_lifetimes)]
    fn child<'c>(&'c mut self, ir: &'de IrNode, depth: usize) -> De<'de, 'c> {
        De {
            reader: self.reader,
            targets: self.targets,
            ir,
            limits: self.limits,
            depth,
        }
    }
}

/// `$ref`/const+type 해석 — 원본 decode_node 의 Ref 폴스루와 const 무시
/// (const+type 은 타입으로만 읽음)를 진입마다 적용한다.
fn peel<'a>(ir: &'a IrNode, targets: &'a RecursiveTargets) -> Result<&'a IrNode> {
    match targets.resolve(ir)? {
        IrNode::Const {
            inner: Some(node), ..
        } => targets.resolve(node),
        other => Ok(other),
    }
}

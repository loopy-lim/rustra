// ── 직렬화 진입점: O → 와이어 ───────────────────────────

/// `O` 를 IR 을 따라 와이어로 직렬화한다 — `to_value` + `encode_node_ir` 와
/// 바이트 단위 동일.
#[cfg(test)]
pub(crate) fn to_bytes<O: ser::Serialize>(
    value: &O,
    ir: &IrNode,
    limits: ComplexCodecLimits,
) -> Result<Vec<u8>> {
    let mut writer = Writer::new(limits);
    to_writer(value, &mut writer, ir, limits, 0)?;
    Ok(writer.finish())
}

/// caller 버퍼 직기록 변형 — `Writer::into_slice` 를 쓰는 경로용.
#[cfg(test)]
pub(crate) fn to_writer<O: ser::Serialize>(
    value: &O,
    writer: &mut Writer,
    ir: &IrNode,
    limits: ComplexCodecLimits,
    depth: usize,
) -> Result<()> {
    to_writer_direct(value, writer, ir, &RecursiveTargets::new(ir), limits, depth)
}

/// 빌드 시점에 direct 지원을 확인한 IR의 caller-buffer hot path.
#[inline]
pub(super) fn to_writer_direct<O: ser::Serialize>(
    value: &O,
    writer: &mut Writer,
    ir: &IrNode,
    targets: &RecursiveTargets,
    limits: ComplexCodecLimits,
    depth: usize,
) -> Result<()> {
    value.serialize(Ser {
        writer,
        targets,
        ir,
        limits,
        depth,
    })
}

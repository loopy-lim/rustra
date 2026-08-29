use super::{
    ComplexCodecLimits, Result,
    complex_codec_decode::decode_node_ir,
    complex_codec_encode::encode_node_ir,
    complex_codec_schema::error,
    complex_codec_wire::{Reader, Writer},
    complex_schema_ir::{IrNode, compile},
};
use serde_json::Value;

/// 호출당 컴파일 진입 — 테스트/비핫 경로용. 핫 경로(명령 핸들러)는 빌드 시점
/// 1회 컴파일한 [`CompiledComplex`] 를 캡처한다.
pub(crate) fn complex_encode(
    schema: &Value,
    definitions: &Value,
    value: &Value,
    limits: ComplexCodecLimits,
) -> Result<Vec<u8>> {
    let ir = compile(schema, definitions)?;
    let mut writer = Writer::new(limits);
    encode_node_ir(&mut writer, &ir, value, limits, 0)?;
    Ok(writer.finish())
}

/// 호출당 컴파일 + caller 버퍼 직기록 (테스트/비핫 경로용).
pub(crate) fn complex_encode_into(
    schema: &Value,
    definitions: &Value,
    value: &Value,
    target: &mut [u8],
    limits: ComplexCodecLimits,
) -> Result<usize> {
    let ir = compile(schema, definitions)?;
    let mut writer = Writer::into_slice(target, limits);
    encode_node_ir(&mut writer, &ir, value, limits, 0)?;
    Ok(writer.written)
}

/// 빌드 시점 1회 컴파일 결과 — 명령 핸들러가 캡처하는 complex 코덱. 컴파일
/// 실패(미지원 스키마)도 빌드 시점에 고정되고, 호출 시점에 동일한 에러를
/// 재방출한다(원본이 매 호출 실패했을 것과 동일한 관찰 동작).
#[derive(Clone, Debug)]
pub(crate) struct CompiledComplex {
    ir: Result<Arc<IrNode>>,
}

impl CompiledComplex {
    /// 스키마 → IR 빌드 시점 1회 컴파일.
    pub(crate) fn new(schema: &Value, definitions: &Value) -> Self {
        Self {
            ir: compile(schema, definitions),
        }
    }

    pub(crate) fn encode(&self, value: &Value, limits: ComplexCodecLimits) -> Result<Vec<u8>> {
        let ir = self.ir.as_ref().map_err(|error| error.clone())?;
        let mut writer = Writer::new(limits);
        encode_node_ir(&mut writer, ir, value, limits, 0)?;
        Ok(writer.finish())
    }

    pub(crate) fn encode_into(
        &self,
        value: &Value,
        target: &mut [u8],
        limits: ComplexCodecLimits,
    ) -> Result<usize> {
        let ir = self.ir.as_ref().map_err(|error| error.clone())?;
        let mut writer = Writer::into_slice(target, limits);
        encode_node_ir(&mut writer, ir, value, limits, 0)?;
        Ok(writer.written)
    }

    pub(crate) fn decode(&self, bytes: &[u8], limits: ComplexCodecLimits) -> Result<Value> {
        let ir = self.ir.as_ref().map_err(|error| error.clone())?;
        let mut reader = Reader::new(bytes, limits)?;
        let value = decode_node_ir(&mut reader, ir, limits, 0)?;
        if reader.remaining() != 0 {
            return Err(error("trailing bytes in complex payload"));
        }
        Ok(value)
    }
}

/// 호출당 컴파일 디코드 — `complex_codec_tests` 와 비핫 경로용.
pub(crate) fn test_only_complex_decode(
    schema: &Value,
    definitions: &Value,
    bytes: &[u8],
    limits: ComplexCodecLimits,
) -> Result<Value> {
    let ir = compile(schema, definitions)?;
    let mut reader = Reader::new(bytes, limits)?;
    let value = decode_node_ir(&mut reader, &ir, limits, 0)?;
    if reader.remaining() != 0 {
        return Err(error("trailing bytes in complex payload"));
    }
    Ok(value)
}

use std::sync::Arc;

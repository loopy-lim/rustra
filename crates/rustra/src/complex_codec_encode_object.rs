use super::{
    ComplexCodecLimits, Result,
    complex_codec_decode::decode_node_ir,
    complex_codec_encode::encode_node_ir,
    complex_codec_schema::error,
    complex_codec_wire::{Reader, Writer},
    complex_schema_ir::{IrNode, compile},
    complex_serde,
};
use serde_json::Value;

/// 호출당 컴파일 진입 — 테스트 전용 (핫 경로는 빌드 시점 1회 컴파일한
/// [`CompiledComplex`] 를 캡처한다). 원본 런타임 해석과 바이트 단위 동일성은
/// `CompiledComplex` 와 공유하는 IR 순회가 보장한다.
#[cfg(test)]
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

/// 빌드 시점 1회 컴파일 결과 — 명령 핸들러가 캡처하는 complex 코덱. 컴파일
/// 실패(미지원 스키마)도 빌드 시점에 고정되고, 호출 시점에 동일한 에러를
/// 재방출한다(원본이 매 호출 실패했을 것과 동일한 관찰 동작).
#[derive(Clone, Debug)]
pub(crate) struct CompiledComplex {
    ir: Result<Arc<IrNode>>,
    /// IR 이 serde 직결 경로를 시도할 수 있는지(트랙 B 게이트). 재귀
    /// 스키마에서 IR에 드러나지 않는 serde 모양은 Value 호환 경로로 재시도한다.
    direct: bool,
    targets: complex_serde::RecursiveTargets,
    compatibility_fallback: bool,
}

impl CompiledComplex {
    /// 스키마 → IR 빌드 시점 1회 컴파일.
    pub(crate) fn new(schema: &Value, definitions: &Value) -> Self {
        match compile(schema, definitions) {
            Ok(ir) => {
                let targets = complex_serde::RecursiveTargets::new(&ir);
                Self {
                    direct: complex_serde::serde_direct_supported(&ir),
                    compatibility_fallback: !targets.is_empty(),
                    targets,
                    ir: Ok(ir),
                }
            }
            Err(error) => Self {
                ir: Err(error),
                direct: false,
                targets: complex_serde::RecursiveTargets::default(),
                compatibility_fallback: false,
            },
        }
    }

    /// Commands select direct routing jointly for input and output. If either
    /// side was recursive, both sides previously used Value serde; preserve
    /// compatibility for the nonrecursive side as well when enabling the pair.
    pub(crate) fn pair(
        input_schema: &Value,
        output_schema: &Value,
        definitions: &Value,
    ) -> (Self, Self) {
        let mut input = Self::new(input_schema, definitions);
        let mut output = Self::new(output_schema, definitions);
        let fallback = input.compatibility_fallback || output.compatibility_fallback;
        input.compatibility_fallback = fallback;
        output.compatibility_fallback = fallback;
        (input, output)
    }

    /// serde 직결 경로 지원 여부 — 핸들러가 Value 트리 왕복을 건너뛸지 결정.
    pub(crate) fn serde_direct(&self) -> bool {
        self.direct
    }

    fn ir(&self) -> Result<&Arc<IrNode>> {
        self.ir.as_ref().map_err(|error| error.clone())
    }

    /// 와이어 → `I` 직결 역직렬화 (트랙 B). `serde_direct()`가 true 일 때만
    /// 유효하다.
    pub(crate) fn decode_direct<I: serde::de::DeserializeOwned>(
        &self,
        bytes: &[u8],
        limits: ComplexCodecLimits,
    ) -> Result<I> {
        let ir = self.ir()?;
        let direct = complex_serde::from_bytes_direct(bytes, ir, &self.targets, limits);
        if direct.is_err() && self.compatibility_fallback {
            return self.decode_compat(bytes, limits);
        }
        direct
    }

    /// `O` → 와이어 직결 직렬화 (트랙 B).
    pub(crate) fn encode_direct<O: serde::Serialize>(
        &self,
        value: &O,
        limits: ComplexCodecLimits,
    ) -> Result<Vec<u8>> {
        let ir = self.ir()?;
        let direct = complex_serde::to_bytes_direct(value, ir, &self.targets, limits);
        if direct.is_err() && self.compatibility_fallback {
            return self.encode_compat(value, limits);
        }
        direct
    }

    /// `O` → 와이어 직결 직렬화, caller 버퍼에 직기록 (트랙 B). 반환값은 기록
    /// 바이트 수다.
    pub(crate) fn encode_direct_into<O: serde::Serialize>(
        &self,
        value: &O,
        target: &mut [u8],
        limits: ComplexCodecLimits,
    ) -> Result<usize> {
        let ir = self.ir()?;
        let direct = {
            let mut writer = Writer::into_slice(target, limits);
            complex_serde::to_writer_direct(value, &mut writer, ir, &self.targets, limits, 0)
                .map(|()| writer.written)
        };
        if direct.is_err() && self.compatibility_fallback {
            return self.encode_compat_into(value, target, limits);
        }
        direct
    }

    // Keep the uncommon Value conversion outside the successful direct path.
    // Schema IR cannot distinguish flatten, nested Options or typed map keys.
    #[cold]
    #[inline(never)]
    fn decode_compat<I: serde::de::DeserializeOwned>(
        &self,
        bytes: &[u8],
        limits: ComplexCodecLimits,
    ) -> Result<I> {
        serde_json::from_value(self.decode(bytes, limits)?)
            .map_err(|err| crate::RustraError::invalid_args(format!("complex decode: {err}")))
    }

    #[cold]
    #[inline(never)]
    fn encode_compat<O: serde::Serialize>(
        &self,
        value: &O,
        limits: ComplexCodecLimits,
    ) -> Result<Vec<u8>> {
        let value = serde_json::to_value(value)
            .map_err(|err| crate::RustraError::internal(format!("complex encode: {err}")))?;
        self.encode(&value, limits)
    }

    #[cold]
    #[inline(never)]
    fn encode_compat_into<O: serde::Serialize>(
        &self,
        value: &O,
        target: &mut [u8],
        limits: ComplexCodecLimits,
    ) -> Result<usize> {
        let value = serde_json::to_value(value)
            .map_err(|err| crate::RustraError::internal(format!("complex encode: {err}")))?;
        // Replace partial direct output from offset 0 without rerunning a handler.
        self.encode_into(&value, target, limits)
    }

    pub(crate) fn encode(&self, value: &Value, limits: ComplexCodecLimits) -> Result<Vec<u8>> {
        let ir = self.ir()?;
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
        let ir = self.ir()?;
        let mut writer = Writer::into_slice(target, limits);
        encode_node_ir(&mut writer, ir, value, limits, 0)?;
        Ok(writer.written)
    }

    pub(crate) fn decode(&self, bytes: &[u8], limits: ComplexCodecLimits) -> Result<Value> {
        let ir = self.ir()?;
        let mut reader = Reader::new(bytes, limits)?;
        let value = decode_node_ir(&mut reader, ir, limits, 0)?;
        if reader.remaining() != 0 {
            return Err(error("trailing bytes in complex payload"));
        }
        Ok(value)
    }
}

use std::sync::Arc;

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compiled_recursive_codec_releases_root_and_target_table() {
        let codec = CompiledComplex::new(
            &json!({"$ref":"#/definitions/Node"}),
            &json!({
                "Node":{"type":"object","properties":{
                    "next":{"anyOf":[{"$ref":"#/definitions/Node"},{"type":"null"}]}
                }}
            }),
        );
        assert!(codec.serde_direct());
        let root = Arc::downgrade(codec.ir().unwrap());
        let clone = codec.clone();
        drop(codec);
        assert!(root.upgrade().is_some());
        drop(clone);
        assert!(
            root.upgrade().is_none(),
            "codec or target table retained the graph"
        );
    }
}

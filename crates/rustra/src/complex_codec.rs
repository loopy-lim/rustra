use crate::Result;

#[path = "complex_codec_decode.rs"]
mod complex_codec_decode;
#[path = "complex_codec_encode.rs"]
mod complex_codec_encode;
#[path = "complex_codec_encode_object.rs"]
mod complex_codec_encode_object;
#[path = "complex_codec_schema.rs"]
mod complex_codec_schema;
#[path = "complex_codec_variants.rs"]
mod complex_codec_variants;
#[path = "complex_codec_wire.rs"]
mod complex_codec_wire;
#[path = "complex_schema_ir.rs"]
pub(crate) mod complex_schema_ir;
#[path = "complex_serde.rs"]
pub(crate) mod complex_serde;

#[derive(Debug, Clone, Copy)]
pub(crate) struct ComplexCodecLimits {
    pub max_depth: usize,
    pub max_payload_bytes: usize,
    pub max_collection_length: usize,
}

impl ComplexCodecLimits {
    pub(crate) const DEFAULT: Self = Self {
        max_depth: 32,
        max_payload_bytes: 1024 * 1024,
        max_collection_length: 100_000,
    };
}

pub(crate) use complex_codec_encode_object::CompiledComplex;
pub(crate) use complex_codec_schema::complex_schema_supported;
pub(crate) use complex_codec_variants::annotate_variant_order;

// 호출당 컴파일 진입 — 테스트 전용 (핫 경로는 CompiledComplex 를 쓴다).
#[cfg(test)]
pub(crate) use complex_codec_encode_object::{complex_encode, test_only_complex_decode};

#[cfg(test)]
#[path = "complex_codec_tests.rs"]
mod tests;

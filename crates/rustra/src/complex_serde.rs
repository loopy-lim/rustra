//! Complex 코덱 serde 어댑터 — Value 트리 왕복 제거 (트랙 B).
//!
//! complex 라우트 핸들러는 `complex_decode → from_value → handler → to_value →
//! complex_encode` 체인으로 `serde_json::Value` 트리 3회 왕복을 만들었다. 이
//! 모듈은 스키마 IR([`IrNode`])을 따라가며 serde 를 직접 구동한다 —
//! [`from_bytes`]가 와이어에서 곧바로 `I`를 만들고 [`to_bytes`]가 `O`를 곧바로
//! 와이어에 기록한다. 와이어는 Value 경로(`encode_node_ir`/`decode_node_ir`)
//! 와 바이트 단위로 동일하다 — 같은 `Reader`/`Writer`, 같은 깊이/길이 규칙,
//! 같은 에러 문자열.
//!
//! serde 유도 코드와의 대응:
//! - struct → `deserialize_struct`→`visit_map`. 필드는 declaration 순서로
//!   공급하고, absent optional 필드는 키와 함께 [`AbsentField`] 값
//!   디시리얼라이저(`deserialize_option`→`visit_none`)를 건넨다 — 유도 코드는
//!   `Option` 필드를 `None` 으로 채우고 map 이 끝난 뒤 누락된 required 필드를
//!   `missing_field` 로 거부한다. Value 경로의 `from_value` 와 동일한 결과다.
//!   직렬화는 유도 코드가 declaration 순서로 `serialize_field` 를 부르므로,
//!   건너뛴 optional 필드(None+skip_serializing_if)의 presence 0 을 제자리에
//!   보충한다.
//! - oneOf(data enum) → `deserialize_enum`→`visit_enum`. 와이어 변형 인덱스는
//!   변형 키 사전순 순번인데, 유도 identifier visitor 에게는 [`IrVariant::key`]
//!   를 문자열로 건넨다 — schemars 스키마의 변형 키는 serde 유도 코드의 변형
//!   이름(기본 또는 rename 결과)과 동일하므로 `visit_str` 매칭이 곧 변형
//!   선택이다(oneOf 배열 순서가 Rust 선언 순서와 다른 경우까지 커버).
//!   직렬화도 유도 `Serialize` 가 건네는 변형 이름을 `IrVariant::key` 와
//!   대조해 와이어 인덱스를 찾는다. plain enum(`IrNode::Enum`)은 declaration
//!   순서 그대로 `visit_u64` 를 건넨다.
//! - 유도 코드가 스키마 없이는 답할 수 없는 진입(`deserialize_any` — 내부
//!   태그/untagged enum, `serde_json::Value` 필드 등)은 에러로 거부하고,
//!   [`serde_direct_supported`] 게이트가 그런 노드를 포함하는 스키마를
//!   직결 경로에서 제외한다(게이트 미달 명령은 기존 Value 경로를 유지한다).

use super::complex_codec_schema::error;
use super::complex_codec_wire::{Reader, Writer};
use super::complex_schema_ir::{IrBody, IrField, IrNode, IrVariant};
use crate::{ComplexCodecLimits, RustraError};
use serde::de::{
    self, DeserializeSeed, Deserializer, EnumAccess, MapAccess, SeqAccess, VariantAccess, Visitor,
};
use serde::ser::{
    self, SerializeMap, SerializeSeq, SerializeStruct, SerializeStructVariant, SerializeTuple,
    SerializeTupleVariant, Serializer,
};
use std::fmt;

type Result<T> = crate::Result<T>;

include!("complex_serde_support.rs");
include!("complex_serde_de_core.rs");
include!("complex_serde_de_enum.rs");
include!("complex_serde_de_access.rs");
include!("complex_serde_de_aux.rs");
include!("complex_serde_ser_core.rs");
include!("complex_serde_ser_access.rs");
include!("complex_serde_ser_map_key.rs");
include!("complex_serde_ser_struct.rs");

include!("complex_serde_tests.rs");

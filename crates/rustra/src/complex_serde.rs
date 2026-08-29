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

// ── 역직렬화: 와이어 → I ────────────────────────────────────

/// 컴파일된 IR 로 와이어 바이트를 `I` 로 역직렬화한다 — `complex_decode` +
/// `from_value` 와 동일한 값, Value 트리 없음.
pub(crate) fn from_bytes<I: de::DeserializeOwned>(
    bytes: &[u8],
    ir: &IrNode,
    limits: ComplexCodecLimits,
) -> Result<I> {
    let mut reader = Reader::new(bytes, limits)?;
    let value = I::deserialize(De {
        reader: &mut reader,
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
    ir: &'de IrNode,
    limits: ComplexCodecLimits,
    depth: usize,
}

impl<'de, 'b> De<'de, 'b> {
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
            ir,
            limits: self.limits,
            depth,
        }
    }
}

/// `$ref`/const+type 해석 — 원본 decode_node 의 Ref 폴스루와 const 무시
/// (const+type 은 타입으로만 읽음)를 진입마다 적용한다.
fn peel<'x>(ir: &'x IrNode) -> Result<&'x IrNode> {
    match ir {
        IrNode::Ref { target } => target
            .get()
            .map(|node| node.as_ref())
            .ok_or_else(|| error("unresolved schema reference")),
        IrNode::Const {
            inner: Some(node), ..
        } => Ok(node.as_ref()),
        other => Ok(other),
    }
}

impl<'de, 'b> Deserializer<'de> for De<'de, 'b> {
    type Error = RustraError;

    fn deserialize_any<V>(self, _visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        Err(error(
            "complex serde requires schema-driven typed entry (untyped schema node)",
        ))
    }

    fn deserialize_option<V>(mut self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        let IrNode::Option { inner } = peel(self.ir)? else {
            return Err(error("expected option node"));
        };
        self.depth_guard()?;
        match self.reader.byte()? {
            0 => visitor.visit_none(),
            1 => visitor.visit_some(self.child(inner, self.depth + 1)),
            _ => Err(error("invalid option presence tag")),
        }
    }

    fn deserialize_unit<V>(self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        let IrNode::Null = peel(self.ir)? else {
            return Err(error("expected null"));
        };
        visitor.visit_unit()
    }

    fn deserialize_unit_struct<V>(self, _name: &'static str, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        self.deserialize_unit(visitor)
    }

    fn deserialize_newtype_struct<V>(self, _name: &'static str, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        // newtype 래퍼는 스키마 노드를 그대로 공유한다(schemars 가 내부 타입
        // 스키마를 곧장 내보낸다).
        visitor.visit_newtype_struct(self)
    }

    fn deserialize_bool<V>(self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        let IrNode::Boolean = peel(self.ir)? else {
            return Err(error("expected boolean"));
        };
        match self.reader.byte()? {
            0 => visitor.visit_bool(false),
            1 => visitor.visit_bool(true),
            _ => Err(error("invalid boolean value")),
        }
    }

    fn deserialize_i8<V>(mut self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        self.deserialize_int(|value, visitor| visitor.visit_i8(value as i8), visitor)
    }

    fn deserialize_i16<V>(mut self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        self.deserialize_int(|value, visitor| visitor.visit_i16(value as i16), visitor)
    }

    fn deserialize_i32<V>(mut self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        self.deserialize_int(|value, visitor| visitor.visit_i32(value as i32), visitor)
    }

    fn deserialize_i64<V>(mut self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        self.deserialize_int(|value, visitor| visitor.visit_i64(value), visitor)
    }

    fn deserialize_u8<V>(mut self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        self.deserialize_int(|value, visitor| visitor.visit_u8(value as u8), visitor)
    }

    fn deserialize_u16<V>(mut self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        self.deserialize_int(|value, visitor| visitor.visit_u16(value as u16), visitor)
    }

    fn deserialize_u32<V>(mut self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        self.deserialize_int(|value, visitor| visitor.visit_u32(value as u32), visitor)
    }

    fn deserialize_u64<V>(mut self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        self.deserialize_int(|value, visitor| visitor.visit_u64(value as u64), visitor)
    }

    fn deserialize_f32<V>(self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        let IrNode::Float { single } = peel(self.ir)? else {
            return Err(error("expected number node"));
        };
        let bytes = self.reader.raw(if *single { 4 } else { 8 })?;
        let value = if *single {
            f32::from_le_bytes(bytes.try_into().unwrap())
        } else {
            f64::from_le_bytes(bytes.try_into().unwrap()) as f32
        };
        visitor.visit_f32(value)
    }

    fn deserialize_f64<V>(self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        let IrNode::Float { single } = peel(self.ir)? else {
            return Err(error("expected number node"));
        };
        let bytes = self.reader.raw(if *single { 4 } else { 8 })?;
        let value = if *single {
            f64::from(f32::from_le_bytes(bytes.try_into().unwrap()))
        } else {
            f64::from_le_bytes(bytes.try_into().unwrap())
        };
        visitor.visit_f64(value)
    }

    fn deserialize_str<V>(self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        self.deserialize_string(visitor)
    }

    fn deserialize_string<V>(self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        let IrNode::String = peel(self.ir)? else {
            return Err(error("expected string node"));
        };
        visitor.visit_string(self.reader.string()?)
    }

    fn deserialize_seq<V>(self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        let IrNode::Seq { tuple, items } = peel(self.ir)? else {
            return Err(error("expected array node"));
        };
        self.depth_guard()?;
        let length = self.reader.length()?;
        visitor.visit_seq(DeSeq {
            de: self,
            tuple: tuple.as_deref(),
            items: items.as_deref(),
            position: 0,
            length,
        })
    }

    fn deserialize_map<V>(self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        let ir = peel(self.ir)?;
        self.depth_guard()?;
        match ir {
            IrNode::Map { value } => {
                let length = self.reader.length()?;
                visitor.visit_map(DeMap {
                    de: self,
                    mode: MapMode::Entries {
                        value,
                        remaining: length,
                    },
                    absent: false,
                })
            }
            IrNode::Struct { fields, required } => visitor.visit_map(DeMap {
                de: self,
                mode: MapMode::Struct {
                    fields,
                    required,
                    position: 0,
                },
                absent: false,
            }),
            _ => Err(error("expected object node")),
        }
    }

    fn deserialize_struct<V>(
        self,
        _name: &'static str,
        _fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        self.deserialize_map(visitor)
    }

    fn deserialize_enum<V>(
        self,
        _name: &'static str,
        _variants: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        let ir = peel(self.ir)?;
        self.depth_guard()?;
        match ir {
            IrNode::OneOf { variants } => {
                let index = self.reader.varint()? as usize;
                let Some(variant) = variants.get(index) else {
                    return Err(error("enum variant index out of range"));
                };
                visitor.visit_enum(OneOfEnum {
                    variant,
                    reader: self.reader,
                    limits: self.limits,
                    depth: self.depth + 1,
                })
            }
            IrNode::Enum { values } => {
                let index = self.reader.varint()? as usize;
                if index >= values.len() {
                    return Err(error("enum index out of range"));
                }
                visitor.visit_enum(PlainEnum { index })
            }
            _ => Err(error("expected oneof node")),
        }
    }

    serde::forward_to_deserialize_any! {
        char bytes byte_buf identifier ignored_any tuple tuple_struct
    }
}

impl<'de, 'b> De<'de, 'b> {
    /// 정수 공통 — 원본 decode_node 와 동일하게 unsigned 노드는 uvar, 아니면
    /// zigzag 로 읽고 타입별 범위 검사는 visitor 에 맡긴다(serde_json
    /// `from_value` 와 같은 범위 계약).
    fn deserialize_int<V, F>(&mut self, visit: F, visitor: V) -> Result<V::Value>
    where
        F: FnOnce(i64, V) -> std::result::Result<V::Value, RustraError>,
        V: Visitor<'de>,
    {
        let IrNode::Int { unsigned } = peel(self.ir)? else {
            return Err(error("expected integer node"));
        };
        if *unsigned {
            let value = u64::try_from(self.reader.varint()?)
                .map_err(|_| error("decoded unsigned integer exceeds u64"))?;
            let value = i64::try_from(value)
                .map_err(|_| error("decoded unsigned integer exceeds JSON safe range"))?;
            visit(value, visitor)
        } else {
            let value = i64::try_from(self.reader.zigzag()?)
                .map_err(|_| error("decoded integer exceeds JSON safe range"))?;
            visit(value, visitor)
        }
    }
}

/// `visit_enum` 진입 — oneOf. 읽어 둔 와이어 인덱스(키 사전순 순번)의 변형
/// IR 로 본체 접근을 제공하고, 식별자는 Rust 선언 순번으로 건넨다.
struct OneOfEnum<'de, 'b> {
    variant: &'de IrVariant,
    reader: &'b mut Reader<'de>,
    limits: ComplexCodecLimits,
    depth: usize,
}

impl<'de, 'b> EnumAccess<'de> for OneOfEnum<'de, 'b> {
    type Error = RustraError;
    type Variant = DeVariant<'de, 'b>;

    fn variant_seed<V>(self, seed: V) -> Result<(V::Value, Self::Variant)>
    where
        V: DeserializeSeed<'de>,
    {
        let identifier = seed.deserialize(DeclKey(&self.variant.key))?;
        Ok((
            identifier,
            DeVariant {
                variant: self.variant,
                reader: self.reader,
                limits: self.limits,
                depth: self.depth,
            },
        ))
    }
}

/// `visit_enum` 진입 — plain enum(`IrNode::Enum`). 인덱스가 곧 선언 순번이고
/// 유닛 변형만 있다.
struct PlainEnum {
    index: usize,
}

impl<'de> EnumAccess<'de> for PlainEnum {
    type Error = RustraError;
    type Variant = UnitVariant;

    fn variant_seed<V>(self, seed: V) -> Result<(V::Value, Self::Variant)>
    where
        V: DeserializeSeed<'de>,
    {
        let identifier = seed.deserialize(DeclIndex(self.index))?;
        Ok((identifier, UnitVariant))
    }
}

struct UnitVariant;

impl<'de> VariantAccess<'de> for UnitVariant {
    type Error = RustraError;

    fn unit_variant(self) -> Result<()> {
        Ok(())
    }

    fn newtype_variant_seed<T>(self, _seed: T) -> Result<T::Value>
    where
        T: DeserializeSeed<'de>,
    {
        Err(error("expected unit enum variant"))
    }

    fn tuple_variant<V>(self, _len: usize, _visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        Err(error("expected unit enum variant"))
    }

    fn struct_variant<V>(self, _fields: &'static [&'static str], _visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        Err(error("expected unit enum variant"))
    }
}

/// 유도 변형 식별자용 `Deserializer` — `visit_u64(Rust 선언 순번)`. 유도
/// 식별자 enum 을 `0 => __field0` 매핑으로 맞춘다.
/// 변형 식별자 — `IrVariant::key` 를 문자열로 건넨다. schemars 스키마의 변형
/// 키는 serde 유도 코드의 변형 이름(기본 이름 또는 rename 결과)과 동일하므로,
/// 유도 identifier visitor 의 `visit_str` 이 정확히 매칭된다.
struct DeclKey<'k>(&'k str);

impl<'de, 'k> Deserializer<'de> for DeclKey<'k> {
    type Error = RustraError;

    fn deserialize_any<V>(self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        visitor.visit_str(self.0)
    }

    fn deserialize_identifier<V>(self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        visitor.visit_str(self.0)
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
        bytes byte_buf option unit unit_struct newtype_struct seq tuple
        tuple_struct map struct enum ignored_any
    }
}

/// 변형 식별자 — 와이어 인덱스를 그대로 declaration 순번으로 건넨다. plain
/// enum(`IrNode::Enum`)은 와이어 인덱스가 곧 declaration 순서다.
struct DeclIndex(usize);

impl<'de> Deserializer<'de> for DeclIndex {
    type Error = RustraError;

    fn deserialize_any<V>(self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        visitor.visit_u64(self.0 as u64)
    }

    fn deserialize_identifier<V>(self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        visitor.visit_u64(self.0 as u64)
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
        bytes byte_buf option unit unit_struct newtype_struct seq tuple
        tuple_struct map struct enum ignored_any
    }
}

/// VariantAccess — oneOf 변형 IR 본체가 와이어에 무엇이 있는지 정한다.
struct DeVariant<'de, 'b> {
    variant: &'de IrVariant,
    reader: &'b mut Reader<'de>,
    limits: ComplexCodecLimits,
    depth: usize,
}

impl<'de, 'b> VariantAccess<'de> for DeVariant<'de, 'b> {
    type Error = RustraError;

    fn unit_variant(self) -> Result<()> {
        // ConstValue/EnumFirst 본체는 와이어 0바이트 — 읽을 것 없음.
        Ok(())
    }

    fn newtype_variant_seed<T>(self, seed: T) -> Result<T::Value>
    where
        T: DeserializeSeed<'de>,
    {
        match &self.variant.body {
            // 단일 프로퍼티 언래핑 — 프로퍼티 값만 와이어에 있다.
            IrBody::UnwrapSingle { node, .. } => seed.deserialize(De {
                reader: self.reader,
                ir: node,
                limits: self.limits,
                depth: self.depth,
            }),
            // 폴스루 — 변형 전체가 값.
            IrBody::Node(node) => seed.deserialize(De {
                reader: self.reader,
                ir: node,
                limits: self.limits,
                depth: self.depth,
            }),
            IrBody::ConstValue(_) | IrBody::EnumFirst(_) | IrBody::Tagged { .. } => {
                Err(error("enum variant payload mismatch: expected value body"))
            }
        }
    }

    fn tuple_variant<V>(self, _len: usize, _visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        Err(error("tuple variants are not supported"))
    }

    fn struct_variant<V>(self, _fields: &'static [&'static str], visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        // 외부 태그 enum 의 struct 변형 — 유도 코드는 변형 이름 뒤 인라인
        // struct 로 소비한다. 와이어 본체는 UnwrapSingle(단일 프로퍼티 언래핑)
        // 이므로 프로퍼티 노드로 바로 진입한다.
        let IrBody::UnwrapSingle { node, .. } = &self.variant.body else {
            return Err(error("expected tagged enum variant"));
        };
        let IrNode::Struct { fields, required } = node.as_ref() else {
            return Err(error("expected object"));
        };
        visitor.visit_map(DeMap {
            de: De {
                reader: self.reader,
                ir: node,
                limits: self.limits,
                depth: self.depth,
            },
            mode: MapMode::Struct {
                fields,
                required,
                position: 0,
            },
            absent: false,
        })
    }
}

/// SeqAccess — tuple 고정 길이와 items 반복 두 모드. 원본 디코더와 동일하게
/// tuple 길이 불일치는 `tuple length mismatch`.
struct DeSeq<'de, 'b> {
    de: De<'de, 'b>,
    tuple: Option<&'de [std::sync::Arc<IrNode>]>,
    items: Option<&'de IrNode>,
    position: usize,
    length: usize,
}

impl<'de, 'b> SeqAccess<'de> for DeSeq<'de, 'b> {
    type Error = RustraError;

    fn next_element_seed<T>(&mut self, seed: T) -> Result<Option<T::Value>>
    where
        T: DeserializeSeed<'de>,
    {
        if let Some(tuple) = self.tuple {
            // 원본 decode_node: 선언된 tuple 길이와 와이어 길이 불일치 검사.
            if self.length != tuple.len() {
                return Err(error("tuple length mismatch"));
            }
            if self.position >= tuple.len() {
                return Ok(None);
            }
            let node = &tuple[self.position];
            self.position += 1;
            return seed
                .deserialize(De {
                    reader: &mut *self.de.reader,
                    ir: node,
                    limits: self.de.limits,
                    depth: self.de.depth + 1,
                })
                .map(Some);
        }
        if self.position >= self.length {
            return Ok(None);
        }
        self.position += 1;
        let Some(items) = self.items else {
            return Err(error("array schema is missing items"));
        };
        seed.deserialize(De {
            reader: &mut *self.de.reader,
            ir: items,
            limits: self.de.limits,
            depth: self.de.depth + 1,
        })
        .map(Some)
    }
}

/// MapAccess 모드 — 일반 map(엔트리 반복)과 struct(필드 스냅샷).
enum MapMode<'de> {
    Entries {
        value: &'de std::sync::Arc<IrNode>,
        remaining: usize,
    },
    Struct {
        fields: &'de [IrField],
        required: &'de [bool],
        position: usize,
    },
}

struct DeMap<'de, 'b> {
    de: De<'de, 'b>,
    mode: MapMode<'de>,
    /// 직전 struct 키가 presence 0 이었는지 — `next_value_seed` 가 AbsentField
    /// 로 전환할 때 쓴다.
    absent: bool,
}

impl<'de, 'b> MapAccess<'de> for DeMap<'de, 'b> {
    type Error = RustraError;

    fn next_key_seed<K>(&mut self, seed: K) -> Result<Option<K::Value>>
    where
        K: DeserializeSeed<'de>,
    {
        match &mut self.mode {
            MapMode::Entries { remaining, .. } => {
                if *remaining == 0 {
                    return Ok(None);
                }
                *remaining -= 1;
                let key = self.de.reader.string()?;
                seed.deserialize(StrDe { value: key }).map(Some)
            }
            MapMode::Struct {
                fields,
                required,
                position,
            } => {
                if *position >= fields.len() {
                    return Ok(None);
                }
                let index = *position;
                *position += 1;
                // optional 필드는 presence 태그 — 원본 decode_struct 와 동일.
                // absent 여도 키는 계속 공급한다(required 필드가 뒤에 있을 수
                // 있다) — 값은 AbsentField 가 Option 계약을 대신한다.
                if !required[index] {
                    match self.de.reader.byte()? {
                        0 => self.absent = true,
                        1 => self.absent = false,
                        _ => return Err(error("invalid optional field presence tag")),
                    }
                } else {
                    self.absent = false;
                }
                let name = fields[index].name.as_str();
                seed.deserialize(StrRef { name }).map(Some)
            }
        }
    }

    fn next_value_seed<V>(&mut self, seed: V) -> Result<V::Value>
    where
        V: DeserializeSeed<'de>,
    {
        let absent = std::mem::take(&mut self.absent);
        let (node, depth): (&IrNode, usize) = match &self.mode {
            MapMode::Entries { value, .. } => (&**value, self.de.depth + 1),
            MapMode::Struct {
                fields, position, ..
            } => {
                let index = *position - 1;
                (node_of(&fields[index]), self.de.depth + 1)
            }
        };
        if absent {
            return seed.deserialize(AbsentField);
        }
        seed.deserialize(De {
            reader: &mut *self.de.reader,
            ir: node,
            limits: self.de.limits,
            depth,
        })
    }
}

fn node_of(field: &IrField) -> &IrNode {
    &field.node
}

/// 소유 문자열 키 (map 엔트리 — 유도 `String`/`Field` 가 소비).
struct StrDe {
    value: String,
}

impl<'de> Deserializer<'de> for StrDe {
    type Error = RustraError;

    fn deserialize_any<V>(self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        visitor.visit_string(self.value)
    }

    fn deserialize_str<V>(self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        visitor.visit_string(self.value)
    }

    fn deserialize_string<V>(self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        visitor.visit_string(self.value)
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char bytes
        byte_buf option unit unit_struct newtype_struct seq tuple tuple_struct
        map struct enum identifier ignored_any
    }
}

/// 빌려온 식별자 키 (struct 필드명 — 유도 `Field` enum 이 이름 매칭).
struct StrRef<'s> {
    name: &'s str,
}

impl<'de, 's: 'de> Deserializer<'de> for StrRef<'s> {
    type Error = RustraError;

    fn deserialize_any<V>(self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        visitor.visit_borrowed_str(self.name)
    }

    fn deserialize_str<V>(self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        visitor.visit_borrowed_str(self.name)
    }

    fn deserialize_string<V>(self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        visitor.visit_borrowed_str(self.name)
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char bytes
        byte_buf option unit unit_struct newtype_struct seq tuple tuple_struct
        map struct enum identifier ignored_any
    }
}

/// absent optional 필드 값 — 유도 코드의 `Option<T>::deserialize` 진입만
/// `visit_none` 로 답하고 나머지는 거부한다. 어떤 바이트도 읽지 않는다.
struct AbsentField;

impl<'de> Deserializer<'de> for AbsentField {
    type Error = RustraError;

    fn deserialize_option<V>(self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        visitor.visit_none()
    }

    fn deserialize_any<V>(self, _visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        // Option 이 아닌 필드가 optional 로 스키마에 있는 경우 — Value 경로의
        // `from_value` 도 missing_field 로 실패하므로 동일하게 거부한다.
        Err(error("expected absent optional field"))
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
        bytes byte_buf unit unit_struct newtype_struct seq tuple tuple_struct
        map struct enum identifier ignored_any
    }
}

// ── 직렬화: O → 와이어 ─────────────────────────────────────

/// `O` 를 IR 을 따라 와이어로 직렬화한다 — `to_value` + `encode_node_ir` 와
/// 바이트 단위 동일.
pub(crate) fn to_bytes<O: ser::Serialize>(
    value: &O,
    ir: &IrNode,
    limits: ComplexCodecLimits,
) -> Result<Vec<u8>> {
    let mut writer = Writer::new(limits);
    value.serialize(Ser {
        writer: &mut writer,
        ir,
        limits,
        depth: 0,
    })?;
    Ok(writer.finish())
}

/// caller 버퍼 직기록 변형 — `Writer::into_slice` 를 쓰는 경로용.
pub(crate) fn to_writer<O: ser::Serialize>(
    value: &O,
    writer: &mut Writer,
    ir: &IrNode,
    limits: ComplexCodecLimits,
    depth: usize,
) -> Result<()> {
    value.serialize(Ser {
        writer,
        ir,
        limits,
        depth,
    })
}

struct Ser<'s, 'w, 'b> {
    writer: &'s mut Writer<'w>,
    ir: &'b IrNode,
    limits: ComplexCodecLimits,
    depth: usize,
}

impl<'s, 'w, 'b> Ser<'s, 'w, 'b> {
    fn depth_guard(&self) -> Result<()> {
        if self.depth > self.limits.max_depth {
            return Err(error(format!(
                "value depth exceeds {}",
                self.limits.max_depth
            )));
        }
        Ok(())
    }
}

/// `$ref`/const 폴스루 — 원본 encode_node 와 동일하되 const 값 검사는 건너뛴다
/// (Rust 타입이 값의 출처다; const 스키마는 타입 자신의 모양에서 유래하므로
/// 실질 도달 불가). 스키마↔타입 어긋남은 Value 경로에서도 에러였다.
fn peel_ser<'x>(ir: &'x IrNode) -> Result<&'x IrNode> {
    match ir {
        IrNode::Ref { target } => target
            .get()
            .map(|node| node.as_ref())
            .ok_or_else(|| error("unresolved schema reference")),
        IrNode::Const {
            inner: Some(node), ..
        } => Ok(node.as_ref()),
        IrNode::Const { inner: None, .. } => Err(error("expected object")),
        other => Ok(other),
    }
}

impl<'s, 'w, 'b> Serializer for Ser<'s, 'w, 'b> {
    type Ok = ();
    type Error = RustraError;
    type SerializeSeq = SerSeq<'s, 'w, 'b>;
    type SerializeTuple = SerSeq<'s, 'w, 'b>;
    type SerializeTupleStruct = SerTupleStruct<'s, 'w, 'b>;
    type SerializeTupleVariant = SerTupleVariant<'s, 'w, 'b>;
    type SerializeMap = SerMap<'s, 'w, 'b>;
    type SerializeStruct = SerStruct<'s, 'w, 'b>;
    type SerializeStructVariant = SerStructVariant<'s, 'w, 'b>;

    fn serialize_bool(self, value: bool) -> Result<()> {
        let IrNode::Boolean = peel_ser(self.ir)? else {
            return Err(error("expected boolean"));
        };
        self.writer.byte(u8::from(value))
    }

    fn serialize_i8(self, value: i8) -> Result<()> {
        self.serialize_i64(i64::from(value))
    }

    fn serialize_i16(self, value: i16) -> Result<()> {
        self.serialize_i64(i64::from(value))
    }

    fn serialize_i32(self, value: i32) -> Result<()> {
        self.serialize_i64(i64::from(value))
    }

    fn serialize_i64(self, value: i64) -> Result<()> {
        let unsigned = is_unsigned(peel_ser(self.ir)?);
        let Ser {
            writer,
            ir,
            limits: _,
            depth: _,
        } = self;
        serialize_int(writer, ir, if unsigned { None } else { Some(value) }, value)
    }

    fn serialize_u8(self, value: u8) -> Result<()> {
        self.serialize_u64(u64::from(value))
    }

    fn serialize_u16(self, value: u16) -> Result<()> {
        self.serialize_u64(u64::from(value))
    }

    fn serialize_u32(self, value: u32) -> Result<()> {
        self.serialize_u64(u64::from(value))
    }

    fn serialize_u64(self, value: u64) -> Result<()> {
        let Ser {
            writer,
            ir,
            limits: _,
            depth: _,
        } = self;
        serialize_int(writer, ir, None, value as i64)
    }

    fn serialize_f32(self, value: f32) -> Result<()> {
        self.serialize_f64(f64::from(value))
    }

    fn serialize_f64(self, value: f64) -> Result<()> {
        let IrNode::Float { single } = peel_ser(self.ir)? else {
            return Err(error("expected number node"));
        };
        if !value.is_finite() {
            return Err(error("expected finite number"));
        }
        if *single {
            self.writer.push(&(value as f32).to_le_bytes())
        } else {
            self.writer.push(&value.to_le_bytes())
        }
    }

    fn serialize_char(self, value: char) -> Result<()> {
        self.serialize_str(value.encode_utf8(&mut [0u8; 4]))
    }

    fn serialize_str(self, value: &str) -> Result<()> {
        let IrNode::String = peel_ser(self.ir)? else {
            return Err(error("expected string"));
        };
        self.writer.string(value)
    }

    fn serialize_unit(self) -> Result<()> {
        // Null 노드는 와이어 0바이트.
        if matches!(peel_ser(self.ir)?, IrNode::Null) {
            Ok(())
        } else {
            Err(error("expected null"))
        }
    }

    fn serialize_none(self) -> Result<()> {
        let IrNode::Option { .. } = peel_ser(self.ir)? else {
            return Err(error("expected option node"));
        };
        self.writer.byte(0)
    }

    fn serialize_some<T: ser::Serialize + ?Sized>(self, value: &T) -> Result<()> {
        let IrNode::Option { inner } = peel_ser(self.ir)? else {
            return Err(error("expected option node"));
        };
        self.depth_guard()?;
        self.writer.byte(1)?;
        value.serialize(Ser {
            writer: self.writer,
            ir: inner,
            limits: self.limits,
            depth: self.depth + 1,
        })
    }

    fn serialize_seq(self, len: Option<usize>) -> Result<Self::SerializeSeq> {
        let ir = peel_ser(self.ir)?;
        let IrNode::Seq { tuple, items } = ir else {
            return Err(error("expected array node"));
        };
        self.depth_guard()?;
        // 길이 프리픽스 — 유도 코드는 Vec/배열/Set 에 정확한 길이를 건넨다.
        // 모르는 이터레이터(None)는 원본 encode 와 달라질 수 있으므로 거부.
        let Some(len) = len else {
            return Err(error("array schema is missing items"));
        };
        if len > self.limits.max_collection_length {
            return Err(error(format!(
                "collection length exceeds {}",
                self.limits.max_collection_length
            )));
        }
        self.writer.varint(len as u128)?;
        Ok(SerSeq {
            writer: self.writer,
            tuple: tuple.as_deref(),
            items: items.as_deref(),
            declared: len,
            position: 0,
            limits: self.limits,
            depth: self.depth + 1,
        })
    }

    fn serialize_map(self, _len: Option<usize>) -> Result<Self::SerializeMap> {
        let ir = peel_ser(self.ir)?;
        let IrNode::Map { value } = ir else {
            return Err(error("expected object node"));
        };
        self.depth_guard()?;
        Ok(SerMap {
            writer: self.writer,
            buffer: Vec::new(),
            value,
            limits: self.limits,
            depth: self.depth + 1,
        })
    }

    fn serialize_struct(self, _name: &'static str, _len: usize) -> Result<Self::SerializeStruct> {
        let ir = peel_ser(self.ir)?;
        let IrNode::Struct { fields, required } = ir else {
            return Err(error("expected object"));
        };
        self.depth_guard()?;
        Ok(SerStruct {
            writer: self.writer,
            fields,
            required,
            next: 0,
            limits: self.limits,
            depth: self.depth + 1,
        })
    }

    fn serialize_unit_variant(
        self,
        _name: &'static str,
        _variant_index: u32,
        variant: &'static str,
    ) -> Result<()> {
        // 유도 Serialize 는 선언 인덱스를 건네지만 와이어 인덱스는 IR 정렬
        // 순서(OneOf)거나 declaration 순서(Enum)다 — 변형 이름으로 찾는다.
        match peel_ser(self.ir)? {
            IrNode::OneOf { variants } => {
                let index = resolve_variant_index(variants, variant)?;
                self.writer.varint(index as u128)
            }
            IrNode::Enum { values } => {
                let index = enum_variant_index(values, variant)?;
                self.writer.varint(index as u128)
            }
            _ => Err(error("expected oneof node")),
        }
    }

    fn serialize_newtype_variant<T: ser::Serialize + ?Sized>(
        self,
        _name: &'static str,
        _variant_index: u32,
        variant: &'static str,
        value: &T,
    ) -> Result<()> {
        let IrNode::OneOf { variants } = peel_ser(self.ir)? else {
            return Err(error("expected oneof node"));
        };
        let index = resolve_variant_index(variants, variant)?;
        self.writer.varint(index as u128)?;
        value.serialize(Ser {
            writer: self.writer,
            ir: body_node(&variants[index]),
            limits: self.limits,
            depth: self.depth + 1,
        })
    }

    fn serialize_tuple_variant(
        self,
        _name: &'static str,
        _variant_index: u32,
        variant: &'static str,
        _len: usize,
    ) -> Result<Self::SerializeTupleVariant> {
        let IrNode::OneOf { variants } = peel_ser(self.ir)? else {
            return Err(error("expected oneof node"));
        };
        let index = resolve_variant_index(variants, variant)?;
        self.writer.varint(index as u128)?;
        let ir = body_node(&variants[index]);
        Ok(SerTupleVariant {
            ser: Ser {
                writer: self.writer,
                ir,
                limits: self.limits,
                depth: self.depth + 1,
            },
        })
    }

    fn serialize_struct_variant(
        self,
        _name: &'static str,
        _variant_index: u32,
        variant: &'static str,
        _len: usize,
    ) -> Result<Self::SerializeStructVariant> {
        let IrNode::OneOf { variants } = peel_ser(self.ir)? else {
            return Err(error("expected oneof node"));
        };
        let index = resolve_variant_index(variants, variant)?;
        self.writer.varint(index as u128)?;
        // 외부 태그 enum 의 struct 변형 — 와이어 본체는 UnwrapSingle 프로퍼티
        // 노드(래퍼 키는 와이어에 없음). 인라인 struct 로 소비한다.
        let IrBody::UnwrapSingle { node, .. } = &variants[index].body else {
            return Err(error("expected tagged enum variant"));
        };
        let IrNode::Struct { fields, required } = node.as_ref() else {
            return Err(error("expected object"));
        };
        Ok(SerStructVariant {
            writer: self.writer,
            fields,
            required,
            next: 0,
            limits: self.limits,
            depth: self.depth + 1,
        })
    }

    fn serialize_tuple(self, len: usize) -> Result<Self::SerializeTuple> {
        self.serialize_seq(Some(len))
    }

    fn serialize_tuple_struct(
        self,
        _name: &'static str,
        len: usize,
    ) -> Result<Self::SerializeTupleStruct> {
        Ok(SerTupleStruct {
            inner: self.serialize_seq(Some(len))?,
        })
    }

    fn serialize_bytes(self, _value: &[u8]) -> Result<()> {
        Err(error("expected string"))
    }

    fn serialize_unit_struct(self, _name: &'static str) -> Result<()> {
        // 유닛 struct 는 값 없는 와이어 — Null 노드와 동일하게 0바이트.
        Ok(())
    }

    fn serialize_newtype_struct<T: ser::Serialize + ?Sized>(
        self,
        _name: &'static str,
        value: &T,
    ) -> Result<()> {
        // newtype 래퍼는 스키마 노드를 그대로 공유한다.
        value.serialize(self)
    }
}

/// tuple struct 직렬화 — 시퀀스와 동일한 와이어.
struct SerTupleStruct<'s, 'w, 'b> {
    inner: SerSeq<'s, 'w, 'b>,
}

impl<'s, 'w, 'b> ser::SerializeTupleStruct for SerTupleStruct<'s, 'w, 'b> {
    type Ok = ();
    type Error = RustraError;

    fn serialize_field<T: ser::Serialize + ?Sized>(&mut self, value: &T) -> Result<()> {
        SerializeSeq::serialize_element(&mut self.inner, value)
    }

    fn end(self) -> Result<()> {
        self.inner.finish()
    }
}

/// 정수 공통 — unsigned 노드는 uvar(음수 거부, 원본 `value_as_u128` 계약),
/// 아니면 zigzag.
fn serialize_int(
    writer: &mut Writer,
    ir: &IrNode,
    signed: Option<i64>,
    unsigned: i64,
) -> Result<()> {
    let IrNode::Int { unsigned: uint } = peel_ser(ir)? else {
        return Err(error("expected integer node"));
    };
    if *uint {
        let value = signed.map(i64::from_u64_lossy).unwrap_or(unsigned);
        let value =
            u64::try_from(value).map_err(|_| error("unsigned integer must be non-negative"))?;
        writer.varint(u128::from(value))
    } else {
        writer.zigzag(i128::from(unsigned))
    }
}

trait I64Ext {
    fn from_u64_lossy(self) -> i64;
}
impl I64Ext for i64 {
    fn from_u64_lossy(self) -> i64 {
        self
    }
}

fn is_unsigned(ir: &IrNode) -> bool {
    matches!(ir, IrNode::Int { unsigned: true })
}

/// 유도 Serialize 가 건네는 변형 이름(camelCase 태그)을 IR 변형 순번으로
/// 바꾼다. IR 변형의 정렬 키가 이름과 일치하면 그 순번이다 — schemars 가
/// 유도하는 태그 값/변형 이름은 variant_key 유도 결과와 동일하다.
fn resolve_variant_index(variants: &[IrVariant], variant: &str) -> Result<usize> {
    variants
        .iter()
        .position(|candidate| candidate.key == variant)
        .ok_or_else(|| error("value does not match any enum variant"))
}

/// plain enum 변형 이름 → declaration 순번(원본 `values.position` 계약).
fn enum_variant_index(values: &[serde_json::Value], variant: &str) -> Result<usize> {
    values
        .iter()
        .position(|candidate| candidate == &serde_json::Value::String(variant.into()))
        .ok_or_else(|| error("value is not a member of enum"))
}

/// 본체 노드 — newtype/tuple variant 시드로 소비한다. ConstValue/EnumFirst 는
/// 와이어 0바이트 본체라 직렬화 호출이 오면 안 되지만, 유도 코드와 스키마가
/// 어긋난 경우를 대비해 Null 노드로 흡수해 0바이트를 유지한다.
fn body_node(variant: &IrVariant) -> &IrNode {
    match &variant.body {
        IrBody::UnwrapSingle { node, .. } => node,
        IrBody::Node(node) => node,
        IrBody::Tagged { node } => node,
        IrBody::ConstValue(_) | IrBody::EnumFirst(_) => {
            static NULL: IrNode = IrNode::Null;
            &NULL
        }
    }
}

/// 시퀀스 직렬화 — tuple 반복과 items 반복 두 모드. 길이 프리픽스는
/// `serialize_seq` 에서 이미 기록됐다.
struct SerSeq<'s, 'w, 'b> {
    writer: &'s mut Writer<'w>,
    tuple: Option<&'b [std::sync::Arc<IrNode>]>,
    items: Option<&'b IrNode>,
    declared: usize,
    position: usize,
    limits: ComplexCodecLimits,
    depth: usize,
}

impl<'s, 'w, 'b> SerSeq<'s, 'w, 'b> {
    fn element<T: ser::Serialize + ?Sized>(&mut self, value: &T) -> Result<()> {
        if let Some(tuple) = self.tuple {
            if self.position >= tuple.len() || self.position >= self.declared {
                return Err(error("tuple length mismatch"));
            }
            let node = &tuple[self.position];
            self.position += 1;
            return value.serialize(Ser {
                writer: self.writer,
                ir: node,
                limits: self.limits,
                depth: self.depth,
            });
        }
        if self.position >= self.declared {
            return Err(error("tuple length mismatch"));
        }
        self.position += 1;
        let Some(items) = self.items else {
            return Err(error("array schema is missing items"));
        };
        value.serialize(Ser {
            writer: self.writer,
            ir: items,
            limits: self.limits,
            depth: self.depth,
        })
    }

    fn finish(&self) -> Result<()> {
        // 선언 길이와 실제 원소 수가 어긋나면 원본 encode 와 달라진다.
        if self.position != self.declared {
            return Err(error("tuple length mismatch"));
        }
        Ok(())
    }
}

impl<'s, 'w, 'b> SerializeSeq for SerSeq<'s, 'w, 'b> {
    type Ok = ();
    type Error = RustraError;

    fn serialize_element<T: ser::Serialize + ?Sized>(&mut self, value: &T) -> Result<()> {
        self.element(value)
    }

    fn end(self) -> Result<()> {
        self.finish()
    }
}

impl<'s, 'w, 'b> SerializeTuple for SerSeq<'s, 'w, 'b> {
    type Ok = ();
    type Error = RustraError;

    fn serialize_element<T: ser::Serialize + ?Sized>(&mut self, value: &T) -> Result<()> {
        self.element(value)
    }

    fn end(self) -> Result<()> {
        self.finish()
    }
}

/// tuple variant 직렬화 — 본체 노드를 시퀀스처럼 소비한다.
struct SerTupleVariant<'s, 'w, 'b> {
    ser: Ser<'s, 'w, 'b>,
}

impl<'s, 'w, 'b> SerializeTupleVariant for SerTupleVariant<'s, 'w, 'b> {
    type Ok = ();
    type Error = RustraError;

    fn serialize_field<T: ser::Serialize + ?Sized>(&mut self, value: &T) -> Result<()> {
        value.serialize(Ser {
            writer: self.ser.writer,
            ir: self.ser.ir,
            limits: self.ser.limits,
            depth: self.ser.depth,
        })
    }

    fn end(self) -> Result<()> {
        Ok(())
    }
}

/// map 직렬화 — Value 경로는 키를 사전순으로 정렬해 기록한다. serde map 은
/// (키, 값)을 스트리밍으로 소비하므로, 어댑터는 키/값 직렬화 바이트를 임시
/// 버퍼에 모았다가 `end()` 에서 키 사전순(원본 `sorted_map_keys` 와 동일한
/// 바이트 정렬)으로 일괄 기록해 Value 경로와 바이트 동일을 보존한다.
struct SerMap<'s, 'w, 'b> {
    writer: &'s mut Writer<'w>,
    buffer: Vec<(String, Vec<u8>)>,
    value: &'b std::sync::Arc<IrNode>,
    limits: ComplexCodecLimits,
    depth: usize,
}

impl<'s, 'w, 'b> SerializeMap for SerMap<'s, 'w, 'b> {
    type Ok = ();
    type Error = RustraError;

    fn serialize_key<T: ser::Serialize + ?Sized>(&mut self, key: &T) -> Result<()> {
        let mut key_writer = Writer::new(self.limits);
        key.serialize(AsMapKey {
            writer: &mut key_writer,
        })?;
        let bytes = key_writer.finish();
        let key = String::from_utf8(bytes).map_err(|_| error("map keys must be strings"))?;
        self.buffer.push((key, Vec::new()));
        Ok(())
    }

    fn serialize_value<T: ser::Serialize + ?Sized>(&mut self, value: &T) -> Result<()> {
        let mut value_writer = Writer::new(self.limits);
        value.serialize(Ser {
            writer: &mut value_writer,
            ir: self.value,
            limits: self.limits,
            depth: self.depth,
        })?;
        let entry = self
            .buffer
            .last_mut()
            .ok_or_else(|| error("map key must precede value"))?;
        entry.1 = value_writer.finish();
        Ok(())
    }

    fn end(self) -> Result<()> {
        let SerMap {
            writer,
            mut buffer,
            limits,
            ..
        } = self;
        if buffer.len() > limits.max_collection_length {
            return Err(error(format!(
                "collection length exceeds {}",
                limits.max_collection_length
            )));
        }
        // 정렬은 원본과 동일한 바이트 비교. 총량 한도는 기록하면서 Writer 의
        // payload 한도가 대신 검사한다.
        buffer.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
        writer.varint(buffer.len() as u128)?;
        for (key, value) in &buffer {
            writer.string(key)?;
            writer.push(value)?;
        }
        Ok(())
    }
}

/// 키를 임시 writer 에 문자열로 기록하는 Serializer.
struct AsMapKey<'s, 'b> {
    writer: &'s mut Writer<'b>,
}

impl<'s, 'b> Serializer for AsMapKey<'s, 'b> {
    type Ok = ();
    type Error = RustraError;
    type SerializeSeq = Unimpl;
    type SerializeTuple = Unimpl;
    type SerializeTupleStruct = Unimpl;
    type SerializeTupleVariant = Unimpl;
    type SerializeMap = Unimpl;
    type SerializeStruct = Unimpl;
    type SerializeStructVariant = Unimpl;

    fn serialize_str(self, value: &str) -> Result<()> {
        self.writer.push(value.as_bytes())
    }

    fn serialize_bool(self, _value: bool) -> Result<()> {
        Err(error("map keys must be strings"))
    }

    fn serialize_i8(self, _value: i8) -> Result<()> {
        Err(error("map keys must be strings"))
    }

    fn serialize_i16(self, _value: i16) -> Result<()> {
        Err(error("map keys must be strings"))
    }

    fn serialize_i32(self, _value: i32) -> Result<()> {
        Err(error("map keys must be strings"))
    }

    fn serialize_i64(self, _value: i64) -> Result<()> {
        Err(error("map keys must be strings"))
    }

    fn serialize_u8(self, _value: u8) -> Result<()> {
        Err(error("map keys must be strings"))
    }

    fn serialize_u16(self, _value: u16) -> Result<()> {
        Err(error("map keys must be strings"))
    }

    fn serialize_u32(self, _value: u32) -> Result<()> {
        Err(error("map keys must be strings"))
    }

    fn serialize_u64(self, _value: u64) -> Result<()> {
        Err(error("map keys must be strings"))
    }

    fn serialize_f32(self, _value: f32) -> Result<()> {
        Err(error("map keys must be strings"))
    }

    fn serialize_f64(self, _value: f64) -> Result<()> {
        Err(error("map keys must be strings"))
    }

    fn serialize_char(self, _value: char) -> Result<()> {
        Err(error("map keys must be strings"))
    }

    fn serialize_bytes(self, _value: &[u8]) -> Result<()> {
        Err(error("map keys must be strings"))
    }

    fn serialize_none(self) -> Result<()> {
        Err(error("map keys must be strings"))
    }

    fn serialize_some<T: ser::Serialize + ?Sized>(self, _value: &T) -> Result<()> {
        Err(error("map keys must be strings"))
    }

    fn serialize_unit(self) -> Result<()> {
        Err(error("map keys must be strings"))
    }

    fn serialize_unit_struct(self, _name: &'static str) -> Result<()> {
        Err(error("map keys must be strings"))
    }

    fn serialize_unit_variant(
        self,
        _name: &'static str,
        _variant_index: u32,
        _variant: &'static str,
    ) -> Result<()> {
        Err(error("map keys must be strings"))
    }

    fn serialize_newtype_struct<T: ser::Serialize + ?Sized>(
        self,
        _name: &'static str,
        _value: &T,
    ) -> Result<()> {
        Err(error("map keys must be strings"))
    }

    fn serialize_newtype_variant<T: ser::Serialize + ?Sized>(
        self,
        _name: &'static str,
        _variant_index: u32,
        _variant: &'static str,
        _value: &T,
    ) -> Result<()> {
        Err(error("map keys must be strings"))
    }

    fn serialize_seq(self, _len: Option<usize>) -> Result<Self::SerializeSeq> {
        Err(error("map keys must be strings"))
    }

    fn serialize_tuple(self, _len: usize) -> Result<Self::SerializeTuple> {
        Err(error("map keys must be strings"))
    }

    fn serialize_tuple_struct(
        self,
        _name: &'static str,
        _len: usize,
    ) -> Result<Self::SerializeTupleStruct> {
        Err(error("map keys must be strings"))
    }

    fn serialize_tuple_variant(
        self,
        _name: &'static str,
        _variant_index: u32,
        _variant: &'static str,
        _len: usize,
    ) -> Result<Self::SerializeTupleVariant> {
        Err(error("map keys must be strings"))
    }

    fn serialize_map(self, _len: Option<usize>) -> Result<Self::SerializeMap> {
        Err(error("map keys must be strings"))
    }

    fn serialize_struct(self, _name: &'static str, _len: usize) -> Result<Self::SerializeStruct> {
        Err(error("map keys must be strings"))
    }

    fn serialize_struct_variant(
        self,
        _name: &'static str,
        _variant_index: u32,
        _variant: &'static str,
        _len: usize,
    ) -> Result<Self::SerializeStructVariant> {
        Err(error("map keys must be strings"))
    }
}

/// 맵 키는 문자열만 지원 — 다른 엔트리는 모두 거부한다.
struct Unimpl;

impl ser::SerializeSeq for Unimpl {
    type Ok = ();
    type Error = RustraError;
    fn serialize_element<T: ser::Serialize + ?Sized>(&mut self, _value: &T) -> Result<()> {
        Err(error("map keys must be strings"))
    }
    fn end(self) -> Result<()> {
        Err(error("map keys must be strings"))
    }
}

impl ser::SerializeTuple for Unimpl {
    type Ok = ();
    type Error = RustraError;
    fn serialize_element<T: ser::Serialize + ?Sized>(&mut self, _value: &T) -> Result<()> {
        Err(error("map keys must be strings"))
    }
    fn end(self) -> Result<()> {
        Err(error("map keys must be strings"))
    }
}

impl ser::SerializeTupleStruct for Unimpl {
    type Ok = ();
    type Error = RustraError;
    fn serialize_field<T: ser::Serialize + ?Sized>(&mut self, _value: &T) -> Result<()> {
        Err(error("map keys must be strings"))
    }
    fn end(self) -> Result<()> {
        Err(error("map keys must be strings"))
    }
}

impl ser::SerializeTupleVariant for Unimpl {
    type Ok = ();
    type Error = RustraError;
    fn serialize_field<T: ser::Serialize + ?Sized>(&mut self, _value: &T) -> Result<()> {
        Err(error("map keys must be strings"))
    }
    fn end(self) -> Result<()> {
        Err(error("map keys must be strings"))
    }
}

impl ser::SerializeMap for Unimpl {
    type Ok = ();
    type Error = RustraError;
    fn serialize_key<T: ser::Serialize + ?Sized>(&mut self, _key: &T) -> Result<()> {
        Err(error("map keys must be strings"))
    }
    fn serialize_value<T: ser::Serialize + ?Sized>(&mut self, _value: &T) -> Result<()> {
        Err(error("map keys must be strings"))
    }
    fn end(self) -> Result<()> {
        Err(error("map keys must be strings"))
    }
}

impl ser::SerializeStruct for Unimpl {
    type Ok = ();
    type Error = RustraError;
    fn serialize_field<T: ser::Serialize + ?Sized>(
        &mut self,
        _key: &'static str,
        _value: &T,
    ) -> Result<()> {
        Err(error("map keys must be strings"))
    }
    fn end(self) -> Result<()> {
        Err(error("map keys must be strings"))
    }
}

impl ser::SerializeStructVariant for Unimpl {
    type Ok = ();
    type Error = RustraError;
    fn serialize_field<T: ser::Serialize + ?Sized>(
        &mut self,
        _key: &'static str,
        _value: &T,
    ) -> Result<()> {
        Err(error("map keys must be strings"))
    }
    fn end(self) -> Result<()> {
        Err(error("map keys must be strings"))
    }
}

/// struct 직렬화 — 프로퍼티 declaration 순서, 선택 필드 presence 태그. 유도
/// 코드는 필드를 declaration 순서로 부르므로, `next` 이전의 건너뛴(optional
/// 이며 호출되지 않은) 필드의 presence 0 을 제자리에 보충한다 — Value 경로의
/// `encode_struct_ir` 와 동일한 바이트 순서. optional 필드 값은 임시 버퍼로
/// 직렬화해 presence 바이트가 Some/None 에 맞게 앞에 오도록 한다.
struct SerStruct<'s, 'w, 'b> {
    writer: &'s mut Writer<'w>,
    fields: &'b [IrField],
    required: &'b [bool],
    next: usize,
    limits: ComplexCodecLimits,
    depth: usize,
}

impl<'s, 'w, 'b> SerializeStruct for SerStruct<'s, 'w, 'b> {
    type Ok = ();
    type Error = RustraError;

    fn serialize_field<T: ser::Serialize + ?Sized>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<()> {
        let Some(index) = self.fields.iter().position(|field| field.name == key) else {
            return Ok(()); // 스키마에 없는 필드 — Value 경로와 동일하게 무시.
        };
        // 호출되지 않은 앞선 optional 필드의 presence 0 보충.
        while self.next < index {
            if !self.required[self.next] {
                self.writer.byte(0)?;
            }
            self.next += 1;
        }
        self.next = index + 1;
        if self.required[index] {
            return value.serialize(Ser {
                writer: self.writer,
                ir: &self.fields[index].node,
                limits: self.limits,
                depth: self.depth,
            });
        }
        // optional — 값 직렬화를 버퍼링해 presence 바이트가 값과 인접하도록.
        let mut buffer = Writer::new(self.limits);
        value.serialize(Ser {
            writer: &mut buffer,
            ir: &self.fields[index].node,
            limits: self.limits,
            depth: self.depth,
        })?;
        self.writer.byte(1)?;
        self.writer.push(&buffer.finish())
    }

    fn end(mut self) -> Result<()> {
        while self.next < self.fields.len() {
            let index = self.next;
            self.next += 1;
            if self.required[index] {
                return Err(error(format!(
                    "missing required field {}",
                    self.fields[index].name
                )));
            }
            self.writer.byte(0)?;
        }
        Ok(())
    }
}

/// struct variant 직렬화 — 판별자 필드는 와이어에서 변형 인덱스로 대체되므로
/// 유도 코드가 판별자 키를 건네도 무시하고 본체 필드만 declaration 순서로
/// 기록한다(원본 encode_struct 의 skip_key 와 동일). presence 보충은
/// [`SerStruct`] 와 동일하다.
struct SerStructVariant<'s, 'w, 'b> {
    writer: &'s mut Writer<'w>,
    fields: &'b [IrField],
    required: &'b [bool],
    next: usize,
    limits: ComplexCodecLimits,
    depth: usize,
}

impl<'s, 'w, 'b> SerializeStructVariant for SerStructVariant<'s, 'w, 'b> {
    type Ok = ();
    type Error = RustraError;

    fn serialize_field<T: ser::Serialize + ?Sized>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<()> {
        let Some(index) = self.fields.iter().position(|field| field.name == key) else {
            return Ok(());
        };
        while self.next < index {
            if !self.required[self.next] {
                self.writer.byte(0)?;
            }
            self.next += 1;
        }
        self.next = index + 1;
        if self.required[index] {
            return value.serialize(Ser {
                writer: self.writer,
                ir: &self.fields[index].node,
                limits: self.limits,
                depth: self.depth,
            });
        }
        let mut buffer = Writer::new(self.limits);
        value.serialize(Ser {
            writer: &mut buffer,
            ir: &self.fields[index].node,
            limits: self.limits,
            depth: self.depth,
        })?;
        self.writer.byte(1)?;
        self.writer.push(&buffer.finish())
    }

    fn end(mut self) -> Result<()> {
        while self.next < self.fields.len() {
            let index = self.next;
            self.next += 1;
            if self.required[index] {
                return Err(error(format!(
                    "missing required field {}",
                    self.fields[index].name
                )));
            }
            self.writer.byte(0)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::complex_codec::complex_codec_encode_object::{
        complex_encode, test_only_complex_decode,
    };
    use serde::Deserialize;
    use serde_json::json;
    use std::collections::BTreeMap;

    fn limits() -> ComplexCodecLimits {
        ComplexCodecLimits {
            max_depth: 32,
            max_payload_bytes: 4096,
            max_collection_length: 1000,
        }
    }

    /// Status oneOf — struct 변형(newtype, UnwrapSingle)과 유닛 변형(EnumFirst).
    /// 스키마는 기존 와이어 테스트의 모양(기본 enum 태그)을 따른다.
    #[derive(Debug, PartialEq, serde::Serialize, Deserialize)]
    enum Status {
        Active { level: i64 },
        Idle,
    }

    #[derive(Debug, PartialEq, serde::Serialize, Deserialize)]
    struct Payload {
        status: Status,
    }

    #[test]
    fn round_trips_one_of_newtype_and_unit_variant() {
        let schema = json!({
            "type": "object",
            "properties": {
                "status": { "oneOf": [
                    {"type": "object", "properties": {"Active": {"type": "object", "properties": {"level": {"type": "integer"}}, "required": ["level"]}}, "required": ["Active"]},
                    {"type": "string", "enum": ["Idle"]}
                ]}
            },
            "required": ["status"]
        });
        let definitions = json!({});
        assert!(crate::complex_codec::complex_schema_supported(
            &schema,
            &definitions
        ));
        let ir = crate::complex_codec::complex_schema_ir::compile(&schema, &definitions).unwrap();
        assert!(serde_direct_supported(&ir));

        let active = Payload {
            status: Status::Active { level: 9 },
        };
        let idle = Payload {
            status: Status::Idle,
        };

        for input in [active, idle] {
            let value = serde_json::to_value(&input).unwrap();
            let expected = complex_encode(&schema, &definitions, &value, limits()).unwrap();
            let bytes = to_bytes(&input, &ir, limits()).unwrap();
            assert_eq!(bytes, expected, "encode mismatch for {value}");
            let back: Payload = from_bytes(&bytes, &ir, limits()).unwrap();
            assert_eq!(back, input);
            let value_back =
                test_only_complex_decode(&schema, &definitions, &bytes, limits()).unwrap();
            assert_eq!(value, value_back);
        }

        // 잘못된 변형 인덱스 — Value 경로와 동일 에러.
        let bad: Result<Payload> = from_bytes(&[0x7f], &ir, limits());
        assert_eq!(
            bad.unwrap_err().to_string(),
            test_only_complex_decode(&schema, &definitions, &[0x7f], limits())
                .unwrap_err()
                .to_string()
        );
    }

    #[derive(Debug, PartialEq, serde::Serialize, Deserialize)]
    struct Scores {
        scores: BTreeMap<String, Vec<i64>>,
    }

    #[test]
    fn map_bytes_match_value_path() {
        // map 경로 — 정렬된 키 기록이 Value 경로와 동일한지.
        let schema = json!({
            "type": "object",
            "properties": {"scores": {"type": "object", "additionalProperties": {"type": "array", "items": {"type": "integer", "format": "int64"}}}},
            "required": ["scores"]
        });
        let definitions = json!({});
        let ir = crate::complex_codec::complex_schema_ir::compile(&schema, &definitions).unwrap();

        let input = Scores {
            scores: BTreeMap::from([("z".into(), vec![1, -2, 300]), ("a".into(), vec![])]),
        };
        let value = serde_json::to_value(&input).unwrap();
        let expected = complex_encode(&schema, &definitions, &value, limits()).unwrap();
        let bytes = to_bytes(&input, &ir, limits()).unwrap();
        assert_eq!(bytes, expected);

        let back: Scores = from_bytes(&bytes, &ir, limits()).unwrap();
        assert_eq!(back, input);
        // Value 경로 디코드와 동일 값.
        let value_back = test_only_complex_decode(&schema, &definitions, &bytes, limits()).unwrap();
        assert_eq!(serde_json::to_value(&back).unwrap(), value_back);
    }

    #[derive(Debug, PartialEq, serde::Serialize, Deserialize)]
    struct Node {
        value: i64,
        next: Option<Box<Node>>,
    }

    #[test]
    fn recursive_ref_option_round_trip() {
        let schema = json!({"$ref": "#/definitions/Node"});
        let definitions = json!({"Node": {"type": "object", "properties": {
            "value": {"type": "integer", "format": "int64"},
            "next": {"anyOf": [{"$ref": "#/definitions/Node"}, {"type": "null"}]}
        }, "required": ["value", "next"]}});
        let ir = crate::complex_codec::complex_schema_ir::compile(&schema, &definitions).unwrap();
        assert!(serde_direct_supported(&ir));

        let input = Node {
            value: 1,
            next: Some(Box::new(Node {
                value: -2,
                next: None,
            })),
        };
        let value = serde_json::to_value(&input).unwrap();
        let expected = complex_encode(&schema, &definitions, &value, limits()).unwrap();
        let bytes = to_bytes(&input, &ir, limits()).unwrap();
        assert_eq!(bytes, expected);
        let back: Node = from_bytes(&bytes, &ir, limits()).unwrap();
        assert_eq!(back, input);
    }

    #[test]
    fn absent_optional_field_matches_value_path() {
        let schema = json!({"type": "object", "properties": {
            "value": {"type": "integer", "format": "int64"},
            "label": {"type": "string"}
        }, "required": ["value"]});
        let definitions = json!({});
        let ir = crate::complex_codec::complex_schema_ir::compile(&schema, &definitions).unwrap();

        #[derive(Debug, PartialEq, serde::Serialize, Deserialize)]
        struct WithOption {
            value: i64,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            label: Option<String>,
        }
        let input = WithOption {
            value: 7,
            label: None,
        };
        let value = serde_json::to_value(&input).unwrap();
        let expected = complex_encode(&schema, &definitions, &value, limits()).unwrap();
        let bytes = to_bytes(&input, &ir, limits()).unwrap();
        assert_eq!(bytes, expected);
        let back: WithOption = from_bytes(&bytes, &ir, limits()).unwrap();
        assert_eq!(back, input);
    }

    #[test]
    fn integer_format_int32_round_trip() {
        let schema = json!({"type": "object", "properties": {
            "count": {"type": "integer", "format": "int32"}
        }, "required": ["count"]});
        let definitions = json!({});
        let ir = crate::complex_codec::complex_schema_ir::compile(&schema, &definitions).unwrap();

        #[derive(Debug, PartialEq, serde::Serialize, Deserialize)]
        struct Counting {
            count: i32,
        }
        let input = Counting { count: -5 };
        let value = serde_json::to_value(&input).unwrap();
        let expected = complex_encode(&schema, &definitions, &value, limits()).unwrap();
        let bytes = to_bytes(&input, &ir, limits()).unwrap();
        assert_eq!(bytes, expected);
        let back: Counting = from_bytes(&bytes, &ir, limits()).unwrap();
        assert_eq!(back, input);
    }
}

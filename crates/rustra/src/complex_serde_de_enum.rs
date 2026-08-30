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

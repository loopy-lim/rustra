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
fn peel(ir: &IrNode) -> Result<&IrNode> {
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

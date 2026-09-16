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
        let IrNode::Option { inner } = self.node()? else {
            return Err(error("expected option node"));
        };
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
        let IrNode::Null = self.node()? else {
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
        let IrNode::Boolean = self.node()? else {
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
        self.deserialize_int(visitor)
    }

    fn deserialize_i16<V>(mut self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        self.deserialize_int(visitor)
    }

    fn deserialize_i32<V>(mut self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        self.deserialize_int(visitor)
    }

    fn deserialize_i64<V>(mut self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        self.deserialize_int(visitor)
    }

    fn deserialize_u8<V>(mut self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        self.deserialize_int(visitor)
    }

    fn deserialize_u16<V>(mut self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        self.deserialize_int(visitor)
    }

    fn deserialize_u32<V>(mut self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        self.deserialize_int(visitor)
    }

    fn deserialize_u64<V>(mut self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        self.deserialize_int(visitor)
    }

    fn deserialize_i128<V>(mut self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        self.deserialize_int(visitor)
    }

    fn deserialize_u128<V>(mut self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        self.deserialize_int(visitor)
    }

    fn deserialize_f32<V>(self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        let IrNode::Float { single } = self.node()? else {
            return Err(error("expected number node"));
        };
        let bytes = self.reader.raw(if *single { 4 } else { 8 })?;
        let value = if *single {
            f32::from_le_bytes(bytes.try_into().unwrap())
        } else {
            f64::from_le_bytes(bytes.try_into().unwrap()) as f32
        };
        if !value.is_finite() {
            return Err(error("decoded non-finite number"));
        }
        visitor.visit_f32(value)
    }

    fn deserialize_f64<V>(self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        let IrNode::Float { single } = self.node()? else {
            return Err(error("expected number node"));
        };
        let bytes = self.reader.raw(if *single { 4 } else { 8 })?;
        let value = if *single {
            f64::from(f32::from_le_bytes(bytes.try_into().unwrap()))
        } else {
            f64::from_le_bytes(bytes.try_into().unwrap())
        };
        if !value.is_finite() {
            return Err(error("decoded non-finite number"));
        }
        visitor.visit_f64(value)
    }

    fn deserialize_char<V>(self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        self.deserialize_string(visitor)
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
        let IrNode::String = self.node()? else {
            return Err(error("expected string node"));
        };
        visitor.visit_string(self.reader.string()?)
    }

    fn deserialize_seq<V>(self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        let IrNode::Seq { tuple, items } = self.node()? else {
            return Err(error("expected array node"));
        };
        let length = self.reader.length()?;
        if tuple.as_ref().is_some_and(|nodes| nodes.len() != length) {
            return Err(error("tuple length mismatch"));
        }
        let mut access = DeSeq {
            de: self,
            tuple: tuple.as_deref(),
            items: items.as_deref(),
            position: 0,
            length,
        };
        let result = visitor.visit_seq(&mut access)?;
        if access.position != length {
            return Err(error("tuple length mismatch"));
        }
        Ok(result)
    }

    fn deserialize_map<V>(self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        let ir = self.node()?;
        match ir {
            IrNode::Map { value } => {
                let length = self.reader.length()?;
                visitor.visit_map(DeMap {
                    de: self,
                    mode: MapMode::Entries {
                        value,
                        remaining: length,
                        seen: SeenKeys::new(length),
                    },
                })
            }
            IrNode::Struct { fields, required } => visitor.visit_map(DeMap {
                de: self,
                mode: MapMode::Struct {
                    fields,
                    required,
                    position: 0,
                },
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
        let ir = self.node()?;
        match ir {
            IrNode::OneOf { variants } => {
                let index = self.reader.varint()? as usize;
                let Some(variant) = variants.get(index) else {
                    return Err(error("enum variant index out of range"));
                };
                visitor.visit_enum(OneOfEnum {
                    variant,
                    reader: self.reader,
                    targets: self.targets,
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

    fn deserialize_tuple<V>(self, _len: usize, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        self.deserialize_seq(visitor)
    }

    fn deserialize_tuple_struct<V>(
        self,
        _name: &'static str,
        len: usize,
        visitor: V,
    ) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        self.deserialize_tuple(len, visitor)
    }

    serde::forward_to_deserialize_any! {
        bytes byte_buf identifier ignored_any
    }
}

impl<'de, 'b> De<'de, 'b> {
    /// Keep the wire integer width until serde's visitor checks the target type.
    fn deserialize_int<V>(&mut self, visitor: V) -> Result<V::Value>
    where
        V: Visitor<'de>,
    {
        let IrNode::Int { unsigned } = self.node()? else {
            return Err(error("expected integer node"));
        };
        if *unsigned {
            let value = u64::try_from(self.reader.varint()?)
                .map_err(|_| error("decoded unsigned integer exceeds u64"))?;
            visitor.visit_u64(value)
        } else {
            let value = i64::try_from(self.reader.zigzag()?)
                .map_err(|_| error("decoded integer exceeds JSON safe range"))?;
            visitor.visit_i64(value)
        }
    }
}

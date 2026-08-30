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
fn peel_ser(ir: &IrNode) -> Result<&IrNode> {
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

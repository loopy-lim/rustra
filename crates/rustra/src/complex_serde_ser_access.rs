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
        let value = signed.map(i64::saturate_to_lossy).unwrap_or(unsigned);
        let value =
            u64::try_from(value).map_err(|_| error("unsigned integer must be non-negative"))?;
        writer.varint(u128::from(value))
    } else {
        writer.zigzag(i128::from(unsigned))
    }
}

// `from_*` 이름은 clippy wrong_self_convention(no-self convention)과 충돌한다
// — lossy 시그니처(u64 입력 없음)를 유지하기 위해 네이밍만 피한다.
trait I64Ext {
    fn saturate_to_lossy(self) -> i64;
}
impl I64Ext for i64 {
    fn saturate_to_lossy(self) -> i64 {
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

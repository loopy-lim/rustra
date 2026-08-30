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

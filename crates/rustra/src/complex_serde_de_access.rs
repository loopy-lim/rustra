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

    fn size_hint(&self) -> Option<usize> {
        // A malicious length prefix must not reserve more than the supplied
        // payload. Zero-byte items can safely grow beyond this lower estimate.
        Some((self.length - self.position).min(self.de.reader.remaining()))
    }

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
                    targets: self.de.targets,
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
            targets: self.de.targets,
            ir: items,
            limits: self.de.limits,
            depth: self.de.depth + 1,
        })
        .map(Some)
    }
}

/// Borrow wire keys without allocating for the common zero/one/two-key maps.
enum SeenKeys<'de> {
    None,
    Pair(Option<&'de str>),
    Many(std::collections::HashSet<&'de str>),
}

impl<'de> SeenKeys<'de> {
    fn new(length: usize) -> Self {
        match length {
            0 | 1 => Self::None,
            2 => Self::Pair(None),
            // Bound reservation for a large declaration with truncated bytes.
            _ => Self::Many(std::collections::HashSet::with_capacity(length.min(64))),
        }
    }

    fn insert(&mut self, key: &'de str) -> bool {
        match self {
            Self::None => true,
            Self::Pair(first) => match first {
                Some(first) => *first != key,
                None => {
                    *first = Some(key);
                    true
                }
            },
            Self::Many(keys) => keys.insert(key),
        }
    }
}

/// MapAccess 모드 — 일반 map(엔트리 반복)과 struct(필드 스냅샷).
enum MapMode<'de> {
    Entries {
        value: &'de std::sync::Arc<IrNode>,
        remaining: usize,
        seen: SeenKeys<'de>,
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
}

impl<'de, 'b> MapAccess<'de> for DeMap<'de, 'b> {
    type Error = RustraError;

    fn next_key_seed<K>(&mut self, seed: K) -> Result<Option<K::Value>>
    where
        K: DeserializeSeed<'de>,
    {
        match &mut self.mode {
            MapMode::Entries {
                remaining, seen, ..
            } => {
                if *remaining == 0 {
                    return Ok(None);
                }
                *remaining -= 1;
                let length = self.de.reader.length()?;
                let key = std::str::from_utf8(self.de.reader.raw(length)?)
                    .map_err(|_| error("invalid UTF-8 string"))?;
                if !seen.insert(key) {
                    return Err(error(format!("duplicate map key {key}")));
                }
                seed.deserialize(StrRef { name: key }).map(Some)
            }
            MapMode::Struct {
                fields,
                required,
                position,
            } => {
                loop {
                    if *position >= fields.len() {
                        return Ok(None);
                    }
                    let index = *position;
                    *position += 1;
                    if !required[index] {
                        match self.de.reader.byte()? {
                            0 => continue,
                            1 => {}
                            _ => return Err(error("invalid optional field presence tag")),
                        }
                    }
                    // Omit absent keys so serde applies Option/default/missing
                    // field semantics exactly as it does for the Value object.
                    let name = fields[index].name.as_str();
                    return seed.deserialize(StrRef { name }).map(Some);
                }
            }
        }
    }

    fn next_value_seed<V>(&mut self, seed: V) -> Result<V::Value>
    where
        V: DeserializeSeed<'de>,
    {
        let (node, depth): (&IrNode, usize) = match &self.mode {
            MapMode::Entries { value, .. } => (&**value, self.de.depth + 1),
            MapMode::Struct {
                fields, position, ..
            } => {
                let index = *position - 1;
                (node_of(&fields[index]), self.de.depth + 1)
            }
        };
        seed.deserialize(De {
            reader: &mut *self.de.reader,
            targets: self.de.targets,
            ir: node,
            limits: self.de.limits,
            depth,
        })
    }
}

fn node_of(field: &IrField) -> &IrNode {
    &field.node
}

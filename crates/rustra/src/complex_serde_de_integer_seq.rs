// Selected only for a direct Int node whose child depth is already safe.
// Other schema/entry shapes retain the generic, lazy Deserializer semantics.
struct IntegerSeq<'s, 'de, 'b, const UNSIGNED: bool> {
    access: &'s mut DeSeq<'de, 'b>,
    ir: &'de IrNode,
}

impl<'de, const UNSIGNED: bool> SeqAccess<'de> for IntegerSeq<'_, 'de, '_, UNSIGNED> {
    type Error = RustraError;

    fn size_hint(&self) -> Option<usize> {
        self.access.size_hint()
    }

    #[inline]
    fn next_element_seed<T: DeserializeSeed<'de>>(&mut self, seed: T) -> Result<Option<T::Value>> {
        let access = &mut *self.access;
        if access.position >= access.length {
            return Ok(None);
        }
        access.position += 1;
        // Do not consume the reader before a custom seed enters a typed method.
        seed.deserialize(IntegerElement::<UNSIGNED> {
            de: De {
                reader: &mut *access.de.reader,
                targets: access.de.targets,
                ir: self.ir,
                limits: access.de.limits,
                depth: access.de.depth + 1,
            },
        })
        .map(Some)
    }
}

struct IntegerElement<'de, 'b, const UNSIGNED: bool> {
    de: De<'de, 'b>,
}

macro_rules! integer_sequence_numbers {
    ($($method:ident),* $(,)?) => {
        $(
            #[inline]
            fn $method<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value> {
                read_integer(self.de.reader, UNSIGNED, visitor)
            }
        )*
    };
}

macro_rules! integer_sequence_delegate {
    ($($method:ident($($argument:ident: $ty:ty),*)),* $(,)?) => {
        $(
            fn $method<V: Visitor<'de>>(self, $($argument: $ty,)* visitor: V) -> Result<V::Value> {
                self.de.$method($($argument,)* visitor)
            }
        )*
    };
}

impl<'de, const UNSIGNED: bool> Deserializer<'de> for IntegerElement<'de, '_, UNSIGNED> {
    type Error = RustraError;

    integer_sequence_numbers! {
        deserialize_i8, deserialize_i16, deserialize_i32, deserialize_i64, deserialize_i128,
        deserialize_u8, deserialize_u16, deserialize_u32, deserialize_u64, deserialize_u128,
    }

    integer_sequence_delegate! {
        deserialize_any(), deserialize_bool(), deserialize_f32(), deserialize_f64(),
        deserialize_char(), deserialize_str(), deserialize_string(), deserialize_bytes(),
        deserialize_byte_buf(), deserialize_option(), deserialize_unit(),
        deserialize_unit_struct(name: &'static str),
        deserialize_newtype_struct(name: &'static str),
        deserialize_seq(), deserialize_tuple(len: usize),
        deserialize_tuple_struct(name: &'static str, len: usize), deserialize_map(),
        deserialize_struct(name: &'static str, fields: &'static [&'static str]),
        deserialize_enum(name: &'static str, variants: &'static [&'static str]),
        deserialize_identifier(), deserialize_ignored_any(),
    }

    fn is_human_readable(&self) -> bool {
        self.de.is_human_readable()
    }
}

#[inline]
fn read_integer<'de, V: Visitor<'de>>(
    reader: &mut Reader<'de>,
    unsigned: bool,
    visitor: V,
) -> Result<V::Value> {
    if unsigned {
        let value = u64::try_from(reader.varint()?)
            .map_err(|_| error("decoded unsigned integer exceeds u64"))?;
        visitor.visit_u64(value)
    } else {
        let value = i64::try_from(reader.zigzag()?)
            .map_err(|_| error("decoded integer exceeds JSON safe range"))?;
        visitor.visit_i64(value)
    }
}

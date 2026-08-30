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

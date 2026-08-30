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

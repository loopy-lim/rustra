/// struct 직렬화 — 프로퍼티 declaration 순서, 선택 필드 presence 태그. 유도
/// 코드는 필드를 declaration 순서로 부르므로, `next` 이전의 건너뛴(optional
/// 이며 호출되지 않은) 필드의 presence 0 을 제자리에 보충한다 — Value 경로의
/// `encode_struct_ir` 와 동일한 바이트 순서. optional 필드 값은 임시 버퍼로
/// 직렬화해 presence 바이트가 Some/None 에 맞게 앞에 오도록 한다.
struct SerStruct<'s, 'w, 'b> {
    writer: &'s mut Writer<'w>,
    fields: &'b [IrField],
    required: &'b [bool],
    next: usize,
    limits: ComplexCodecLimits,
    depth: usize,
}
impl<'s, 'w, 'b> SerializeStruct for SerStruct<'s, 'w, 'b> {
    type Ok = ();
    type Error = RustraError;

    fn serialize_field<T: ser::Serialize + ?Sized>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<()> {
        let Some(index) = self.fields.iter().position(|field| field.name == key) else {
            return Ok(()); // 스키마에 없는 필드 — Value 경로와 동일하게 무시.
        };
        // 호출되지 않은 앞선 optional 필드의 presence 0 보충.
        while self.next < index {
            if !self.required[self.next] {
                self.writer.byte(0)?;
            }
            self.next += 1;
        }
        self.next = index + 1;
        if self.required[index] {
            return value.serialize(Ser {
                writer: self.writer,
                ir: &self.fields[index].node,
                limits: self.limits,
                depth: self.depth,
            });
        }
        // optional — 값 직렬화를 버퍼링해 presence 바이트가 값과 인접하도록.
        let mut buffer = Writer::new(self.limits);
        value.serialize(Ser {
            writer: &mut buffer,
            ir: &self.fields[index].node,
            limits: self.limits,
            depth: self.depth,
        })?;
        self.writer.byte(1)?;
        self.writer.push(&buffer.finish())
    }

    fn end(mut self) -> Result<()> {
        while self.next < self.fields.len() {
            let index = self.next;
            self.next += 1;
            if self.required[index] {
                return Err(error(format!(
                    "missing required field {}",
                    self.fields[index].name
                )));
            }
            self.writer.byte(0)?;
        }
        Ok(())
    }
}

/// struct variant 직렬화 — 판별자 필드는 와이어에서 변형 인덱스로 대체되므로
/// 유도 코드가 판별자 키를 건네도 무시하고 본체 필드만 declaration 순서로
/// 기록한다(원본 encode_struct 의 skip_key 와 동일). presence 보충은
/// [`SerStruct`] 와 동일하다.
struct SerStructVariant<'s, 'w, 'b> {
    writer: &'s mut Writer<'w>,
    fields: &'b [IrField],
    required: &'b [bool],
    next: usize,
    limits: ComplexCodecLimits,
    depth: usize,
}

impl<'s, 'w, 'b> SerializeStructVariant for SerStructVariant<'s, 'w, 'b> {
    type Ok = ();
    type Error = RustraError;

    fn serialize_field<T: ser::Serialize + ?Sized>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<()> {
        let Some(index) = self.fields.iter().position(|field| field.name == key) else {
            return Ok(());
        };
        while self.next < index {
            if !self.required[self.next] {
                self.writer.byte(0)?;
            }
            self.next += 1;
        }
        self.next = index + 1;
        if self.required[index] {
            return value.serialize(Ser {
                writer: self.writer,
                ir: &self.fields[index].node,
                limits: self.limits,
                depth: self.depth,
            });
        }
        let mut buffer = Writer::new(self.limits);
        value.serialize(Ser {
            writer: &mut buffer,
            ir: &self.fields[index].node,
            limits: self.limits,
            depth: self.depth,
        })?;
        self.writer.byte(1)?;
        self.writer.push(&buffer.finish())
    }

    fn end(mut self) -> Result<()> {
        while self.next < self.fields.len() {
            let index = self.next;
            self.next += 1;
            if self.required[index] {
                return Err(error(format!(
                    "missing required field {}",
                    self.fields[index].name
                )));
            }
            self.writer.byte(0)?;
        }
        Ok(())
    }
}

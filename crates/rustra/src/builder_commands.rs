impl PackageBuilder {
    /// `#[command]` 속성으로 정의된 함수를 이름 자동 추론으로 등록합니다.
    ///
    /// 함수 이름에서 `_command` 접미사를 제거한 뒤 lowerCamelCase로 변환하여
    /// 명령 이름으로 사용합니다. 예: `add_numbers` → `addNumbers`
    ///
    /// (감사 #5) `#[command(capability = "...")]` 함수는 이 경로로 등록할 수
    /// 없다 — 그 래퍼는 `unsafe fn` 이라 `F: Fn` 바운드를 통과하지 못하고
    /// [`crate::__private::CommandHandler`]의 계약 메시지가 capability 무음 드랍을
    /// 컴파일 에러로 이름한다. register!/build! 를 사용한다.
    pub fn command_fn<I, O, F>(self, handler: F) -> Self
    where
        I: DeserializeOwned + JsonSchema + 'static,
        O: Serialize + JsonSchema + 'static,
        F: crate::__private::CommandHandler<I, O>,
    {
        let name = command_name_from_handler::<F>();
        self.command(name, handler)
    }

    /// 명령을 지정한 이름으로 등록합니다.
    ///
    /// # 패닉
    ///
    /// 같은 이름의 명령이 이미 등록되어 있으면 패닉합니다.
    pub fn command<I, O, F>(mut self, name: impl Into<String>, handler: F) -> Self
    where
        I: DeserializeOwned + JsonSchema + 'static,
        O: Serialize + JsonSchema + 'static,
        F: crate::__private::CommandHandler<I, O>,
    {
        let name = name.into();
        if self.commands.contains_key(&name) {
            panic!("duplicate command registration: '{name}'");
        }
        let command = build_command::<I, O, F>(self.next_command_id, handler);
        self.commands.insert(name, command);
        self.next_command_id += 1;
        self
    }

    /// 등록된 명령의 Rust doc comment를 스키마와 TypeScript JSDoc으로 보존합니다.
    ///
    /// `#[command]` 매크로가 생성한 메타데이터 상수와 함께 사용하며, 등록되지
    /// 않은 명령 이름은 매크로/빌더 체인의 오류를 숨기지 않도록 즉시 패닉합니다.
    pub fn command_doc(mut self, name: &str, doc: &str) -> Self {
        let command = self
            .commands
            .get_mut(name)
            .unwrap_or_else(|| panic!("command_doc: command '{name}' not registered"));
        let doc = doc.trim();
        if !doc.is_empty() {
            command.description = Some(doc.to_owned());
        }
        self
    }

    /// Register a command with both the normal wire contract and a direct
    /// single-byte-field native path. This is intentionally explicit: only
    /// types implementing the ownership conversion traits can cross this ABI.
    pub fn buffer_command<I, O, F>(mut self, name: impl Into<String>, handler: F) -> Self
    where
        I: BufferCommandInput,
        O: BufferCommandOutput,
        F: crate::__private::CommandHandler<I, O>,
    {
        let name = name.into();
        if self.commands.contains_key(&name) {
            panic!("duplicate command registration: '{name}'");
        }
        let handler = Arc::new(handler);
        let normal_handler = Arc::clone(&handler);
        let mut command =
            build_command::<I, O, _>(self.next_command_id, move |input| normal_handler(input));
        if generated_byte_field_name(&command.input_schema).is_none()
            || generated_byte_field_name(&command.output_schema).is_none()
        {
            panic!(
                "buffer command '{name}' requires input and output schemas with exactly one required Vec<u8> field"
            );
        }
        command.buffer_handler = Some(Arc::new(move |bytes| {
            let input = I::from_buffer(bytes.to_vec());
            handler(input).map(BufferCommandOutput::into_buffer)
        }));
        self.commands.insert(name, command);
        self.next_command_id += 1;
        self
    }

    /// Name-inferred variant of [`PackageBuilder::buffer_command`].
    pub fn buffer_command_fn<I, O, F>(self, handler: F) -> Self
    where
        I: BufferCommandInput,
        O: BufferCommandOutput,
        F: crate::__private::CommandHandler<I, O>,
    {
        let name = command_name_from_handler::<F>();
        self.buffer_command(name, handler)
    }
}

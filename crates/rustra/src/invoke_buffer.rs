fn postcard_uvar_len(mut value: usize) -> usize {
    let mut len = 1;
    while value >= 0x80 {
        value >>= 7;
        len += 1;
    }
    len
}

impl Package {
    /// Invoke a schema-proven single-byte-field command without constructing a
    /// postcard request/response frame. The borrowed input is copied into an
    /// owned Rust value before user code runs and is never retained.
    pub fn invoke_buffer(&self, command_id: u16, bytes: &[u8]) -> crate::Result<Vec<u8>> {
        let wire_size = 2usize
            .saturating_add(postcard_uvar_len(bytes.len()))
            .saturating_add(bytes.len());
        let limit = crate::limits::max_payload_bytes();
        if wire_size > limit {
            return Err(RustraError::payload_too_large(wire_size, limit));
        }
        let command = if self.is_frozen() {
            self.frozen_registry
                .get()
                .and_then(|registry| registry.id_to_command.get(command_id as usize))
                .and_then(Option::as_ref)
                .cloned()
                .ok_or_else(|| RustraError::command_not_found(format!("id:{command_id}")))?
        } else {
            let state = self
                .state
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state
                .id_to_command
                .get(&command_id)
                .ok_or_else(|| RustraError::command_not_found(format!("id:{command_id}")))?
                .clone()
        };
        let Some(handler) = command.buffer_handler.as_ref() else {
            return Err(RustraError::invalid_args(format!(
                "buffer invoke: command id:{command_id} has no buffer handler"
            )));
        };
        self.capability_satisfied(command.as_ref())?;
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            with_state_context(&self.states, || handler(bytes))
        }));
        match outcome {
            Ok(result) => result,
            Err(panic) => Err(RustraError::internal(format!(
                "panic in handler: {}",
                crate::ffi::panic_message(&panic)
            ))),
        }
    }

    /// Whether a command owns the direct byte-buffer handler required by a
    /// native host capability handshake.
    pub fn has_buffer_handler(&self, command_id: u16) -> bool {
        if self.is_frozen() {
            return self
                .frozen_registry
                .get()
                .and_then(|registry| registry.id_to_command.get(command_id as usize))
                .and_then(Option::as_ref)
                .is_some_and(|command| command.buffer_handler.is_some());
        }
        let state = self
            .state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state
            .id_to_command
            .get(&command_id)
            .is_some_and(|command| command.buffer_handler.is_some())
    }

    /// raw 직결 가능 여부 — 호스트가 스키마 없이 폴백 여부를 미리 판정한다.
    /// 입력 슬롯 종류를 함께 돌려준다(호스트가 같은 순서로 비트를 해석).
    /// 잠금 수명에서 벗어나도록 소유 복사본을 반환한다(호출 빈도가 낮다 —
    /// 호스트는 엔진 구성 시 1회 스윕한다).
    pub fn raw_invoke_shape(
        &self,
        command_id: u16,
    ) -> Option<Vec<crate::rkyv_codec::RawFieldKind>> {
        let (has_raw, kinds) = if self.is_frozen() {
            let command = self
                .frozen_registry
                .get()?
                .id_to_command
                .get(command_id as usize)
                .and_then(Option::as_ref)?;
            (
                command.raw_handler.is_some(),
                command.raw_input_kinds.clone(),
            )
        } else {
            let state = self
                .state
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let command = state.id_to_command.get(&command_id)?;
            (
                command.raw_handler.is_some(),
                command.raw_input_kinds.clone(),
            )
        };
        if has_raw { Some(kinds) } else { None }
    }
}

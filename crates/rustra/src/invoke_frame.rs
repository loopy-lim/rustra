impl Package {
    pub fn invoke_frame(&self, payload: &[u8]) -> crate::Result<Vec<u8>> {
        if payload.len() < 2 {
            return Err(RustraError::invalid_args("frame: payload too short"));
        }
        let limit = crate::limits::max_payload_bytes();
        if payload.len() > limit {
            return Err(RustraError::payload_too_large(payload.len(), limit));
        }
        let command_id = u16::from_le_bytes([payload[0], payload[1]]);
        if self.is_frozen() {
            let command = self
                .frozen_registry
                .get()
                .and_then(|registry| registry.id_to_command.get(command_id as usize))
                .and_then(Option::as_ref)
                .ok_or_else(|| RustraError::command_not_found(format!("id:{command_id}")))?;
            return self.invoke_frame_command(command, payload);
        }

        // Mutable dev registry: clone out before running user code so registry
        // mutation from inside a handler cannot deadlock on the read lock.
        let command = {
            let state = self
                .state
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            // 단일 조회 — 과거 id_to_name → commands 이중 조회 + Arc 클론을
            // id_to_command 직접 캐시로 대체했다(등록/교체/해제 시 함께 유지됨).
            state
                .id_to_command
                .get(&command_id)
                .ok_or_else(|| RustraError::command_not_found(format!("id:{command_id}")))?
                .clone()
        };
        self.invoke_frame_command(command.as_ref(), payload)
    }

    /// 스칼라 직결(raw) invoke — FFI 경계에서는 u64 슬롯으로 주고받는다.
    /// raw 핸들러 내부의 stack buffer 기반 postcard 입력/출력 변환은 유지된다.
    /// 대상 명령에 raw 핸들러가 없으면 `command.invalid_args` 를 반환한다.
    /// 실행 오류는 호스트 폴백 신호가 아니다. FFI는 실행 전 raw 핸들러 부재를
    /// 별도로 검사해 폴백을 알리고, 실행 후 오류는 재시도 없이 전달한다.
    pub fn invoke_raw(&self, command_id: u16, slots: &[u64]) -> crate::Result<u64> {
        if self.is_frozen() {
            let command = self
                .frozen_registry
                .get()
                .and_then(|registry| registry.id_to_command.get(command_id as usize))
                .and_then(Option::as_ref)
                .ok_or_else(|| RustraError::command_not_found(format!("id:{command_id}")))?;
            return self.invoke_raw_command(command, command_id, slots);
        }

        // Retain the mutable command, but release its registry lock before
        // capability checks or user code can reenter and mutate the package.
        let command = {
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
        self.invoke_raw_command(command.as_ref(), command_id, slots)
    }

    fn invoke_raw_command(
        &self,
        command: &Command,
        command_id: u16,
        slots: &[u64],
    ) -> crate::Result<u64> {
        let Some(raw) = command.raw_handler.as_ref() else {
            return Err(RustraError::invalid_args(format!(
                "raw invoke: command id:{command_id} has no raw handler"
            )));
        };
        self.capability_satisfied(command)?;
        // 핸들러 패닉 가드 — 다른 invoke 경로와 동일 계약(internal 정규화).
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            with_state_context(&self.states, || raw(slots))
        }));
        match outcome {
            Ok(result) => result,
            Err(panic) => Err(RustraError::internal(format!(
                "panic in handler: {}",
                crate::ffi::panic_message(&panic)
            ))),
        }
    }
}

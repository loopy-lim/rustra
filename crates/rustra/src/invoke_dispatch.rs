impl Package {
    #[inline]
    fn invoke_rkyv_v2_command(&self, command: &Command, payload: &[u8]) -> crate::Result<Vec<u8>> {
        // Runtime Authority: deny-by-default — capability 가 요구되는데 부여되지
        // 않았으면 바이너리 핸들러(또는 JSON fallback)를 호출하지 않고
        // capability.denied 를 반환한다. 에러는 rkyv V2 error wire 로 인코딩되어
        // JS RustraCommandError("capability.denied") 로 재구성된다.
        self.capability_satisfied(command)?;

        // panic guard — 이 디스패치는 FFI 진입점(extern "C", nounwind) 에서 직접
        // 호출된다. 핸들러 패닉이 그대로 unwinding 하면 경계에서 프로세스 abort 다
        // (RN 호스트 크래시). JSON/postcard FFI 의 `ffi::with_panic_guard` 와 동일한
        // 계약으로, 패닉을 `internal` 에러로 정규화해 rkyv V2 에러 프레임으로 반환한다.
        // AssertUnwindSafe: 클로저가 캡처한 값(command/payload) 은 패닉 후 다시
        // 사용되지 않는다 — 결과만 반환한다.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            with_state_context(&self.states, || {
                // Fast path: use typed postcard binary handler (bypasses JSON Value entirely)
                if let Some(ref handler) = command.rkyv_v2_handler {
                    return handler(payload);
                }

                // Fallback: legacy JSON-based path for commands without binary handler
                if !command.rkyv_v2_tier3 && payload.len() < 8 {
                    return Err(RustraError::invalid_args("rkyv v2: payload too short"));
                }

                let params = (command.rkyv_v2_decode)(payload)?;
                let result = (command.invoke)(params)?;
                Ok((command.rkyv_v2_encode_response)(&result))
            })
        }));
        match outcome {
            Ok(result) => result,
            Err(panic) => Err(RustraError::internal(format!(
                "panic in handler: {}",
                crate::ffi::panic_message(&panic)
            ))),
        }
    }

    /// rkyv V2 caller-buffer 경로. 정적 postcard command는 호스트가 제공한
    /// slice에 직접 응답을 기록해 Rust heap allocation과 memcpy를 없앤다.
    pub fn invoke_rkyv_v2_into(
        &self,
        payload: &[u8],
        target: &mut [u8],
    ) -> crate::Result<DirectResponse> {
        if payload.len() < 2 {
            return Err(RustraError::invalid_args("rkyv v2: payload too short"));
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
            return self.invoke_rkyv_v2_into_command(command, payload, target);
        }

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
        self.invoke_rkyv_v2_into_command(command.as_ref(), payload, target)
    }

    fn invoke_rkyv_v2_into_command(
        &self,
        command: &Command,
        payload: &[u8],
        target: &mut [u8],
    ) -> crate::Result<DirectResponse> {
        let Some(handler) = command.rkyv_v2_into_handler.as_ref() else {
            return self
                .invoke_rkyv_v2_command(command, payload)
                .map(DirectResponse::Buffered);
        };
        self.capability_satisfied(command)?;
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            with_state_context(&self.states, || handler(payload, target))
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

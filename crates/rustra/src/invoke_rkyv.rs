impl Package {
    pub fn invoke_rkyv_v2(&self, payload: &[u8]) -> crate::Result<Vec<u8>> {
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
            return self.invoke_rkyv_v2_command(command, payload);
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
        self.invoke_rkyv_v2_command(command.as_ref(), payload)
    }

    /// 스칼라 직결(raw) invoke — postcard 왕복 없이 u64 슬롯으로 주고받는다.
    /// 대상 명령이 raw 직결 조건(스칼라 1..3 입력 + 단일 스칼라/unit 출력)을
    /// 만족하지 않으면 `command.invalid_args` 를 반환해 호출자(호스트 JSI)가
    /// by-id 경로로 폴백하게 한다. 와이어 포맷은 존재하지 않는다(계약이 슬롯
    /// 배열 자체) — 코덱 게이트 대상 아니다.
    pub fn invoke_raw(&self, command_id: u16, slots: &[u64]) -> crate::Result<u64> {
        // 양쪽 가지 모두 Arc 클론으로 통일 — 핸들러 실행은 잠금 밖에서.
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
        let Some(raw) = command.raw_handler.as_ref() else {
            return Err(RustraError::invalid_args(format!(
                "raw invoke: command id:{command_id} has no raw handler"
            )));
        };
        self.capability_satisfied(command.as_ref())?;
        // 핸들러 패닉 가드 — 다른 invoke 경로와 동일 계약(internal 정규화).
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| raw(slots)));
        match outcome {
            Ok(result) => result,
            Err(panic) => Err(RustraError::internal(format!(
                "panic in handler: {}",
                crate::ffi::panic_message(&panic)
            ))),
        }
    }
}

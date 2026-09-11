// typed invoke — 이름 기반 조회 + postcard 타입 입출력 래퍼.
//
// 의도적으로 dispatch/wire 경로를 이원화하지 않는다. invoke_json 처럼 별도의
// JSON 실행 경로를 두는 대신, 조회한 Command 의 command_id 로 rkyv V2 요청
// 프레임 `[id: u16 LE @0][postcard(I) @2]` 을 조립해 invoke_rkyv_v2 의 단일
// dispatch 경로로 보낸다. 즉 dispatch 진실의 원천은 invoke_rkyv_v2 하나며,
// 응답도 JS 코덱이 보는 것과 완전히 동일한 `[ok:1][7B reserved][postcard(O) @8]`
// 프레임이라 Rust↔TS 바이너리 호환이 코드 중복 없이 자동 유지된다.
impl Package {
    /// 이름으로 명령을 조회해 postcard 타입 입출력으로 호출합니다.
    ///
    /// 명령 조회는 [`invoke_json`](Package::invoke_json) 과 동일한 frozen/mutable
    /// 이중 경로를 따릅니다(제품 경로는 snapshot borrow, 개발 경로는 clone-out).
    /// 실행은 `command_id` 로 만든 rkyv V2 요청을
    /// [`invoke_rkyv_v2`](Package::invoke_rkyv_v2) 로 돌리는 단일 dispatch 경로이며,
    /// 응답 프레임은 [`decode_rkyv_v2_response`](crate::decode_rkyv_v2_response) 로
    /// 벗겨 postcard 역직렬화합니다.
    ///
    /// 핸들러가 반환한 [`RustraError`](crate::RustaError) 는 프레임으로 감싸지지
    /// 않고 `code`/`message` 가 그대로 보존되어 전파됩니다(에러 프레임 인코딩은
    /// FFI 경계의 책임). 참고: postcard 미지원 형태(Tier 3 JSON 전용) 명령은
    /// 요청 파싱이 postcard 바이트에서 실패하므로 typed 호출 대상이 아닙니다.
    pub fn invoke_typed<I: serde::Serialize, O: serde::de::DeserializeOwned>(
        &self,
        name: &str,
        input: &I,
    ) -> crate::Result<O> {
        if self.is_frozen() {
            // 제품 경로 — invoke_json 과 동일: immutable snapshot 안의 Command 를
            // 직접 빌린다. 매 호출 Arc clone/drop 은 refcount cache line 경합으로
            // 병렬 처리량을 역확장시키므로 frozen hot path 에서는 피한다.
            let command = self
                .frozen_registry
                .get()
                .and_then(|registry| registry.commands.get(name))
                .ok_or_else(|| self.command_not_found(name))?;
            return self.invoke_typed_command(command, input);
        }

        // 개발용 mutable 경로 — 핸들러 실행 중 잠금을 hold 하지 않도록
        // Command 를 clone-out 한다(재진입 register/unregister 교착 방지).
        let command = {
            let state = self
                .state
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state
                .commands
                .get(name)
                .ok_or_else(|| self.command_not_found(name))?
                .clone()
        };
        self.invoke_typed_command(command.as_ref(), input)
    }

    #[inline]
    fn invoke_typed_command<I: serde::Serialize, O: serde::de::DeserializeOwned>(
        &self,
        command: &Command,
        input: &I,
    ) -> crate::Result<O> {
        // 요청 프레임 `[id: u16 LE @0][postcard(I) @2]` — TS codec.encode 와 동일 와이어.
        let request = postcard::to_extend(input, command.command_id.to_le_bytes().to_vec())
            .map_err(|error| {
                RustraError::internal(format!("invoke_typed: input encode failed: {error}"))
            })?;

        // 단일 dispatch 경로로 실행하고 응답 프레임 헤더(ok + 7B reserved)를 벗긴다.
        let frame = self.invoke_rkyv_v2(&request)?;
        let body = decode_rkyv_v2_response(&frame)?;
        postcard::from_bytes::<O>(body).map_err(|error| {
            RustraError::invalid_args(format!("invoke_typed: output decode failed: {error}"))
        })
    }
}

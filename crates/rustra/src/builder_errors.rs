// 커맨드별 도메인 에러 빌더 — `command_errors` / `errors_meta_if`.
//
// 선언은 schema.json "errors" 필드와 TS 코드젠(타입 가드)의 원천이며 런타임
// 와이어({code, message})는 무변경이다. 핸들러 반환값을 선언 집합과 대조하는
// 런타임 검증은 하지 않는다 — 선언은 계약 문서이고 드리프트 검출은
// `rustra diff`/contract 게이트 몫이다(docs/plans/2026-09-07-typed-errors-design.md B/E절).

impl PackageBuilder {
    /// 커맨드에 에러 코드 선언을 추가한다. register!/build! 체인 뒤에도 붙을 수
    /// 있다. 선언은 schema.json `errors` 필드와 TS 코드젠(타입 가드)의 원천 —
    /// 런타임 와이어는 무변경(`{code, message}`).
    ///
    /// # 패닉
    ///
    /// - 명령이 등록되어 있지 않은 경우 (빌더 체인 오류 은폐 방지)
    /// - `errors` 가 빈 슬라이스인 경우
    /// - 코드가 `^[a-z][a-z0-9_.]*$` 를 위반한 경우
    /// - 같은 명령 내 중복 코드
    pub fn command_errors(mut self, name: &str, errors: &[CommandErrorVariant]) -> Self {
        let command = self
            .commands
            .get_mut(name)
            .unwrap_or_else(|| panic!("command_errors: command '{name}' is not registered"));
        if errors.is_empty() {
            panic!("command_errors('{name}'): errors must not be empty");
        }
        for (index, error) in errors.iter().enumerate() {
            crate::error::validate_error_code(error.code());
            if errors[..index]
                .iter()
                .any(|prev| prev.code() == error.code())
            {
                panic!(
                    "command_errors('{name}'): duplicate error code '{}'",
                    error.code()
                );
            }
        }
        command.error_variants = errors.to_vec();
        self
    }

    /// `#[command(error(...))]` 메타데이터 연결 — `None`(선언 없는 명령)이면
    /// no-op, `Some`이면 [`command_errors`](Self::command_errors)와 동일하게
    /// 기록한다. register!/build! 체인이 항상 호출한다(platform_meta_if 관례).
    pub fn errors_meta_if(
        self,
        name: &str,
        errors: Option<&'static [CommandErrorVariant]>,
    ) -> Self {
        let Some(errors) = errors else {
            return self;
        };
        self.command_errors(name, errors)
    }
}

impl PackageBuilder {
    /// Runtime Authority: 이미 등록된 명령에 capability 요구를 부여한다.
    ///
    /// `name` 명령은 `cap` 가 `Package::grant_capability` 로 부여되기 전까지
    /// deny-by-default 로 실행 거부된다. 빌더 체인에서 `.command(...)` 이후
    /// `.build()` 이전에 호출한다.
    ///
    /// # 패닉
    ///
    /// `name` 이 등록되어 있지 않으면 패닉한다.
    pub fn require_capability(mut self, name: &str, cap: &'static str) -> Self {
        let command = self
            .commands
            .get_mut(name)
            .unwrap_or_else(|| panic!("require_capability: command '{name}' not registered"));
        command.required_capability = Some(cap);
        self
    }

    /// `#[command(capability = "...")]` 메타 상수를 받아 조건부 require 로 이어
    /// 붙인다 — `register!`/`build!` 매크로가 사용한다.
    ///
    /// `cap: Option<&'static str>` 이 `Some` 이면 [`require_capability`](Self::require_capability)
    /// 와 동일하게 동작하고, `None` 이면 아무 일도 하지 않는다(메타 상수는 매크로가
    /// 항상 생성하므로 capability 없는 명령도 그대로 통과한다). 문자열 이름 재결합을
    /// 매크로가 파생한 심벌 쌍으로 대체해, 오타가 났다면 **컴파일** 에러로 드러난다.
    pub fn require_capability_if(mut self, name: &str, cap: Option<&'static str>) -> Self {
        if let Some(cap) = cap {
            let command = self
                .commands
                .get_mut(name)
                .unwrap_or_else(|| panic!("require_capability: command '{name}' not registered"));
            command.required_capability = Some(cap);
        }
        self
    }

    /// (T2, OTA) 구 클라이언트의 command_id 를 현재 명령에 alias 로 수용한다.
    ///
    /// JS 번들만 OTA 갱신되는 배포에서 **구 JS + 신 네이티브** 조합이 발생한다.
    /// rkyv V2 와이어에는 command_id 만 있으므로(이름 없음), 신 네이티브가
    /// 구 코드젠이 구운 id 를 alias 로 수용하는 것이 호환을 유지하는 유일한
    /// 경로다. alias 는 **부가적 라우팅 항목**이다 — 대상 명령의 실제
    /// command_id(신 클라이언트 코드젠이 굽는 값)는 그대로 두고, 구 id 가
    /// `id_to_name` 에서 같은 명령을 가리키게 한다.
    ///
    /// 대상 명령은 이 호출 시점에 등록되어 있어도 되고, 이후 `.command()` 로
    /// 등록될 예정이어도 된다(선언 순서 자유). 검증은 두 시점에 나뉜다:
    ///
    /// **선언 시점 즉시 패닉** — (a) 같은 alias id 를 다른 명령에 이미
    /// 선언함, (b) 같은 명령에 같은 alias id 를 중복 선언함(단순 유지를 위해
    /// 전부 거부), (c) 대상 명령이 이미 등록된 상태에서 그 id 가 **다른
    /// 등록된 명령의 실제 command_id** 인 경우 — 이 마지막은 조용한
    /// 섀도잉(구 id 가 엉뚱한 명령에 디스패치)이므로 그 자리에서 거부한다.
    ///
    /// **`build()` 시점 패닉** — (d) 대상 명령이 끝내 등록되지 않음.
    ///
    /// 대상이 아직 등록되지 않은 전방 선언에서 그 id 를 다른 명령이 점유하게
    /// 되면(스키마 성장으로 id 가 밀린 OTA 시나리오), `build()` 가 점유
    /// 명령을 fresh id 로 밀어내고 구 id 를 alias 항목으로 채운다 — 점유
    /// 명령은 신 규칙(삽입)이므로 아무도 그 id 를 알지 못하고, 이동이 안전하다.
    ///
    /// 선언 순서 관례: 성장 시나리오(신규 명령 삽입)에서는 alias 를 command
    /// 등록보다 먼저 선언한다 — 이후 선언 시 선언 시점 검증이 즉시 패닉한다.
    pub fn alias_command_id(mut self, command: &str, legacy_id: u16) -> Self {
        for (existing_cmd, existing_id) in &self.id_aliases {
            if *existing_id != legacy_id {
                continue;
            }
            if existing_cmd != command {
                panic!(
                    "alias_command_id: legacy id {legacy_id} is already aliased to \
                     '{existing_cmd}'; cannot also alias it to '{command}'"
                );
            }
            panic!("alias_command_id: duplicate alias id {legacy_id} for command '{command}'");
        }
        // 대상이 이미 등록된 상태라면, legacy_id 가 다른 등록된 명령의 실제
        // command_id 인지 지금 확인할 수 있다 — 확인 가능한 충돌은 조기 패닉.
        if self.commands.contains_key(command)
            && let Some((occupant, _)) = self
                .commands
                .iter()
                .find(|(_, cmd)| cmd.command_id == legacy_id)
            && occupant.as_str() != command
        {
            panic!(
                "alias_command_id: legacy id {legacy_id} is the real command_id of \
                 '{occupant}'; aliasing it to '{command}' would shadow '{occupant}'"
            );
        }
        self.id_aliases.push((command.to_string(), legacy_id));
        self
    }
}

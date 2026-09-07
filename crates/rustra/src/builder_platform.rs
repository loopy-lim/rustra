// 플랫폼 특화 명령 빌더 — `platform_command` / `platform_command_impl`.
//
// 설계(`docs/plans/2026-09-07-platform-interop-stabilization-design.md`):
// 등록은 **전 플랫폼에서 무조건** 일어난다. command_id·schema.json·계약 해시가
// 플랫폼 무관하게 동일해야 rkyv V2 by-id 디스패치와 교차 검증이 살아있기 때문이다.
// 미지원 플랫폼에는 `platform.unavailable` 을 반환하는 스텁 핸들러가 등록되고,
// 지원 플랫폼은 [`PackageBuilder::platform_command_impl`] 로 스텁을 실제 구현으로 교체한다.

impl PackageBuilder {
    /// 플랫폼 특화 명령을 **전 플랫폼에서** 등록한다.
    ///
    /// 타입 파라미터 `I`/`O` 는 플랫폼 조건 없이 존재해야 한다 — cfg 로 감싸지는
    /// 구현(fn 본체)만 [`PackageBuilder::platform_command_impl`] 로 주입한다:
    ///
    /// ```rust,ignore
    /// builder.platform_command::<(), NativeWindowInfo>(
    ///     "nativeWindowInfo",
    ///     &[Platform::Windows, Platform::Macos],
    /// );
    /// #[cfg(any(target_os = "windows", target_os = "macos"))]
    /// let builder = builder.platform_command_impl("nativeWindowInfo", native_window_info);
    /// ```
    ///
    /// 지원 목록에 현재 플랫폼이 있는데 [`PackageBuilder::platform_command_impl`] 이
    /// 빠지면 `build()` 가 패닉한다(조용한 스텁 방치 방지). 현재 플랫폼이 목록에
    /// 없으면 스텁이 유지되고, 런타임 호출은 `platform.unavailable` 을 반환한다.
    ///
    /// # 패닉
    ///
    /// - 같은 이름이 이미 등록된 경우
    /// - `platforms` 가 빈 경우 (전 플랫폼 명령은 [`PackageBuilder::command`] 사용)
    pub fn platform_command<I, O>(
        mut self,
        name: impl Into<String>,
        platforms: &[crate::platform::Platform],
    ) -> Self
    where
        I: DeserializeOwned + JsonSchema + 'static,
        O: Serialize + JsonSchema + 'static,
    {
        let name = name.into();
        if self.commands.contains_key(&name) {
            panic!("duplicate command registration: '{name}'");
        }
        if platforms.is_empty() {
            panic!(
                "platform_command('{name}'): platforms must not be empty — \
                 use .command(...) for all-platform commands"
            );
        }
        // 정규화 — Platform 선언 순서(= schema.json 표기 순서)로 정렬·중복 제거.
        let mut platforms = platforms.to_vec();
        platforms.sort();
        platforms.dedup();

        let stub_name = name.clone();
        let supported = platforms.clone();
        let stub = move |_input: I| -> crate::Result<O> {
            Err(RustraError::platform_unavailable(&stub_name, &supported))
        };
        let mut command = build_command::<I, O, _>(self.next_command_id, stub);
        command.platforms = platforms.clone();
        self.commands.insert(name.clone(), command);
        self.platform_command_declarations.insert(name, platforms);
        self.next_command_id += 1;
        self
    }

    /// [`PackageBuilder::platform_command`] 으로 선언한 명령에 현재 플랫폼용
    /// 구현을 주입한다. command_id·스키마·capability 는 스텁에서 유지된다.
    ///
    /// # 패닉
    ///
    /// - 선언되지 않은(또는 `platform_command` 이 아닌) 명령
    /// - 현재 플랫폼이 선언된 지원 목록에 없는 경우 (cfg 가 새 구현을
    ///   실수로 다른 플랫폼에서 켠 경우)
    /// - 스텁과 `I`/`O` 타입이 일치하지 않는 경우 (스키마가 바뀌는 교체 방지)
    pub fn platform_command_impl<I, O, F>(mut self, name: &str, handler: F) -> Self
    where
        I: DeserializeOwned + JsonSchema + 'static,
        O: Serialize + JsonSchema + 'static,
        F: crate::__private::CommandHandler<I, O>,
    {
        let declared = self
            .platform_command_declarations
            .get(name)
            .unwrap_or_else(|| {
                panic!(
                    "platform_command_impl('{name}'): command is not declared by command_platform \
                 (register a plain handler with .command(...) instead)"
                )
            });
        let current = crate::platform::Platform::current();
        if let Some(current) = current
            && !declared.contains(&current)
        {
            panic!(
                "platform_command_impl('{name}'): current platform '{current}' is not in the \
                 declared platforms {declared:?} — check the #[cfg] guard"
            );
        }
        let existing = self
            .commands
            .get(name)
            .expect("platform_command declares the command");
        let command_id = existing.command_id;
        let description = existing.description.clone();
        let required_capability = existing.required_capability;
        let platforms = existing.platforms.clone();

        let mut command = build_command::<I, O, F>(command_id, handler);
        if command.input_type != existing.input_type || command.output_type != existing.output_type
        {
            panic!(
                "platform_command_impl('{name}'): handler types mismatch the declaration — \
                 declared input '{}' / output '{}' but the impl provides \
                 input '{}' / output '{}' (schema must stay identical across platforms)",
                existing.input_type, existing.output_type, command.input_type, command.output_type
            );
        }
        command.description = description;
        command.required_capability = required_capability;
        command.platforms = platforms;
        self.commands.insert(name.to_string(), command);
        self.implemented_platform_commands.insert(name.to_string());
        self
    }

    /// `#[command(platform(...))]` 메타데이터 연결 — register!/build! 체인이
    /// 항상 호출한다. `None`(전 플랫폼 명령)이면 no-op, `Some`이면 해당 명령의
    /// 스키마 `platforms` 필드를 채운다. 핸들러는 매크로가 cfg 배타적으로
    /// 생성한 진짜 구현/스텁이 이미 `.command` 로 등록된 상태다.
    ///
    /// # 패닉
    ///
    /// 명령이 등록되지 않은 경우 (매크로 체인 오류를 숨기지 않기 위해).
    pub fn platform_meta_if(
        mut self,
        name: &str,
        platforms: Option<&'static [crate::platform::Platform]>,
    ) -> Self {
        let Some(platforms) = platforms else {
            return self;
        };
        let command = self
            .commands
            .get_mut(name)
            .unwrap_or_else(|| panic!("platform_meta_if: command '{name}' is not registered"));
        command.platforms = platforms.to_vec();
        self
    }

    /// `build()` 진입 시점 정합 — 지원 플랫폼에서 구현이 빠진 선언은 패닉.
    pub(crate) fn validate_platform_command_impls(&self) {
        let current = crate::platform::Platform::current();
        let Some(current) = current else {
            return; // 미지원 대상(예: wasm) — 스텁 유지가 정상
        };
        for (name, platforms) in &self.platform_command_declarations {
            if platforms.contains(&current) && !self.implemented_platform_commands.contains(name) {
                panic!(
                    "platform_command('{name}') declares support for '{current}' but \
                     platform_command_impl was never called — the command would silently stay a \
                     platform.unavailable stub on a supported platform"
                );
            }
        }
    }
}

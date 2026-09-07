// 커맨드별 디바이스 역량 빌더 — `command_devices` / `devices_meta_if`.
//
// 선언은 schema.json "devices" 필드(단순 문자열 배열)의 원천이다. 런타임 자동
// 게이팅은 하지 않는다 — 폐쇄 검사가 개방 런타임을 거짓으로 막지 않도록 선언은
// 계약 문서로만 소비된다(설계 B/F절). 역량 가용성/권한 조회는 호스트 표면
// 몫이고, OS 권한 요청 역시 point-of-use 에서 호스트가 한다.

impl PackageBuilder {
    /// 커맨드가 전제하는 디바이스 역량을 선언한다. register!/build! 체인 뒤에도
    /// 붙을 수 있다. 선언은 schema.json `devices` 필드의 원천 — 런타임 자동
    /// 게이팅은 없다(선언은 계약 문서다).
    ///
    /// ```rust,ignore
    /// builder.command_devices(
    ///     "scan_tags",
    ///     &[DeviceCapability::new("camera"), DeviceCapability::new("bluetooth")],
    /// );
    /// ```
    ///
    /// # 패닉
    ///
    /// - 명령이 등록되어 있지 않은 경우 (빌더 체인 오류 은폐 방지)
    /// - `devices` 가 빈 슬라이스인 경우
    /// - 토큰이 카탈로그(`DeviceCapability::ALL`) 밖인 경우 (오타 loud-fail)
    /// - 같은 명령 내 중복 토큰
    pub fn command_devices(
        mut self,
        name: &str,
        devices: &[crate::device_capabilities::DeviceCapability],
    ) -> Self {
        let command = self
            .commands
            .get_mut(name)
            .unwrap_or_else(|| panic!("command_devices: command '{name}' is not registered"));
        if devices.is_empty() {
            panic!("command_devices('{name}'): devices must not be empty");
        }
        for (index, capability) in devices.iter().enumerate() {
            if !crate::device_capabilities::DeviceCapability::is_valid(capability.as_str()) {
                panic!(
                    "command_devices('{name}'): unknown device capability '{}' — must be one of \
                     DeviceCapability::ALL",
                    capability.as_str()
                );
            }
            if devices[..index]
                .iter()
                .any(|prev| prev.as_str() == capability.as_str())
            {
                panic!(
                    "command_devices('{name}'): duplicate device capability '{}'",
                    capability.as_str()
                );
            }
        }
        command.device_requirements = devices.to_vec();
        self
    }

    /// `#[command(device(...))]` 메타데이터 연결 — `None`(선언 없는 명령)이면
    /// no-op, `Some`이면 [`command_devices`](Self::command_devices)와 동일하게
    /// 기록한다. register!/build! 체인이 항상 호출한다(platform_meta_if/
    /// errors_meta_if 관례).
    pub fn devices_meta_if(
        self,
        name: &str,
        devices: Option<&'static [crate::device_capabilities::DeviceCapability]>,
    ) -> Self {
        let Some(devices) = devices else {
            return self;
        };
        self.command_devices(name, devices)
    }
}

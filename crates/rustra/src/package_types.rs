/// 등록된 명령 집합을 나타내는 불변 패키지입니다.
///
/// [`PackageBuilder`]로 명령을 등록한 후 [`PackageBuilder::build`]로 생성합니다.
/// 내부적으로 `Arc` 기반이므로 저비용으로 복제할 수 있습니다.
///
/// # 수명 주기
///
/// ```text
/// Package::builder("my.pkg") → .command_fn(f1) → .command_fn(f2) → .build() → Package
/// ```
#[derive(Clone)]
pub struct Package {
    pub(crate) id: String,
    /// 명령 레지스트리. 포이즈닝 관용: writer 가 임계구역 안에서 패닉하면
    /// RwLock 이 포이즈닝되지만 내부 BTreeMap 은 구조적으로 유효하다.
    /// `.unwrap()` 이면 이후 모든 invoke 가 패닉하고, FFI 진입점(extern "C")
    /// 경계에서는 프로세스 abort 다 — ffi.rs 이벤트 싱크와 같은
    /// `into_inner()` 관용으로 과거 패닉 이후에도 invoke 가 동작하게 한다.
    pub(crate) state: Arc<RwLock<RegistryState>>,
    pub(crate) frozen: Arc<AtomicBool>,
    /// freeze된 제품 경로의 lock-free 명령 스냅샷. snapshot을 먼저 채운 뒤
    /// `frozen=true`를 Release publish하므로 invoke가 부분 상태를 볼 수 없다.
    pub(crate) frozen_registry: Arc<OnceLock<FrozenRegistry>>,
    /// Rust → JS 이벤트 푸시 상태(버스 + 싱크). `emit()` 으로 발행, 싱크가
    /// 설치되어 있으면 즉시 콜백 호출(버스 우회), 아니면 호스트 어댑터가
    /// `event_bus()` 를 폴링해 플랫폼 푸시 채널로 전달한다.
    pub(crate) events: Arc<events::EventState>,
    /// (이벤트 계약) 선언된 이벤트 이름 → 페이로드 스키마 — schema.json 의
    /// `events` 섹션 소스. build 시점에 빌더에서 복사되어 불변이 된다.
    pub(crate) event_contracts: BTreeMap<String, Value>,
    pub(crate) states: Arc<state::StateMap>,
}

/// `Package`의 가변 내부 상태. `Arc<RwLock<_>>`로 보호되어 런타임 mutation을 지원한다.
pub(crate) struct RegistryState {
    pub(crate) commands: BTreeMap<String, Arc<Command>>,
    pub(crate) id_to_name: BTreeMap<u16, String>,
    pub(crate) next_command_id: u16,
    /// (성능) command_id → 핸들러 직접 캐시 — `invoke_rkyv_v2` 의 핫패스가
    /// `id_to_name` → `commands` 이중 조회 + Arc 클론을 거치지 않게 한다.
    /// 등록/교체/해제 시점에 함께 유지된다(불변식: 값은 항상 `commands` 의
    /// 동일 명령과 같은 Arc 를 가리킨다).
    pub(crate) id_to_command: BTreeMap<u16, Arc<Command>>,
    /// Runtime Authority: 부여된 capability 집합. deny-by-default —
    /// `required_capability` 가 `Some` 인 명령은 이 집합에 포함될 때만 실행된다.
    pub(crate) granted_capabilities: BTreeSet<String>,
    /// (T2, OTA) 스키마 협상 버전. `schema()`/`live_schema()` 와 코드젠이
    /// 노출한다 — JS > native 인 stale 조합을 감지하는 데 쓰인다.
    pub(crate) schema_version: u32,
    /// 명령 구조가 바뀌지 않은 동안 재사용하는 라이브 스키마 스냅샷.
    /// `live_schema()`의 반환값은 소유 `Value`라 clone은 필요하지만, 매 조회마다
    /// JSON 객체와 정의 트리를 다시 조립하는 비용은 피한다. 구조 mutation은
    /// write lock 안에서 반드시 이 값을 무효화한다.
    pub(crate) live_schema_cache: Option<Value>,
    /// (T0) 스키마 세대 카운터 — register/replace/unregister 가 진행할 때마다
    /// 증가한다. 호스트(JS) 쪽 동적 명령 캐시가 이 값을 비교해 치환 후
    /// 재동기화할 시점을 알린다(증가 방향 보존만 계약 — 실패한 mutation 은
    /// 되감지 않는다). `live_schema_cache` 무효화 지점과 함께 증가한다.
    pub(crate) schema_generation: u64,
}

pub(crate) struct FrozenRegistry {
    pub(crate) commands: BTreeMap<String, Arc<Command>>,
    pub(crate) id_to_command: Vec<Option<Arc<Command>>>,
}

impl FrozenRegistry {
    pub(crate) fn from_state(state: &RegistryState) -> Self {
        let max_id = state.id_to_command.keys().next_back().copied().unwrap_or(0) as usize;
        let mut id_to_command = vec![None; max_id + 1];
        for (&id, command) in &state.id_to_command {
            id_to_command[id as usize] = Some(Arc::clone(command));
        }
        Self {
            commands: state.commands.clone(),
            id_to_command,
        }
    }
}

impl std::fmt::Debug for Package {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let state = self
            .state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        f.debug_struct("Package")
            .field("id", &self.id)
            .field("frozen", &self.frozen.load(Ordering::Relaxed))
            .field("command_count", &state.commands.len())
            .finish()
    }
}

pub struct PackageBuilder {
    pub(crate) id: String,
    pub(crate) commands: BTreeMap<String, Command>,
    pub(crate) next_command_id: u16,
    /// (T2, OTA) `alias_command_id` 로 선언된 (명령, 구 command_id) 목록.
    /// 선언 시점에 즉시 검증 가능한 충돌은 그 자리에서 패닉시키고,
    /// 나머지는 `build()` 시점에 검증·병합한다.
    pub(crate) id_aliases: Vec<(String, u16)>,
    pub(crate) event_capacity: usize,
    /// (이벤트 계약) 선언된 이벤트 이름 → 페이로드 스키마. schema.json 의
    /// `events` 섹션과 TS 코드젠의 이벤트 타입으로 노출된다.
    pub(crate) events: BTreeMap<String, Value>,
    /// (T2, OTA) 스키마 협상 버전 — 빌드 시점 고정값. `build()` 에서
    /// `RegistryState.schema_version` 로 이동한다.
    pub(crate) schema_version: u32,
    pub(crate) states: state::StateMap,
}

/// TypeScript 코드 생성 결과입니다.
///
/// [`Package::generate_typescript`] 호출로 생성됩니다.
///
/// | 필드 | 출력 파일 | 내용 |
/// |------|----------|------|
/// | `schema_json` | `schema.json` | 전체 명령 스키마 (JSON) |
/// | `types_ts` | `types.ts` | TypeScript 타입 정의 |
/// | `commands_ts` | `commands.ts` | TypeScript 명령 헬퍼 함수 |
/// | `contract_ts` | `contract.ts` | 계약 해시 + 스키마 버전 (무결성/stale 검증용) |
///
/// `warnings` 는 파일로 출력되지 않는다 — 매핑 불가 스키마가 조용히 `"unknown"`
/// 폴백으로 떨어질 때의 진단 정보이며, 호출자(CLI 등)가 stderr 로 노출한다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneratedPackage {
    /// JSON으로 직렬화된 전체 패키지 스키마입니다.
    pub schema_json: String,
    /// 생성된 TypeScript 타입 정의 코드입니다.
    pub types_ts: String,
    /// 생성된 TypeScript 명령 헬퍼 함수 코드입니다.
    pub commands_ts: String,
    /// 스키마의 SHA-256 해시입니다.
    pub contract_hash: String,
    /// `contract.ts` 전체 내용 — `GENERATED_CONTRACT_HASH` 와 (T2, OTA)
    /// `SCHEMA_VERSION` 상수를 함께 노출한다. JS 클라이언트가 이 값을
    /// 네이티브의 `schemaVersion` 과 비교해 JS > native stale 를 감지한다.
    pub contract_ts: String,
    /// 코드접 경고 — 매핑 불가 스키마가 `"unknown"` 폴백한 위치(명령명 + 타입
    /// 컨텍스트). 정상 스키마는 비어 있다.
    pub warnings: Vec<String>,
}

impl GeneratedPackage {
    /// 계약 프로브 출력 — `schema.json` 만 디스크에 씁니다.
    ///
    /// 단일 화살 코드젠에서 Rust bin 의 역할은 스키마 발행까지다. TS/C++ 표면은
    /// `rustra codegen` 이 schema.json 에서 렌더링한다 — 같은 파일을 두 렌더러가
    /// 생산해 한쪽이 stale 이 되는 듀얼 패스 함정을 구조적으로 제거한다.
    ///
    /// `RUSTRA_SCHEMA_OUT` 환경 변수를 [`GeneratedPackage::write_to_dir`] 과
    /// 동일하게 존중한다 — CLI의 `codegen --check` 가 임시 디렉토리에서
    /// Rust 산출물을 검증할 때 사용하는 우회 경로다.
    pub fn write_schema_to_dir(&self, output_dir: impl AsRef<Path>) -> crate::Result<()> {
        let requested_dir = output_dir.as_ref();
        let output_dir = std::env::var_os("RUSTRA_SCHEMA_OUT")
            .map(PathBuf::from)
            .unwrap_or_else(|| requested_dir.to_path_buf());
        fs::create_dir_all(&output_dir)?;
        write_if_changed(output_dir.join("schema.json"), &self.schema_json)?;
        Ok(())
    }

    /// 생성된 모든 파일을 지정한 디렉토리에 저장합니다.
    ///
    /// Deprecated (단일 화살 코드젠 전환): TS 표면(`types.ts`/`commands.ts`/
    /// `contract.ts`)은 `rustra codegen` 이 schema.json 에서 렌더링하는 것이
    /// 단일 진실이다. 이 메서드는 Node 없는 환경의 참고용 출력으로 버전 정책상
    /// 최소 1 minor 유지 후 제거를 검토한다. 신규 코드는
    /// [`GeneratedPackage::write_schema_to_dir`] 을 사용한다.
    ///
    /// `RUSTRA_SCHEMA_OUT` 환경 변수가 있으면 해당 디렉토리를 사용합니다.
    /// CLI의 `codegen --check`가 작업 트리를 건드리지 않고 Rust 산출물을
    /// 임시 디렉토리에서 검증할 때 사용하는 우회 경로입니다.
    ///
    /// 디렉토리가 없으면 생성합니다:
    /// - `schema.json` — 전체 명령 스키마
    /// - `types.ts` — TypeScript 타입 정의
    /// - `commands.ts` — TypeScript 명령 헬퍼 함수
    /// - `contract.ts` — `GENERATED_CONTRACT_HASH`/`SCHEMA_VERSION` 상수
    pub fn write_to_dir(&self, output_dir: impl AsRef<Path>) -> crate::Result<()> {
        let requested_dir = output_dir.as_ref();
        let output_dir = std::env::var_os("RUSTRA_SCHEMA_OUT")
            .map(PathBuf::from)
            .unwrap_or_else(|| requested_dir.to_path_buf());
        fs::create_dir_all(&output_dir)?;
        write_if_changed(output_dir.join("schema.json"), &self.schema_json)?;
        write_if_changed(output_dir.join("types.ts"), &self.types_ts)?;
        write_if_changed(output_dir.join("commands.ts"), &self.commands_ts)?;
        write_if_changed(output_dir.join("contract.ts"), &self.contract_ts)?;
        Ok(())
    }
}

fn write_if_changed(path: impl AsRef<Path>, content: &str) -> std::io::Result<()> {
    let path = path.as_ref();
    if let Ok(existing) = fs::read(path)
        && existing == content.as_bytes()
    {
        return Ok(());
    }
    fs::write(path, content)
}

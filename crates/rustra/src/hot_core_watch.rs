// ── dylib 아티팩트 감시 (experimental, hot-core feature) ─────────────────────
//
// sha256 폴링으로 아티팩트 재빌드를 감시하고 버전 카피 → open → swap 을
// 조율하는 층. notify 같은 파일 감시 의존을 두지 않는다 — dev 루프 요구는
// 폴링 간격(기본 300ms)+빌드 시간이면 충분하다(design: 0.5~2초 warm).
// 상위 파사드는 `hot_core.rs`, 결합 층은 `hot_core_dylib.rs`.

use super::dylib::{DylibCore, DylibCoreError, HotCoreHandle, prepare_swap_copy};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

/// 스왑 결과 — 성공은 (구 계약 해시, 신 계약 해시), 실패는 오류.
pub type SwapOutcome = Result<(String, String), DylibCoreError>;

/// 스왑 결과 콜백 타입 — [`DylibWatchConfig::on_swap`] 의 원형.
pub type SwapCallback = Arc<dyn Fn(SwapOutcome) + Send + Sync>;

/// 감시 스레드 설정 — `poll` 기본값은 300ms, `on_swap` 기본값은 no-op.
pub struct DylibWatchConfig {
    /// 감시 대상 cdylib 아티팩트 경로(예: `target/debug/lib*.dylib`).
    pub artifact: PathBuf,
    /// 폴링 간격. 기본 300ms.
    pub poll: Duration,
    /// 스왑을 적용할 핸들 — 호스트가 open 해서 넘긴다.
    pub handle: Arc<HotCoreHandle>,
    /// 스왑 결과 콜백. `Ok((old_hash, new_hash))` 또는 `Err`.
    pub on_swap: SwapCallback,
}

impl DylibWatchConfig {
    /// 기본값(300ms 폴링, no-op 콜백)으로 설정을 만든다.
    pub fn new(artifact: impl Into<PathBuf>, handle: Arc<HotCoreHandle>) -> Self {
        Self {
            artifact: artifact.into(),
            poll: Duration::from_millis(300),
            handle,
            on_swap: Arc::new(|_| {}),
        }
    }
}

/// 아티팩트 폴링을 시작한다. std 스레드 + sleep 폴링이며 notify 같은
/// 파일 감시 의존을 두지 않는다. 반환 스레드는 프로세스 종료까지 감시한다.
pub fn spawn_dylib_watch(config: DylibWatchConfig) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("rustra-hot-core-watch".into())
        .spawn(move || run_watch_loop(config))
        .expect("rustra hot-core: failed to spawn watch thread")
}

/// 변경 감지는 sha256(파일 바이트) 기준이다. 실패한 스왑은 last_hash 를
/// 갱신하지 않으므로(같은 바이트 상태를 다음 폴링에서 재시도 — 빌드 중
/// 반쯤 쓰인 아티팩트가 스레드를 죽이지 않는다) 성공한 바이트 상태만
/// 기준선이 된다.
fn run_watch_loop(config: DylibWatchConfig) {
    let mut counter: u64 = 0;
    let mut last_hash = file_sha256_hex(&config.artifact).ok();
    loop {
        std::thread::sleep(config.poll);
        let hash = match file_sha256_hex(&config.artifact) {
            Ok(hash) => hash,
            // 아직 빌드 전이거나 잠깐 사라진 상태 — 다음 폴링에서 재시도.
            Err(_) => continue,
        };
        if last_hash.as_deref() == Some(hash.as_str()) {
            continue;
        }
        counter += 1;
        match attempt_swap(&config, counter) {
            Ok((old, new)) => {
                last_hash = Some(hash);
                (config.on_swap)(Ok((old, new)));
            }
            Err(error) => (config.on_swap)(Err(error)),
        }
    }
}

/// 스왑 1회 시도 — open/swap 을 `catch_unwind` 로 감싸 잘못된 아티팩트의
/// 패닉이 감시 스레드(나아가 호스트 프로세스)를 죽이지 않게 한다. 패닉 격리
/// 관용은 코어 FFI 경계의 `with_panic_guard` 와 같은 것이다.
fn attempt_swap(
    config: &DylibWatchConfig,
    counter: u64,
) -> Result<(String, String), DylibCoreError> {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let copy = prepare_swap_copy(&config.artifact, counter)?;
        let new_core = match DylibCore::open(&copy) {
            Ok(core) => core,
            Err(error) => {
                // 실패한 카피는 재사용 대상이 아니다 — 다음 시도는 새 카운터의
                // 새 경로를 만들므로 조용히 치운다(성공 카피는 로드 중이라 남긴다).
                let _ = std::fs::remove_file(&copy);
                return Err(error);
            }
        };
        let new_hash = new_core.contract_hash()?;
        let old_hash = config.handle.contract_hash()?;
        // swap 이 돌려준 구 코어의 drop 은 dlclose 를 일으키지 않는다
        // (leak 계약) — 의도적 discard 다.
        let _ = config.handle.swap(new_core);
        Ok((old_hash, new_hash))
    }));
    result.unwrap_or_else(|payload| {
        Err(DylibCoreError::Panic {
            message: crate::ffi::panic_message(&*payload),
        })
    })
}

fn file_sha256_hex(path: &Path) -> std::io::Result<String> {
    use sha2::Digest;
    let bytes = std::fs::read(path)?;
    Ok(hex::encode(sha2::Sha256::digest(&bytes)))
}

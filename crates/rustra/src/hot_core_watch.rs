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

/// 같은 아티팩트 바이트(sha256)에 대한 연속 스왑 실패 허용치 — 초과하면 그
/// 바이트 상태를 "포이즌"으로 표시해 바이트가 바뀔 때까지 재시도하지 않는다.
/// 실패 재시도 자체는 폴링 주기(300ms)마다 `prepare_swap_copy`(macOS 에서는
/// codesign spawn)와 `on_swap(Err)` 콜백을 반복하므로, 열리지 않는 아티팩트가
/// 이벤트 폭주·서브프로세스 낭비로 퇴화하지 않게 하는 상한이다. 포이즌은
/// 바이트(해시) 단위로 판정된다 — 새 바이트는 언제나 새 재시도 창을 갖는다.
const MAX_SWAP_FAILURES_PER_BYTES: u32 = 5;

/// 같은 바이트 연속 실패 추적기 — 상한 도달 시 그 바이트를 포이즌으로
/// 표시한다. [`run_watch_loop`] 의 상태 조각을 뽑아낸 순수 구조라 스레드·
/// sleep 없이 재시도 정책만 결정적으로 단위 테스트할 수 있다.
/// private 모듈 안의 `pub` 다 — test cfg 재수출 경로로만 보인다.
#[derive(Default)]
pub struct FailureTracker {
    streak: u32,
    streak_hash: Option<String>,
    poisoned: Option<String>,
}

impl FailureTracker {
    pub(super) fn note_success(&mut self) {
        self.streak = 0;
        self.streak_hash = None;
        self.poisoned = None;
    }

    /// 실패 1회 기록. 상한에 도달해 이 바이트를 새로 포이즌했으면 true.
    pub(super) fn note_failure(&mut self, hash: &str) -> bool {
        if self.streak_hash.as_deref() != Some(hash) {
            // 바이트가 바뀌었으면 이전 실패 streak 은 무관 — 새 바이트의
            // 재시도 창부터 다시 센다(포이즌도 바이트 단위로만 대조된다).
            self.streak = 0;
            self.streak_hash = Some(hash.to_string());
        }
        self.streak += 1;
        if self.streak >= MAX_SWAP_FAILURES_PER_BYTES {
            self.streak = 0;
            self.poisoned = Some(hash.to_string());
            true
        } else {
            false
        }
    }

    pub(super) fn is_poisoned(&self, hash: &str) -> bool {
        self.poisoned.as_deref() == Some(hash)
    }
}

/// 변경 감지는 sha256(파일 바이트) 기준이다. 실패한 스왑은 last_hash 를
/// 갱신하지 않으므로(같은 바이트 상태를 다음 폴링에서 재시도 — 빌드 중
/// 반쯤 쓰인 아티팩트가 스레드를 죽이지 않는다) 성공한 바이트 상태만
/// 기준선이 된다. 단 같은 바이트의 연속 실패가 [`MAX_SWAP_FAILURES_PER_BYTES`]
/// 에 도달하면 그 바이트를 포이즌으로 표시하고 바이트가 바뀔 때까지 재시도를
/// 멈춘다(실패 폭주 방지).
fn run_watch_loop(config: DylibWatchConfig) {
    let mut counter: u64 = 0;
    let mut last_hash = file_sha256_hex(&config.artifact).ok();
    let mut failures = FailureTracker::default();
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
        if failures.is_poisoned(&hash) {
            // 포이즌된 바이트 — 새 바이트가 발행될 때까지 조용히 기다린다.
            continue;
        }
        counter += 1;
        match attempt_swap(&config, counter) {
            Ok((old, new)) => {
                last_hash = Some(hash);
                failures.note_success();
                (config.on_swap)(Ok((old, new)));
            }
            Err(error) => {
                (config.on_swap)(Err(error));
                if failures.note_failure(&hash) {
                    eprintln!(
                        "rustra hot-core: giving up on artifact bytes {} after \
                         {MAX_SWAP_FAILURES_PER_BYTES} failed swaps — retrying when new \
                         bytes are published",
                        &hash[..8.min(hash.len())]
                    );
                }
            }
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
